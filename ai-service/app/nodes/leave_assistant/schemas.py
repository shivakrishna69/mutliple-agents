"""
Contract of POST /ai/leave/assistant (called by the backend's controllers/leaveAssistantController.js).

  request   LeaveAssistantInput: the employee the backend chose (never the browser), their today and
            time zone, the recent conversation (oldest first) and the new question.
  response  LeaveAssistantResponse: the reply, an optional draft, and the tools used.

As in app/schemas.py, unknown fields are rejected, every string is bounded, and there is no
"system" role: the conversation comes from the browser and must never reach the model with
system-level authority. Limits mirror backend/constants/validation.js LEAVE_LIMITS.
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ASSISTANT_MESSAGE_MAX_LENGTH = 1_000
ASSISTANT_HISTORY_MAX_MESSAGES = 12
ASSISTANT_HISTORY_MESSAGE_MAX_LENGTH = 4_000
REPLY_MAX_LENGTH = 20_000
NOTE_MAX_LENGTH = 500

ObjectIdString = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{24}$")]


class HistoryRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class DayPortion(str, Enum):
    """The half-day edges of a leave (backend constants/calendarDays.js DAY_PORTIONS)."""

    FULL = "full"
    FIRST_HALF = "first_half"
    SECOND_HALF = "second_half"


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: HistoryRole
    content: str = Field(min_length=1, max_length=ASSISTANT_HISTORY_MESSAGE_MAX_LENGTH)


class LeaveAssistantInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: ObjectIdString
    employee_name: str = Field(min_length=1, max_length=120)
    today: date
    time_zone: str = Field(min_length=1, max_length=64)
    history: list[HistoryMessage] = Field(default_factory=list, max_length=ASSISTANT_HISTORY_MAX_MESSAGES)
    message: str = Field(min_length=1, max_length=ASSISTANT_MESSAGE_MAX_LENGTH)


class LeaveDraft(BaseModel):
    """A leave request ready for the employee to review and send; the assistant never sends it."""

    model_config = ConfigDict(extra="forbid")

    leave_type_id: ObjectIdString
    start_date: date
    start_day_portion: DayPortion = DayPortion.FULL
    end_date: date
    end_day_portion: DayPortion = DayPortion.FULL
    reason: str | None = Field(default=None, max_length=NOTE_MAX_LENGTH)


class LeaveAssistantResponse(BaseModel):
    reply: str = Field(min_length=1, max_length=REPLY_MAX_LENGTH)
    draft: LeaveDraft | None = None
    tools_used: list[str] = Field(default_factory=list)
