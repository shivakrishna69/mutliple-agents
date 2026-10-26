"""
Test doubles: a chat model that plays back scripted replies, and in-memory attendance systems.
Nothing here touches the network.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

from app.nodes.attendance_agent import (
    ActivityLogReport,
    ApprovalRecord,
    ApprovalRejectedError,
    ManagerReviewRequest,
)


class ScriptedChatModel(BaseChatModel):
    """
    Returns the queued replies in order (an Exception in the queue is raised instead), and records
    every input it received. `bind_tools` returns the same model, so tool-calling workers can use it.
    """

    replies: list[Any] = Field(default_factory=list)
    received_inputs: list[list[BaseMessage]] = Field(default_factory=list)
    bound_tool_names: list[str] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages: list[BaseMessage], stop: Any = None, run_manager: Any = None, **kwargs: Any):
        self.received_inputs.append(list(messages))
        if not self.replies:
            raise AssertionError("ScriptedChatModel received more calls than scripted replies")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return ChatResult(generations=[ChatGeneration(message=reply)])

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedChatModel:
        self.bound_tool_names = [tool.name for tool in tools]
        return self


def routing_reply(next_action: str, reasoning: str = "test routing") -> AIMessage:
    """What the supervisor model returns: its decision as a JSON object."""
    return AIMessage(content=json.dumps({"next_action": next_action, "reasoning": reasoning}))


def text_reply(text: str) -> AIMessage:
    return AIMessage(content=text)


def tool_call_reply(tool_name: str, arguments: dict[str, Any], call_id: str = "call-1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": tool_name, "args": arguments, "id": call_id}])


def json_reply(payload: dict[str, Any]) -> AIMessage:
    return AIMessage(content=json.dumps(payload))


class FakeRegularizationSystems:
    """In-memory RegularizationSystems: returns a fixed activity report and records every write."""

    def __init__(
        self,
        activity_report: ActivityLogReport | None = None,
        *,
        fetch_error: Exception | None = None,
        approval_error: Exception | None = None,
    ) -> None:
        self.activity_report = activity_report
        self.fetch_error = fetch_error
        self.approval_error = approval_error
        self.fetch_calls: list[tuple[str, date, str]] = []
        self.approval_calls: list[dict[str, Any]] = []
        self.submitted_reviews: list[ManagerReviewRequest] = []

    async def fetch_calendar_and_comms_logs(self, employee_id: str, target_date: date, time_zone: str):
        self.fetch_calls.append((employee_id, target_date, time_zone))
        if self.fetch_error:
            raise self.fetch_error
        return self.activity_report.model_copy(update={"employee_id": employee_id, "target_date": target_date})

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
        self.approval_calls.append(
            {
                "employee_id": employee_id,
                "target_date": target_date,
                "punch_time": punch_time,
                "evidence_event_count": evidence_event_count,
                "reason": reason,
            }
        )
        if self.approval_error:
            raise self.approval_error
        return ApprovalRecord(
            attendance_id="attendance-1",
            employee_id=employee_id,
            target_date=target_date,
            punch_in_time=punch_time,
            calculation_status="Late",
            newly_created=True,
        )

    async def submit_manager_review(self, review: ManagerReviewRequest, *, idempotency_key: str) -> str:
        self.submitted_reviews.append(review)
        return f"review-{len(self.submitted_reviews)}"


__all__ = [
    "ApprovalRejectedError",
    "FakeRegularizationSystems",
    "ScriptedChatModel",
    "json_reply",
    "routing_reply",
    "text_reply",
    "tool_call_reply",
]
