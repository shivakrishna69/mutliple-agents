"""The deterministic evidence rule (package docstring, section 3). No LLM involved."""

from __future__ import annotations

import logging
from datetime import date, datetime

from app.nodes.attendance_agent.schemas import (
    MIN_QUALIFYING_EVENTS,
    QUALIFYING_ACTIVITY_KINDS,
    ActivityLogReport,
    EmployeeProfileSnapshot,
    EvidenceEvaluation,
)

logger = logging.getLogger("ai_service.attendance_agent")


# =================================================================================================
# Deterministic rules
# =================================================================================================


def evaluate_activity_evidence(
    report: ActivityLogReport, profile: EmployeeProfileSnapshot, target_date: date
) -> EvidenceEvaluation:
    """Section 3's rule. Pure function: same inputs, same decision."""
    employee_zone = profile.zone
    window_start = datetime.combine(target_date, profile.shift_start, tzinfo=employee_zone)
    window_end = datetime.combine(target_date, profile.shift_end, tzinfo=employee_zone)
    qualifying_moments = sorted(
        log_entry.occurred_at
        for log_entry in report.entries
        if log_entry.kind in QUALIFYING_ACTIVITY_KINDS and window_start <= log_entry.occurred_at < window_end
    )
    return EvidenceEvaluation(
        is_activity_proven=len(qualifying_moments) >= MIN_QUALIFYING_EVENTS,
        qualifying_event_count=len(qualifying_moments),
        first_qualifying_activity_at=qualifying_moments[0] if qualifying_moments else None,
        working_window_start=window_start,
        working_window_end=window_end,
        rule=f">= {MIN_QUALIFYING_EVENTS} attended meetings or sent messages between {profile.shift_start:%H:%M} and {profile.shift_end:%H:%M} {profile.time_zone}",
    )
