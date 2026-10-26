"""Graph nodes and routing functions of the sub-agent (package docstring, section 1)."""

from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.graph import END
from langgraph.runtime import Runtime
from langgraph.types import interrupt

from app.nodes.attendance_agent.extraction import (
    EXTRACTION_SYSTEM_PROMPT,
    ExtractionFailedError,
    conversation_for_model,
    extract_with_repair,
    resolve_requested_date,
)
from app.nodes.attendance_agent.rules import evaluate_activity_evidence
from app.nodes.attendance_agent.schemas import (
    MAX_CLARIFICATION_TURNS,
    MAX_REGULARIZATION_AGE_DAYS,
    ActivityLogReport,
    EmployeeProfileSnapshot,
    EvidenceEvaluation,
    ManagerReviewRequest,
    ManagerRoutingReason,
    RegularizationOutcome,
    RegularizationRequestExtraction,
    RegularizationState,
)
from app.nodes.attendance_agent.systems import (
    ActivitySystemUnavailableError,
    ApprovalRejectedError,
    RegularizationContext,
)

logger = logging.getLogger("ai_service.attendance_agent")


def _format_day(target_date: date) -> str:
    return f"{target_date:%A} {target_date.day} {target_date:%B %Y}"


# =================================================================================================
# Nodes
# =================================================================================================


def _profile(state: RegularizationState) -> EmployeeProfileSnapshot:
    return EmployeeProfileSnapshot.model_validate(state["employee_profile"])


def _extracted_request(state: RegularizationState) -> RegularizationRequestExtraction | None:
    stored_request = state.get("request")
    return RegularizationRequestExtraction.model_validate(stored_request) if stored_request else None


async def extract_request_node(state: RegularizationState, runtime: Runtime[RegularizationContext]) -> dict[str, Any]:
    profile = _profile(state)
    today = date.fromisoformat(state["today"])
    system_prompt = EXTRACTION_SYSTEM_PROMPT.format(
        today_long=_format_day(today), today_iso=today.isoformat(), time_zone=profile.time_zone
    )
    prompt_messages = [SystemMessage(content=system_prompt), *conversation_for_model(list(state.get("messages", [])))]
    started_at = time.perf_counter()
    try:
        extraction = await extract_with_repair(runtime.context.extraction_model, prompt_messages)
    except ExtractionFailedError as extraction_error:
        return {
            "extraction_failed": True,
            "internal_logs": [
                f"extract_request: failed ({extraction_error.failure_category}: {extraction_error.detail})"
            ],
        }
    # The date the rest of the graph works with is computed here from what the model reported.
    extraction = extraction.model_copy(update={"target_date": resolve_requested_date(extraction, today)})
    logger.info(
        "Regularization request extracted",
        extra={
            "node": "extract_request",
            "is_regularization_request": extraction.is_regularization_request,
            "has_target_date": extraction.target_date is not None,
            "has_claimed_time": extraction.claimed_punch_in_time is not None,
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 1),
        },
    )
    return {
        "request": extraction.model_dump(mode="json"),
        "extraction_failed": False,
        "internal_logs": [
            f"extract_request: regularization={extraction.is_regularization_request} "
            f"relative_day={extraction.relative_day.value if extraction.relative_day else None} date={extraction.target_date} "
            f"claimed_time={extraction.claimed_punch_in_time}"
        ],
    }


def route_after_extraction(state: RegularizationState) -> str:
    """
    Deterministic routing on the validated extraction:
      model failed or date unusable  -> ask_employee, or route_to_manager once the question limit is reached
      not a regularization request   -> reply_out_of_scope
      date older than the window     -> route_to_manager
      otherwise                      -> fetch_activity_logs
    The question to ask is decided by `_clarification_question`, written into state by ask_employee.
    """
    extraction = _extracted_request(state)
    today = date.fromisoformat(state["today"])
    has_questions_left = state.get("clarification_turns", 0) < MAX_CLARIFICATION_TURNS

    if state.get("extraction_failed") or extraction is None:
        return "ask_employee" if has_questions_left else "route_to_manager"
    if not extraction.is_regularization_request:
        return "reply_out_of_scope"
    if extraction.target_date is None or extraction.target_date > today:
        return "ask_employee" if has_questions_left else "route_to_manager"
    if (today - extraction.target_date).days > MAX_REGULARIZATION_AGE_DAYS:
        return "route_to_manager"
    return "fetch_activity_logs"


