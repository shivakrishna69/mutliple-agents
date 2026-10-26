"""Limits, data models and graph state of the attendance regularization sub-agent."""

from __future__ import annotations

import logging
import operator
import re
from datetime import date, datetime
from datetime import time as clock_time
from enum import Enum
from typing import Annotated, Any, Literal, TypedDict
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas import EmployeeContext, IdentifierString

logger = logging.getLogger("ai_service.attendance_agent")


AGENT_NAME = "attendance_regularization_agent"

# ---- Policy constants ---------------------------------------------------------------------------
# How far back an employee may self-regularize; older days need a manager.
MAX_REGULARIZATION_AGE_DAYS = 7
# Questions the agent may ask before handing the request to the manager.
MAX_CLARIFICATION_TURNS = 2
# Qualifying activity events needed to prove the employee was working (section 3).
MIN_QUALIFYING_EVENTS = 2

# ---- Model call bounds --------------------------------------------------------------------------
EXTRACTION_TEMPERATURE = 0.0
# Generous because reasoning models spend part of the budget thinking before the JSON.
EXTRACTION_MAX_OUTPUT_TOKENS = 1024
# One repair round after an invalid reply (section 4).
EXTRACTION_REPAIR_ATTEMPTS = 1
# Conversation messages sent to the model: the request plus a few clarification exchanges.
EXTRACTION_CONTEXT_MESSAGES = 8
REASON_MAX_LENGTH = 300
MAX_ACTIVITY_ENTRIES = 500

TWELVE_HOUR_TIME_PATTERN = re.compile(
    r"^(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*(?P<meridiem>[ap])\.?\s*m\.?$", re.IGNORECASE
)
TWENTY_FOUR_HOUR_TIME_PATTERN = re.compile(r"^(?P<hour>\d{1,2}):(?P<minute>\d{2})(?::\d{2})?$")
ISO_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NULL_LIKE_STRINGS = frozenset({"", "null", "none", "unknown", "n/a", "na", "not specified", "not provided"})


# =================================================================================================
# Schemas
# =================================================================================================


