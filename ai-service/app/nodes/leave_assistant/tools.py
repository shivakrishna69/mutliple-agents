"""
The leave assistant's tools, built for one turn (build_leave_tools). Each closes over the employee
the backend named, so the model never sees or chooses an employee: it can only read that person's
leave. All are read only; propose_leave_draft records a draft for the employee to review and send
themselves, and nothing else.

  get_my_leave_balances     what the employee has, held and available in the current leave year
  list_leave_types          the types on offer and their rules (half days, notice, back-dating,
                            most days at once, when a document is needed, the sandwich rule)
  list_my_leave_requests    the employee's requests, newest first (optionally by status)
  get_office_calendar       the weekly offs and holidays of the employee's office between two dates
  price_leave               what a leave would cost, with the backend's own pricing and policy
                            checks; a refusal comes back with its code and message
  propose_leave_draft       the leave the employee asked for, ready for them to review and send

Results are compact JSON for the model: only the fields it needs, dates as YYYY-MM-DD with their
weekday, amounts in days.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field

from app.nodes.leave_assistant.schemas import NOTE_MAX_LENGTH, DayPortion, LeaveDraft
from app.nodes.leave_assistant.systems import LeaveRequestRefusedError, LeaveSystems

MAX_CALENDAR_RANGE_DAYS = 92
MAX_REQUESTS_SHOWN = 20
WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


@dataclass
class LeaveTurnState:
    """What one turn knows and produced; tools read and fill it."""

    employee_id: str
    leave_types: list[dict[str, Any]] | None = None
    draft: LeaveDraft | None = None
    tools_used: list[str] = field(default_factory=list)


def _weekday(calendar_date: str) -> str:
    return WEEKDAY_NAMES[date.fromisoformat(calendar_date).weekday()]


def _refusal(refused_error: LeaveRequestRefusedError) -> dict[str, Any]:
    return {"refused": {"code": refused_error.code, "message": refused_error.message}}


async def _leave_types(systems: LeaveSystems, state: LeaveTurnState) -> list[dict[str, Any]]:
    if state.leave_types is None:
        state.leave_types = await systems.leave_types()
    return state.leave_types


def _type_by_code(leave_types: list[dict[str, Any]], code: str) -> dict[str, Any] | None:
    return next((leave_type for leave_type in leave_types if leave_type["code"] == code.strip().upper()), None)


def _unknown_type(leave_types: list[dict[str, Any]], code: str) -> dict[str, Any]:
    known_codes = ", ".join(leave_type["code"] for leave_type in leave_types)
    return {"error": f"There is no leave type with code {code!r}. The codes are: {known_codes}."}


# =================================================================================================
# Argument schemas (what the model sees)
# =================================================================================================


class NoArguments(BaseModel):
    pass


class RequestFilter(BaseModel):
    status: Literal["PENDING", "APPROVED", "REJECTED", "CANCELLED"] | None = Field(
        default=None, description="Only requests with this status; omit for all."
    )


class CalendarRange(BaseModel):
    from_date: date = Field(description="First day, YYYY-MM-DD.")
    to_date: date = Field(description=f"Last day, YYYY-MM-DD; at most {MAX_CALENDAR_RANGE_DAYS} days after from_date.")


class LeaveDates(BaseModel):
    leave_type_code: str = Field(description="The leave type's code, e.g. CL (from list_leave_types).")
    start_date: date = Field(description="First day of leave, YYYY-MM-DD.")
    end_date: date = Field(description="Last day of leave, YYYY-MM-DD (the same as start_date for one day).")
    start_day_portion: Literal["full", "second_half"] = Field(
        default="full", description="'second_half' when the leave starts in the afternoon of the first day."
    )
    end_day_portion: Literal["full", "first_half"] = Field(
        default="full", description="'first_half' when the leave ends at lunch on the last day."
    )


class DraftDetails(LeaveDates):
    reason: str | None = Field(
        default=None, max_length=NOTE_MAX_LENGTH, description="The reason in the employee's words, if they gave one."
    )


# =================================================================================================
# Tools
# =================================================================================================


def build_leave_tools(systems: LeaveSystems, state: LeaveTurnState) -> list[BaseTool]:
    """The tools for one turn, all scoped to state.employee_id."""
    employee_id = state.employee_id

    async def get_my_leave_balances() -> dict[str, Any]:
        balances = await systems.balances(employee_id)
        return {
            "leave_year": balances["leaveYearRange"],
            "balances": [
                {
                    "code": balance["leaveType"]["code"],
                    "name": balance["leaveType"]["name"],
                    "available_days": balance["availableDays"],
                    "held_for_pending_requests_days": balance["heldDays"],
                    "balance_days": balance["balanceDays"],
                }
                for balance in balances["balances"]
            ],
            "note": "Types without a balance (such as Loss of Pay) are not listed; they have no limit.",
        }

    async def list_leave_types() -> dict[str, Any]:
        leave_types = await _leave_types(systems, state)
        return {
            "leave_types": [
                {
                    "code": leave_type["code"],
                    "name": leave_type["name"],
                    "paid": leave_type["isPaid"],
                    "keeps_balance": leave_type["tracksBalance"],
                    "half_days_allowed": leave_type["usage"]["allowHalfDay"],
                    "notice_days_needed": leave_type["usage"]["minNoticeDays"],
                    "may_start_up_to_days_ago": leave_type["usage"]["maxBackdatedDays"],
                    "most_days_at_once": leave_type["usage"]["maxConsecutiveDays"],
                    "document_needed_after_days": leave_type["usage"]["attachmentRequiredAfterDays"],
                    "sandwich_rule": leave_type["usage"]["sandwichRule"],
                }
                for leave_type in leave_types
            ]
        }

    async def list_my_leave_requests(status: str | None = None) -> dict[str, Any]:
        requests = await systems.requests(employee_id, status)
        return {
            "requests": [
                {
                    "type": request["leaveType"]["code"],
                    "start_date": request["startDate"],
                    "start_day_portion": request["startDayPortion"],
                    "end_date": request["endDate"],
                    "end_day_portion": request["endDayPortion"],
                    "days": request["totalDays"],
                    "status": request["status"],
                    "change_waiting": request["pendingChange"]["kind"] if request["pendingChange"] else None,
                }
                for request in requests[:MAX_REQUESTS_SHOWN]
            ],
            "more_not_shown": max(len(requests) - MAX_REQUESTS_SHOWN, 0),
        }

    async def get_office_calendar(from_date: date, to_date: date) -> dict[str, Any]:
        if to_date < from_date or (to_date - from_date).days >= MAX_CALENDAR_RANGE_DAYS:
            return {"error": f"Ask for at most {MAX_CALENDAR_RANGE_DAYS} days, with to_date on or after from_date."}
        try:
            calendar = await systems.office_calendar(employee_id, from_date.isoformat(), to_date.isoformat())
        except LeaveRequestRefusedError as refused_error:
            return _refusal(refused_error)
        return {
            "office": calendar["office"]["name"],
            "non_working_days": [
                {
                    "date": day["date"],
                    "weekday": _weekday(day["date"]),
                    "kind": day["kind"],
                    "holiday": day["holidayName"],
                }
                for day in calendar["days"]
                if day["kind"] != "working"
            ],
            "note": "Every day not listed is a working day.",
        }

    async def price_leave(
        leave_type_code: str,
        start_date: date,
        end_date: date,
        start_day_portion: str = "full",
        end_day_portion: str = "full",
    ) -> dict[str, Any]:
        leave_types = await _leave_types(systems, state)
        leave_type = _type_by_code(leave_types, leave_type_code)
        if leave_type is None:
            return _unknown_type(leave_types, leave_type_code)
        try:
            preview = await systems.price_leave(
                employee_id,
                {
                    "leaveTypeId": leave_type["id"],
                    "startDate": start_date.isoformat(),
                    "startDayPortion": start_day_portion,
                    "endDate": end_date.isoformat(),
                    "endDayPortion": end_day_portion,
                },
            )
        except LeaveRequestRefusedError as refused_error:
            return _refusal(refused_error)
        return {
            "leave_type": leave_type["code"],
            "total_days_charged": preview["totalDays"],
            "available_days_now": preview["availableDays"],
            "covered_by_balance": preview["isCoveredByBalance"],
            "document_needed": preview["attachmentRequired"],
            "days": [
                {
                    "date": day["date"],
                    "weekday": _weekday(day["date"]),
                    "kind": day["kind"],
                    "holiday": day["holidayName"],
                    "charged_days": day["chargedDays"],
                }
                for day in preview["days"]
            ],
            "sandwich_days_next_to_other_leave": [
                {"date": charge["date"], "charged_days": charge["chargedDays"]} for charge in preview["borderCharges"]
            ],
        }

    async def propose_leave_draft(
        leave_type_code: str,
        start_date: date,
        end_date: date,
        start_day_portion: str = "full",
        end_day_portion: str = "full",
        reason: str | None = None,
    ) -> dict[str, Any]:
        leave_types = await _leave_types(systems, state)
        leave_type = _type_by_code(leave_types, leave_type_code)
        if leave_type is None:
            return _unknown_type(leave_types, leave_type_code)
        if end_date < start_date:
            return {"error": "end_date cannot be before start_date."}
        state.draft = LeaveDraft(
            leave_type_id=leave_type["id"],
            start_date=start_date,
            start_day_portion=DayPortion(start_day_portion),
            end_date=end_date,
            end_day_portion=DayPortion(end_day_portion),
            reason=reason.strip() if reason and reason.strip() else None,
        )
        return {
            "draft_ready": True,
            "note": "The employee now sees a 'Review and send' button. Nothing has been sent: tell them to "
            "review the draft and send it themselves.",
        }

    return [
        StructuredTool.from_function(
            coroutine=get_my_leave_balances,
            name="get_my_leave_balances",
            description="The employee's leave balances for the current leave year: available, held and total days.",
            args_schema=NoArguments,
        ),
        StructuredTool.from_function(
            coroutine=list_leave_types,
            name="list_leave_types",
            description="The leave types on offer, with their codes and rules.",
            args_schema=NoArguments,
        ),
        StructuredTool.from_function(
            coroutine=list_my_leave_requests,
            name="list_my_leave_requests",
            description="The employee's own leave requests, newest first, with their status.",
            args_schema=RequestFilter,
        ),
        StructuredTool.from_function(
            coroutine=get_office_calendar,
            name="get_office_calendar",
            description="Weekly offs and holidays at the employee's office between two dates.",
            args_schema=CalendarRange,
        ),
        StructuredTool.from_function(
            coroutine=price_leave,
            name="price_leave",
            description="What a leave would cost, day by day, and whether the balance covers it. Saves nothing. "
            "Returns 'refused' with a reason when the leave breaks a rule.",
            args_schema=LeaveDates,
        ),
        StructuredTool.from_function(
            coroutine=propose_leave_draft,
            name="propose_leave_draft",
            description="Prepare the leave the employee asked for as a draft they review and send themselves. "
            "Price it first. This never sends anything.",
            args_schema=DraftDetails,
        ),
    ]