def _clarification_question(state: RegularizationState) -> str:
    """Deterministic wording for each reason the request cannot proceed yet."""
    extraction = _extracted_request(state)
    today = date.fromisoformat(state["today"])
    example_date = (today - timedelta(days=1)).isoformat()
    if state.get("extraction_failed") or extraction is None:
        return (
            "Sorry, I couldn't quite follow that. Which day did you miss clocking in, and roughly what time did you start "
            f'work? For example: "{example_date}, started at 09:30".'
        )
    if extraction.target_date is not None and extraction.target_date > today:
        return f"{_format_day(extraction.target_date)} hasn't happened yet. Which past day do you need to regularize?"
    return f"Which day did you miss clocking in? Please give the date, for example {example_date}."


async def ask_employee_node(state: RegularizationState) -> dict[str, Any]:
    """
    Pauses the run with `interrupt()` and resumes with the employee's answer. LangGraph re-runs
    this node from the top on resume, so everything before `interrupt()` is side-effect free.
    """
    question = _clarification_question(state)
    employee_answer = interrupt({"question": question})
    answer_text = " ".join(str(employee_answer).split())[:2000] or "(no answer)"
    return {
        "messages": [AIMessage(content=question), HumanMessage(content=answer_text)],
        "clarification_turns": state.get("clarification_turns", 0) + 1,
        "internal_logs": [
            f"ask_employee: asked question {state.get('clarification_turns', 0) + 1} of {MAX_CLARIFICATION_TURNS} and received an answer"
        ],
    }


async def fetch_activity_logs_node(
    state: RegularizationState, runtime: Runtime[RegularizationContext]
) -> dict[str, Any]:
    profile = _profile(state)
    extraction = _extracted_request(state)
    try:
        report = await runtime.context.systems.fetch_calendar_and_comms_logs(
            profile.employee_id, extraction.target_date, profile.time_zone
        )
        if report.employee_id != profile.employee_id or report.target_date != extraction.target_date:
            raise ActivitySystemUnavailableError("activity report does not match the requested employee/date")
    except Exception as fetch_error:  # noqa: BLE001 - an unavailable source routes to the manager
        logger.warning(
            "Activity log fetch failed",
            extra={
                "node": "fetch_activity_logs",
                "error_type": type(fetch_error).__name__,
                "error": str(fetch_error)[:200],
            },
        )
        return {
            "calendar_logs": None,
            "internal_logs": [
                f"fetch_activity_logs: unavailable ({type(fetch_error).__name__}: {str(fetch_error)[:120]})"
            ],
        }
    return {
        "calendar_logs": report.model_dump(mode="json"),
        "internal_logs": [
            f"fetch_activity_logs: {len(report.entries)} entries for {report.target_date} (source: {report.data_source})"
        ],
    }


def route_after_fetch(state: RegularizationState) -> str:
    return "evaluate_evidence" if state.get("calendar_logs") is not None else "route_to_manager"


async def evaluate_evidence_node(state: RegularizationState) -> dict[str, Any]:
    profile = _profile(state)
    extraction = _extracted_request(state)
    report = ActivityLogReport.model_validate(state["calendar_logs"])
    evaluation = evaluate_activity_evidence(report, profile, extraction.target_date)
    return {
        "evaluation": evaluation.model_dump(mode="json"),
        "internal_logs": [
            f"evaluate_evidence: {evaluation.qualifying_event_count} qualifying events -> "
            f"{'proven' if evaluation.is_activity_proven else 'not proven'} ({evaluation.rule})"
        ],
    }


def route_after_evaluation(state: RegularizationState) -> str:
    return (
        "approve_entry"
        if EvidenceEvaluation.model_validate(state["evaluation"]).is_activity_proven
        else "route_to_manager"
    )