def resolve_time_zone(time_zone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(time_zone_name)
    except (ZoneInfoNotFoundError, ValueError) as zone_error:
        raise ValueError(f"unknown IANA time zone {time_zone_name!r}") from zone_error


class EmployeeProfileSnapshot(BaseModel):
    """
    The requesting employee, supplied by the trusted caller: the backend loads it from MongoDB
    (EmployeeProfile, its OfficeLocation, and User) for the authenticated session and sends it as
    EmployeeContext. Never derived from the conversation.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    employee_id: IdentifierString
    display_name: str = Field(min_length=1, max_length=100)
    time_zone: str = Field(min_length=1, max_length=64)
    shift_start: clock_time
    shift_end: clock_time
    reporting_manager_id: IdentifierString | None = None
    # Carried into manager reviews so the reviewer sees the employee's punch-in policy; regularization
    # itself is not location-based, so it plays no part in the agent's decisions.
    allowed_geofence_radius: int | None = None

    @classmethod
    def from_employee_context(cls, employee_context: EmployeeContext) -> EmployeeProfileSnapshot:
        """Maps the backend's EmployeeContext (MongoDB EmployeeProfile + OfficeLocation) to the agent's profile."""
        return cls(
            employee_id=employee_context.employee_id,
            display_name=employee_context.display_name,
            time_zone=employee_context.time_zone,
            shift_start=employee_context.shift_start_time,
            shift_end=employee_context.shift_end_time,
            reporting_manager_id=employee_context.manager_id,
            allowed_geofence_radius=employee_context.allowed_geofence_radius,
        )

    @field_validator("time_zone")
    @classmethod
    def validate_time_zone(cls, time_zone_name: str) -> str:
        resolve_time_zone(time_zone_name)
        return time_zone_name

    @model_validator(mode="after")
    def validate_shift(self) -> EmployeeProfileSnapshot:
        if self.shift_end <= self.shift_start:
            raise ValueError("shift_end must be later than shift_start (overnight shifts are not supported)")
        return self

    @property
    def zone(self) -> ZoneInfo:
        return resolve_time_zone(self.time_zone)


def _normalize_optional_text(raw_value: Any) -> Any:
    """Treats "", "null", "unknown" and similar as missing; collapses whitespace otherwise."""
    if raw_value is None:
        return None
    if isinstance(raw_value, str):
        collapsed_value = " ".join(raw_value.split())
        return None if collapsed_value.lower() in NULL_LIKE_STRINGS else collapsed_value
    return raw_value


class RelativeDay(str, Enum):
    """A day named relative to today. The model copies the expression; code computes the date."""

    TODAY = "today"
    YESTERDAY = "yesterday"
    DAY_BEFORE_YESTERDAY = "day_before_yesterday"
    MONDAY = "monday"
    TUESDAY = "tuesday"
    WEDNESDAY = "wednesday"
    THURSDAY = "thursday"
    FRIDAY = "friday"
    SATURDAY = "saturday"
    SUNDAY = "sunday"


DAYS_BACK_BY_RELATIVE_DAY = {RelativeDay.TODAY: 0, RelativeDay.YESTERDAY: 1, RelativeDay.DAY_BEFORE_YESTERDAY: 2}
WEEKDAY_INDEX_BY_RELATIVE_DAY = {
    weekday_member: weekday_index
    for weekday_index, weekday_member in enumerate(
        [
            RelativeDay.MONDAY,
            RelativeDay.TUESDAY,
            RelativeDay.WEDNESDAY,
            RelativeDay.THURSDAY,
            RelativeDay.FRIDAY,
            RelativeDay.SATURDAY,
            RelativeDay.SUNDAY,
        ]
    )
}


class RegularizationRequestExtraction(BaseModel):
    """
    What the extraction model must return, as a JSON object. Formatting drift is normalised; a
    value that is still not exactly the right type fails validation (and triggers the repair round).
    """

    model_config = ConfigDict(extra="ignore")

    is_regularization_request: bool
    relative_day: RelativeDay | None = None
    target_date: date | None = None
    claimed_punch_in_time: clock_time | None = None
    reason: str | None = Field(default=None, max_length=REASON_MAX_LENGTH)

    @field_validator("relative_day", mode="before")
    @classmethod
    def normalize_relative_day(cls, raw_relative_day: Any) -> Any:
        """ "Last Thursday" / "this-thursday" / "Day before yesterday" -> "thursday" / "day_before_yesterday"."""
        normalized_day = _normalize_optional_text(raw_relative_day)
        if not isinstance(normalized_day, str):
            return normalized_day
        normalized_day = re.sub(r"[\s\-]+", "_", normalized_day.lower())
        return re.sub(r"^(?:last|this|previous|past)_", "", normalized_day)

    @field_validator("target_date", mode="before")
    @classmethod
    def normalize_target_date(cls, raw_date: Any) -> Any:
        """Accepts only an ISO calendar date ("2026-10-02"); prose dates must fail, not be guessed."""
        normalized_date = _normalize_optional_text(raw_date)
        if isinstance(normalized_date, str) and not ISO_DATE_PATTERN.match(normalized_date):
            raise ValueError("target_date must be YYYY-MM-DD or null")
        return normalized_date

    @field_validator("claimed_punch_in_time", mode="before")
    @classmethod
    def normalize_claimed_time(cls, raw_time: Any) -> Any:
        """Accepts "09:30", "9:30", "09:30:00", "9:30 AM", "9 pm"; returns "HH:MM" for Pydantic to parse."""
        normalized_time = _normalize_optional_text(raw_time)
        if not isinstance(normalized_time, str):
            return normalized_time
        twelve_hour_match = TWELVE_HOUR_TIME_PATTERN.match(normalized_time)
        if twelve_hour_match:
            hour = int(twelve_hour_match.group("hour"))
            minute = int(twelve_hour_match.group("minute") or 0)
            if not 1 <= hour <= 12:
                raise ValueError("12-hour times must have an hour from 1 to 12")
            hour = hour % 12 + (12 if twelve_hour_match.group("meridiem").lower() == "p" else 0)
            return f"{hour:02d}:{minute:02d}"
        twenty_four_hour_match = TWENTY_FOUR_HOUR_TIME_PATTERN.match(normalized_time)
        if twenty_four_hour_match:
            return f"{int(twenty_four_hour_match.group('hour')):02d}:{twenty_four_hour_match.group('minute')}"
        raise ValueError("claimed_punch_in_time must be HH:MM (24-hour) or null")

    @field_validator("reason", mode="before")
    @classmethod
    def normalize_reason(cls, raw_reason: Any) -> Any:
        normalized_reason = _normalize_optional_text(raw_reason)
        return normalized_reason[:REASON_MAX_LENGTH] if isinstance(normalized_reason, str) else normalized_reason


class ActivityKind(str, Enum):
    MEETING_ATTENDED = "meeting_attended"
    MEETING_INVITED = "meeting_invited"
    MESSAGE_SENT = "message_sent"
    MESSAGE_RECEIVED = "message_received"


# Only actions the employee performed prove they were working (section 3).
QUALIFYING_ACTIVITY_KINDS = frozenset({ActivityKind.MEETING_ATTENDED, ActivityKind.MESSAGE_SENT})


class ActivityLogEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source: Literal["calendar", "chat", "email"]
    kind: ActivityKind
    occurred_at: datetime
    summary: str = Field(min_length=1, max_length=200)

    @field_validator("occurred_at")
    @classmethod
    def require_time_zone(cls, occurred_at: datetime) -> datetime:
        if occurred_at.tzinfo is None or occurred_at.utcoffset() is None:
            raise ValueError("occurred_at must include a UTC offset")
        return occurred_at


class ActivityLogReport(BaseModel):
    """Result of fetch_calendar_and_comms_logs."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    employee_id: IdentifierString
    target_date: date
    entries: list[ActivityLogEntry] = Field(max_length=MAX_ACTIVITY_ENTRIES)
    data_source: Literal["simulated", "live"]


class EvidenceEvaluation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    is_activity_proven: bool
    qualifying_event_count: int = Field(ge=0)
    first_qualifying_activity_at: datetime | None
    working_window_start: datetime
    working_window_end: datetime
    rule: str


class ApprovalRecord(BaseModel):
    """Result of approve_regularization_entry: the Attendance entry as stored by the backend."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    attendance_id: str = Field(min_length=1, max_length=100)
    employee_id: IdentifierString
    target_date: date
    punch_in_time: datetime
    calculation_status: Literal["Normal", "Late", "Half_Day", "Absent"]
    # False when an entry for that day already existed (a device punch or an earlier regularization).
    newly_created: bool


class ManagerRoutingReason(str, Enum):
    NO_ACTIVITY_PROOF = "no_activity_proof"
    OUTSIDE_REGULARIZATION_WINDOW = "outside_regularization_window"
    CLARIFICATION_LIMIT_REACHED = "clarification_limit_reached"
    REQUEST_NOT_UNDERSTOOD = "request_not_understood"
    ACTIVITY_SYSTEMS_UNAVAILABLE = "activity_systems_unavailable"
    APPROVAL_REJECTED = "approval_rejected"
    APPROVAL_SYSTEM_UNAVAILABLE = "approval_system_unavailable"


class ManagerReviewRequest(BaseModel):
    """What the reporting manager receives when the agent cannot decide on its own."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    employee_id: IdentifierString
    reporting_manager_id: IdentifierString | None
    target_date: date | None
    claimed_punch_in_time: clock_time | None
    employee_reason: str | None
    routing_reason: ManagerRoutingReason
    qualifying_event_count: int = Field(ge=0)
    allowed_geofence_radius: int | None


class RegularizationOutcome(str, Enum):
    APPROVED = "approved"
    AWAITING_EMPLOYEE_INPUT = "awaiting_employee_input"
    ROUTED_TO_MANAGER = "routed_to_manager"
    OUT_OF_SCOPE = "out_of_scope"


# =================================================================================================
# State
# =================================================================================================


class RegularizationState(TypedDict, total=False):
    """
    Graph state. Structured values are stored as JSON-compatible dicts (model_dump(mode="json")) so
    the checkpointer can persist them; nodes re-validate them with the Pydantic models on read.

      messages                 conversation context (employee messages and the agent's questions/replies)
      thread_id                this conversation's id; sent with backend writes for traceability and
                               used to make manager-review submission idempotent
      employee_profile         EmployeeProfileSnapshot, from the trusted caller
      today                    the employee's local date when the request started (fixed for the run)
      request                  RegularizationRequestExtraction, the latest successful extraction
      extraction_failed        the model could not produce a valid extraction this round
      clarification_turns      questions asked so far
      calendar_logs            ActivityLogReport from fetch_calendar_and_comms_logs
      evaluation               EvidenceEvaluation
      approval                 ApprovalRecord
      approval_failure         "rejected" (backend refused) or "unavailable" when approval failed
      manager_review           ManagerReviewRequest
      manager_review_id        the stored review's id, or None if it could not be submitted
      outcome / reply          final result for the caller and the text for the employee
      internal_logs            append-only audit trail, "<node>: <event>"
    """

    messages: Annotated[list[AnyMessage], add_messages]
    thread_id: str
    employee_profile: dict[str, Any]
    today: str
    request: dict[str, Any] | None
    extraction_failed: bool
    clarification_turns: int
    calendar_logs: dict[str, Any] | None
    evaluation: dict[str, Any] | None
    approval: dict[str, Any] | None
    approval_failure: str | None
    manager_review: dict[str, Any] | None
    manager_review_id: str | None
    outcome: str | None
    reply: str | None
    internal_logs: Annotated[list[str], operator.add]
