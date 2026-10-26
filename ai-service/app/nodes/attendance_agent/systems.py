"""External systems the sub-agent uses (activity evidence, attendance writes, manager reviews) and its run-scoped context."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import time as clock_time
from typing import Protocol

from langchain_core.language_models.chat_models import BaseChatModel

from app.nodes.attendance_agent.schemas import (
    ActivityKind,
    ActivityLogEntry,
    ActivityLogReport,
    ApprovalRecord,
    ManagerReviewRequest,
    resolve_time_zone,
)
from app.services.backend_client import BackendInternalClient, BackendRejectedError

logger = logging.getLogger("ai_service.attendance_agent")


# =================================================================================================
# External systems (tools)
# =================================================================================================


class ActivitySystemUnavailableError(Exception):
    """No activity evidence source is configured, or it could not be reached."""


class ApprovalRejectedError(Exception):
    """The attendance system refused the entry under its own rules (e.g. outside the shift window)."""


class ActivityEvidenceSource(Protocol):
    """Where proof of work comes from (calendar and communications history)."""

    async def fetch_calendar_and_comms_logs(
        self, employee_id: str, target_date: date, time_zone: str
    ) -> ActivityLogReport: ...


class RegularizationSystems(Protocol):
    """The external operations the agent performs. Implementations must be safe to retry."""

    async def fetch_calendar_and_comms_logs(
        self, employee_id: str, target_date: date, time_zone: str
    ) -> ActivityLogReport: ...

    async def approve_regularization_entry(
        self,
        employee_id: str,
        target_date: date,
        punch_time: datetime,
        *,
        evidence_event_count: int,
        reason: str | None,
        thread_id: str,
    ) -> ApprovalRecord: ...

    async def submit_manager_review(self, review: ManagerReviewRequest, *, idempotency_key: str) -> str: ...


class SimulatedActivityEvidenceSource:
    """
    Deterministic stand-in for a calendar/communications history service, for development only
    (enabled by SIMULATED_TOOLS_ENABLED, which config.py forbids in production).

    The same (employee_id, date) always yields the same entries. Weekends have no activity. About one
    weekday in four has no activity at all (so the "no proof" path is exercised); otherwise 2 to 6
    entries are spread over 09:00-18:00 in the employee's time zone, mixing qualifying events
    (meetings attended, messages sent) with non-qualifying ones (invitations, received messages).
    """

    async def fetch_calendar_and_comms_logs(
        self, employee_id: str, target_date: date, time_zone: str
    ) -> ActivityLogReport:
        employee_zone = resolve_time_zone(time_zone)
        seed_bytes = hashlib.sha256(f"{employee_id}|{target_date.isoformat()}".encode()).digest()
        has_no_activity = target_date.weekday() >= 5 or seed_bytes[0] % 4 == 0
        entries: list[ActivityLogEntry] = []
        if not has_no_activity:
            entry_templates = [
                ("calendar", ActivityKind.MEETING_ATTENDED, "Daily stand-up"),
                ("chat", ActivityKind.MESSAGE_SENT, "Message in #team channel"),
                ("calendar", ActivityKind.MEETING_INVITED, "Optional design review"),
                ("email", ActivityKind.MESSAGE_SENT, "Reply to project thread"),
                ("chat", ActivityKind.MESSAGE_RECEIVED, "Direct message from a colleague"),
                ("calendar", ActivityKind.MEETING_ATTENDED, "Sprint planning"),
            ]
            entry_count = 2 + seed_bytes[1] % 5
            for entry_index in range(entry_count):
                source, kind, summary = entry_templates[(seed_bytes[2] + entry_index) % len(entry_templates)]
                minutes_after_nine = (seed_bytes[3 + entry_index] * 7 + entry_index * 61) % (9 * 60)
                local_moment = datetime.combine(target_date, clock_time(9, 0), tzinfo=employee_zone) + timedelta(
                    minutes=minutes_after_nine
                )
                entries.append(ActivityLogEntry(source=source, kind=kind, occurred_at=local_moment, summary=summary))
            entries.sort(key=lambda activity_entry: activity_entry.occurred_at)
        return ActivityLogReport(
            employee_id=employee_id, target_date=target_date, entries=entries, data_source="simulated"
        )


REGULARIZATIONS_PATH = "/api/internal/attendance/regularizations"
REGULARIZATION_REVIEWS_PATH = "/api/internal/attendance/regularization-reviews"


class BackendRegularizationSystems:
    """
    Production implementation: approvals and manager reviews are written by the backend into MongoDB
    (Attendance and RegularizationReview), through app/services/backend_client.py. Evidence comes
    from `evidence_source`; without one, fetching raises ActivitySystemUnavailableError and every
    request is routed to the manager instead of being approved on invented data.
    """

    def __init__(self, backend_client: BackendInternalClient, evidence_source: ActivityEvidenceSource | None) -> None:
        self._backend_client = backend_client
        self._evidence_source = evidence_source

    async def fetch_calendar_and_comms_logs(
        self, employee_id: str, target_date: date, time_zone: str
    ) -> ActivityLogReport:
        if self._evidence_source is None:
            raise ActivitySystemUnavailableError("no calendar/communications evidence source is configured")
        return await self._evidence_source.fetch_calendar_and_comms_logs(employee_id, target_date, time_zone)

    async def approve_regularization_entry(
        self,
        employee_id: str,
        target_date: date,
        punch_time: datetime,
        *,
        evidence_event_count: int,
        reason: str | None,
        thread_id: str,
    ) -> ApprovalRecord:
        try:
            response_data = await self._backend_client.post_json(
                REGULARIZATIONS_PATH,
                {
                    "employee_id": employee_id,
                    "date": target_date.isoformat(),
                    "punch_in_time": punch_time.isoformat(),
                    "evidence_event_count": evidence_event_count,
                    "reason": reason,
                    "thread_id": thread_id,
                },
            )
        except BackendRejectedError as rejection:
            raise ApprovalRejectedError(rejection.message) from rejection
        stored_entry = response_data["attendance"]
        return ApprovalRecord(
            attendance_id=stored_entry["id"],
            employee_id=stored_entry["employeeId"],
            target_date=date.fromisoformat(stored_entry["date"]),
            punch_in_time=datetime.fromisoformat(stored_entry["checkInTime"].replace("Z", "+00:00")),
            calculation_status=stored_entry["calculationStatus"],
            newly_created=bool(response_data["newlyCreated"]),
        )

    async def submit_manager_review(self, review: ManagerReviewRequest, *, idempotency_key: str) -> str:
        response_data = await self._backend_client.post_json(
            REGULARIZATION_REVIEWS_PATH,
            {
                "employee_id": review.employee_id,
                "date": review.target_date.isoformat() if review.target_date else None,
                "claimed_punch_in_time": review.claimed_punch_in_time.strftime("%H:%M")
                if review.claimed_punch_in_time
                else None,
                "reason": review.employee_reason,
                "routing_reason": review.routing_reason.value,
                "qualifying_event_count": review.qualifying_event_count,
                "allowed_geofence_radius": review.allowed_geofence_radius,
                "idempotency_key": idempotency_key,
            },
        )
        return str(response_data["review"]["id"])


# =================================================================================================
# Runtime context
# =================================================================================================


@dataclass(frozen=True)
class RegularizationContext:
    """Run-scoped dependencies (never checkpointed)."""

    extraction_model: BaseChatModel
    systems: RegularizationSystems