async def approve_entry_node(state: RegularizationState, runtime: Runtime[RegularizationContext]) -> dict[str, Any]:
    """
    Writes the Attendance entry through the backend, which re-validates it against the office time
    zone and shift, computes Normal/Late/Half_Day from its grace rules, and refuses a second entry
    for the same day (returning the existing one instead).
    """
    profile = _profile(state)
    extraction = _extracted_request(state)
    evaluation = EvidenceEvaluation.model_validate(state["evaluation"])
    # The punch time is the first moment the evidence proves work, never the employee's claim.
    punch_time = max(evaluation.first_qualifying_activity_at, evaluation.working_window_start)
    try:
        approval = await runtime.context.systems.approve_regularization_entry(
            profile.employee_id,
            extraction.target_date,
            punch_time,
            evidence_event_count=evaluation.qualifying_event_count,
            reason=extraction.reason,
            thread_id=state["thread_id"],
        )
    except ApprovalRejectedError as rejection:
        logger.warning(
            "Regularization refused by the attendance system",
            extra={"node": "approve_entry", "detail": str(rejection)[:200]},
        )
        return {
            "approval": None,
            "approval_failure": "rejected",
            "internal_logs": [f"approve_entry: refused by attendance system ({str(rejection)[:200]})"],
        }
    except Exception as approval_error:  # noqa: BLE001 - an unreachable ledger routes to the manager
        logger.error(
            "Regularization approval failed",
            extra={
                "node": "approve_entry",
                "error_type": type(approval_error).__name__,
                "error": str(approval_error)[:200],
            },
        )
        return {
            "approval": None,
            "approval_failure": "unavailable",
            "internal_logs": [f"approve_entry: attendance system unavailable ({type(approval_error).__name__})"],
        }

    local_punch = approval.punch_in_time.astimezone(profile.zone)
    if approval.newly_created:
        claimed_note = ""
        if extraction.claimed_punch_in_time and extraction.claimed_punch_in_time.strftime(
            "%H:%M"
        ) != local_punch.strftime("%H:%M"):
            claimed_note = f" (you mentioned {extraction.claimed_punch_in_time:%H:%M}; I used the first time our systems recorded you working)"
        status_note = (
            ""
            if approval.calculation_status == "Normal"
            else f" Under your office's shift rules this counts as {approval.calculation_status.replace('_', ' ').lower()}."
        )
        reply = (
            f"Done. I found {evaluation.qualifying_event_count} records of you working on {_format_day(extraction.target_date)} "
            f"(meetings attended and messages sent during your working hours), so I've regularized that day with a "
            f"punch-in at {local_punch:%H:%M}{claimed_note}.{status_note}"
        )
    else:
        reply = f"{_format_day(extraction.target_date)} already has an attendance record with a punch-in at {local_punch:%H:%M}, so nothing needed to change."
    return {
        "approval": approval.model_dump(mode="json"),
        "approval_failure": None,
        "outcome": RegularizationOutcome.APPROVED.value,
        "reply": reply,
        "messages": [AIMessage(content=reply)],
        "internal_logs": [
            f"approve_entry: attendance {approval.attendance_id} punch_in={approval.punch_in_time.isoformat()} "
            f"status={approval.calculation_status} new={approval.newly_created}"
        ],
    }


def route_after_approval(state: RegularizationState) -> str:
    return END if state.get("approval") else "route_to_manager"


def _manager_routing_reason(state: RegularizationState) -> ManagerRoutingReason:
    """Why the request reached the manager, from what the earlier nodes recorded."""
    extraction = _extracted_request(state)
    today = date.fromisoformat(state["today"])
    approval_failure = state.get("approval_failure")
    if approval_failure == "rejected":
        return ManagerRoutingReason.APPROVAL_REJECTED
    if approval_failure == "unavailable":
        return ManagerRoutingReason.APPROVAL_SYSTEM_UNAVAILABLE
    if state.get("evaluation"):
        return ManagerRoutingReason.NO_ACTIVITY_PROOF
    if extraction and extraction.target_date and extraction.target_date <= today:
        if (today - extraction.target_date).days > MAX_REGULARIZATION_AGE_DAYS:
            return ManagerRoutingReason.OUTSIDE_REGULARIZATION_WINDOW
        return ManagerRoutingReason.ACTIVITY_SYSTEMS_UNAVAILABLE
    if state.get("extraction_failed") or extraction is None:
        return ManagerRoutingReason.REQUEST_NOT_UNDERSTOOD
    return ManagerRoutingReason.CLARIFICATION_LIMIT_REACHED


