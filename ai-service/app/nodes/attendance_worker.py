"""
The support graph's attendance_regularization node: hands a conversation turn to the attendance
regularization sub-agent (app/nodes/attendance_agent.py) and turns its result into a reply.

Flow for one turn
-----------------
  supervisor (ATTENDANCE_REGULARIZATION) ──► attendance_regularization ──► supervisor (review) ──► END

  1. Identity      The employee profile comes from state.employee_context, which the backend loads
                   from MongoDB for the authenticated customer on every turn. Without it the
                   customer is not an employee with an assigned office, and the node says so
                   instead of guessing who they are.
  2. Sub-agent     RegularizationAgent.handle_message, on the sub-agent thread
                   "support:<conversation thread>". If that thread is paused on a question (for
                   example "Which day did you miss clocking in?"), this message is the answer and
                   resumes it; otherwise it starts a new request.
  3. Reply         The sub-agent's reply is appended as this turn's answer and
                   last_replying_worker = "attendance_agent", which the backend records as the
                   conversation's active worker. regularization_awaiting_input tells the supervisor
                   on the next turn that a question is open, so the answer is routed back here
                   (the multi-turn follow-up); it is cleared when the supervisor routes elsewhere.
  4. Control       The graph returns to the supervisor for review, like the other specialists, so
                   a second topic in the same message can still be answered.

The sub-agent's replies are fixed templates filled with verified data (dates, times, statuses,
counts), not free model text, and every action they describe has actually been performed (the
Attendance write or the stored manager review). They therefore do not pass through the output
guard, whose job is to stop free-text replies from claiming actions that never happened.

Failure handling: anything unexpected from the sub-agent hands the conversation to a human, the
same policy as the other workers. asyncio.CancelledError (the turn deadline) is never caught.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime

from app.nodes.attendance_agent import EmployeeProfileSnapshot, RegularizationOutcome
from app.nodes.context import AgentContext
from app.nodes.policies import HUMAN_HANDOFF_REPLY
from app.schemas import EmployeeContext, WorkerName

logger = logging.getLogger("ai_service.attendance_worker")

NODE_NAME = "attendance_regularization"

NOT_AN_EMPLOYEE_REPLY = (
    "I can only correct attendance for employees whose profile and office are set up in our system, and I couldn't "
    "find that for your account. Please contact HR to have your employee profile and office assigned."
)
REGULARIZATION_UNAVAILABLE_REPLY = (
    "Attendance corrections aren't available in this chat right now. Please try again later or contact HR."
)


def _latest_customer_message_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return str(message.content)
    return ""


def _reply_update(reply_text: str, replying_worker: str, log_entries: list[str], *, awaiting_input: bool) -> dict[str, Any]:
    return {
        "messages": [AIMessage(content=reply_text, id=f"ai-{uuid.uuid4().hex}")],
        "last_replying_worker": replying_worker,
        "regularization_awaiting_input": awaiting_input,
        "internal_logs": log_entries,
    }


async def attendance_regularization_node(state: dict[str, Any], runtime: Runtime[AgentContext]) -> dict[str, Any]:
    regularization_agent = runtime.context.regularization_agent
    attendance_worker = WorkerName.ATTENDANCE_AGENT.value

    if regularization_agent is None:
        return _reply_update(REGULARIZATION_UNAVAILABLE_REPLY, attendance_worker, [f"{NODE_NAME}: regularization is not configured on this service"], awaiting_input=False)

    raw_employee_context = state.get("employee_context")
    if not raw_employee_context:
        return _reply_update(NOT_AN_EMPLOYEE_REPLY, attendance_worker, [f"{NODE_NAME}: customer has no employee profile with an office"], awaiting_input=False)

    message_text = _latest_customer_message_text(state.get("messages", []))
    sub_agent_thread_id = f"support:{state.get('conversation_thread_id', '')}"
    try:
        employee_profile = EmployeeProfileSnapshot.from_employee_context(EmployeeContext.model_validate(raw_employee_context))
        turn_result = await regularization_agent.handle_message(sub_agent_thread_id, employee_profile, message_text)
    except Exception as unexpected_error:  # noqa: BLE001 - never crash the support turn; a person takes over
        logger.exception("Attendance regularization failed; handing off to a human", extra={"node": NODE_NAME})
        return _reply_update(
            HUMAN_HANDOFF_REPLY,
            WorkerName.HUMAN.value,
            [f"{NODE_NAME}: failed ({type(unexpected_error).__name__}); handed off to a human"],
            awaiting_input=False,
        )

    is_awaiting_input = turn_result.outcome is RegularizationOutcome.AWAITING_EMPLOYEE_INPUT
    logger.info("Attendance regularization turn completed", extra={"node": NODE_NAME, "outcome": turn_result.outcome.value})
    return _reply_update(
        turn_result.reply,
        attendance_worker,
        [*turn_result.internal_logs, f"{NODE_NAME}: outcome {turn_result.outcome.value}"],
        awaiting_input=is_awaiting_input,
    )