MANAGER_REPLY_BY_REASON: dict[ManagerRoutingReason, str] = {
    ManagerRoutingReason.NO_ACTIVITY_PROOF: (
        "I couldn't find enough activity records (meetings attended or messages sent during your working hours) for "
        "{day} to approve this automatically, so I've sent your request to your manager for review."
    ),
    ManagerRoutingReason.OUTSIDE_REGULARIZATION_WINDOW: (
        "{day} is more than "
        + str(MAX_REGULARIZATION_AGE_DAYS)
        + " days ago, which is outside the self-service window, "
        "so I've sent your request to your manager for review."
    ),
    ManagerRoutingReason.CLARIFICATION_LIMIT_REACHED: "I still couldn't confirm which day you need, so I've passed your request to your manager, who will follow up with you.",
    ManagerRoutingReason.REQUEST_NOT_UNDERSTOOD: "I couldn't process this request automatically, so I've passed it to your manager, who will follow up with you.",
    ManagerRoutingReason.ACTIVITY_SYSTEMS_UNAVAILABLE: "I can't check activity records automatically right now, so I've sent your request for {day} to your manager for review.",
    ManagerRoutingReason.APPROVAL_REJECTED: "Your activity for {day} checks out, but the attendance system couldn't apply it automatically, so I've sent it to your manager to review.",
    ManagerRoutingReason.APPROVAL_SYSTEM_UNAVAILABLE: "Your activity for {day} checks out, but I couldn't update the attendance record right now, so I've sent it to your manager to complete.",
}

# Used when the review itself could not be stored: the employee must not be told it was sent.
MANAGER_REVIEW_NOT_SUBMITTED_REPLY = (
    "I couldn't complete this automatically, and I also couldn't reach the review system to send it to your manager. "
    "Please try again in a few minutes, or contact your manager directly about {day}."
)


async def route_to_manager_node(state: RegularizationState, runtime: Runtime[RegularizationContext]) -> dict[str, Any]:
    """
    Builds the review for the reporting manager and stores it through the backend (one review per
    thread and date, so a retried submission never creates a duplicate). The reply only says the
    request was sent when the review was actually stored.
    """
    profile = _profile(state)
    extraction = _extracted_request(state)
    routing_reason = _manager_routing_reason(state)
    evaluation = EvidenceEvaluation.model_validate(state["evaluation"]) if state.get("evaluation") else None
    review_request = ManagerReviewRequest(
        employee_id=profile.employee_id,
        reporting_manager_id=profile.reporting_manager_id,
        target_date=extraction.target_date if extraction else None,
        claimed_punch_in_time=extraction.claimed_punch_in_time if extraction else None,
        employee_reason=extraction.reason if extraction else None,
        routing_reason=routing_reason,
        qualifying_event_count=evaluation.qualifying_event_count if evaluation else 0,
        allowed_geofence_radius=profile.allowed_geofence_radius,
    )
    day_label = _format_day(review_request.target_date) if review_request.target_date else "that day"
    idempotency_key = f"{state['thread_id']}:{review_request.target_date.isoformat() if review_request.target_date else 'undated'}:{state['today']}"
    try:
        review_id = await runtime.context.systems.submit_manager_review(review_request, idempotency_key=idempotency_key)
    except Exception as submission_error:  # noqa: BLE001 - reported to the employee honestly below
        logger.error(
            "Manager review submission failed",
            extra={
                "node": "route_to_manager",
                "error_type": type(submission_error).__name__,
                "error": str(submission_error)[:200],
            },
        )
        review_id = None

    reply = (
        MANAGER_REPLY_BY_REASON[routing_reason].format(day=day_label)
        if review_id
        else MANAGER_REVIEW_NOT_SUBMITTED_REPLY.format(day=day_label)
    )
    return {
        "manager_review": review_request.model_dump(mode="json"),
        "manager_review_id": review_id,
        "outcome": RegularizationOutcome.ROUTED_TO_MANAGER.value,
        "reply": reply,
        "messages": [AIMessage(content=reply)],
        "internal_logs": [
            f"route_to_manager: {routing_reason.value} (manager: {profile.reporting_manager_id or 'none on file'}) "
            f"review={'stored ' + review_id if review_id else 'NOT stored'}"
        ],
    }


OUT_OF_SCOPE_REPLY = (
    "I can help you fix a missed or incorrect clock-in for a past working day. "
    'Tell me which day it was and what happened, for example: "I forgot to clock in yesterday because my laptop broke."'
)


async def reply_out_of_scope_node(state: RegularizationState) -> dict[str, Any]:
    return {
        "outcome": RegularizationOutcome.OUT_OF_SCOPE.value,
        "reply": OUT_OF_SCOPE_REPLY,
        "messages": [AIMessage(content=OUT_OF_SCOPE_REPLY)],
        "internal_logs": ["reply_out_of_scope: message is not a regularization request"],
    }
