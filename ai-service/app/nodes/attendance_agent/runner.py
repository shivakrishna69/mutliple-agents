"""RegularizationAgent: runs the sub-agent conversation by conversation."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.nodes.attendance_agent.graph import build_regularization_graph
from app.nodes.attendance_agent.schemas import (
    AGENT_NAME,
    ApprovalRecord,
    EmployeeProfileSnapshot,
    ManagerReviewRequest,
    RegularizationOutcome,
    RegularizationState,
)
from app.nodes.attendance_agent.systems import RegularizationContext

logger = logging.getLogger("ai_service.attendance_agent")


# =================================================================================================
# Runner
# =================================================================================================


@dataclass(frozen=True)
class RegularizationTurnResult:
    """What the caller gets back after each employee message."""

    thread_id: str
    outcome: RegularizationOutcome
    reply: str
    approval: ApprovalRecord | None
    manager_review: ManagerReviewRequest | None
    manager_review_id: str | None
    internal_logs: list[str]


class RegularizationThreadNotFoundError(Exception):
    """A reply was sent for a conversation that is not waiting for one (finished, expired, or unknown)."""


class RegularizationAgent:
    """
    Runs the sub-agent conversation by conversation. Shared by both entry points: the support
    graph's attendance node (app/nodes/attendance_worker.py) and POST /ai/attendance/regularize.

      handle_message(thread_id, profile, text)  answers the agent's pending question if the thread is
                                                waiting for one, otherwise starts a new request
      start / respond                           the two halves, for callers that need to choose
      is_awaiting_input(thread_id)              whether the thread is paused on a question

    Threads are serialised (one run at a time per thread), deleted from the checkpointer once they
    reach a final outcome, and evicted after `idle_ttl_seconds` without activity while waiting,
    so the in-memory checkpointer stays bounded. Like the support graph's MemorySaver, state is per
    process: with several instances, route an employee's requests to one instance or a pending
    question is forgotten (the next message then simply starts a new request).
    """

    def __init__(
        self, context: RegularizationContext, *, idle_ttl_seconds: int = 3600, now_provider: Any = None
    ) -> None:
        self._context = context
        self._checkpointer = MemorySaver()
        self._graph = build_regularization_graph(self._checkpointer)
        self._idle_ttl_seconds = idle_ttl_seconds
        self._now = now_provider or (lambda: datetime.now(UTC))
        self._thread_locks: dict[str, asyncio.Lock] = {}
        self._waiting_threads: dict[str, float] = {}

    def is_awaiting_input(self, thread_id: str) -> bool:
        return thread_id in self._waiting_threads

    async def handle_message(
        self, thread_id: str, employee_profile: EmployeeProfileSnapshot, message_text: str, *, start_new: bool = False
    ) -> RegularizationTurnResult:
        if not start_new and self.is_awaiting_input(thread_id):
            try:
                return await self.respond(thread_id, message_text)
            except RegularizationThreadNotFoundError:
                pass  # expired between the check and the call: treat the message as a new request
        return await self.start(thread_id, employee_profile, message_text)

    async def start(
        self, thread_id: str, employee_profile: EmployeeProfileSnapshot, message_text: str
    ) -> RegularizationTurnResult:
        await self._evict_idle_threads()
        async with self._lock_for(thread_id):
            self._waiting_threads.pop(thread_id, None)
            await self._checkpointer.adelete_thread(thread_id)
            today = self._now().astimezone(employee_profile.zone).date()
            graph_input: RegularizationState = {
                "messages": [HumanMessage(content=message_text)],
                "thread_id": thread_id,
                "employee_profile": employee_profile.model_dump(mode="json"),
                "today": today.isoformat(),
                "clarification_turns": 0,
                "internal_logs": [],
            }
            return await self._run(thread_id, graph_input)

    async def respond(self, thread_id: str, answer_text: str) -> RegularizationTurnResult:
        await self._evict_idle_threads()
        async with self._lock_for(thread_id):
            if thread_id not in self._waiting_threads:
                raise RegularizationThreadNotFoundError(thread_id)
            return await self._run(thread_id, Command(resume=answer_text))

    async def _run(self, thread_id: str, graph_input: Any) -> RegularizationTurnResult:
        graph_config = {"configurable": {"thread_id": thread_id}}
        final_state = await self._graph.ainvoke(graph_input, config=graph_config, context=self._context)
        pending_interrupts = final_state.get("__interrupt__") or []
        internal_logs = list(final_state.get("internal_logs", []))

        if pending_interrupts:
            self._waiting_threads[thread_id] = time.monotonic()
            question = pending_interrupts[0].value["question"]
            return RegularizationTurnResult(
                thread_id, RegularizationOutcome.AWAITING_EMPLOYEE_INPUT, question, None, None, None, internal_logs
            )

        # Final outcome: the thread is complete, so its checkpoint is no longer needed.
        self._waiting_threads.pop(thread_id, None)
        await self._checkpointer.adelete_thread(thread_id)
        approval = ApprovalRecord.model_validate(final_state["approval"]) if final_state.get("approval") else None
        manager_review = (
            ManagerReviewRequest.model_validate(final_state["manager_review"])
            if final_state.get("manager_review")
            else None
        )
        logger.info(
            "Regularization finished",
            extra={
                "agent": AGENT_NAME,
                "thread_id": thread_id,
                "outcome": final_state["outcome"],
                "clarification_turns": final_state.get("clarification_turns", 0),
            },
        )
        return RegularizationTurnResult(
            thread_id,
            RegularizationOutcome(final_state["outcome"]),
            final_state["reply"],
            approval,
            manager_review,
            final_state.get("manager_review_id"),
            internal_logs,
        )

    def _lock_for(self, thread_id: str) -> asyncio.Lock:
        return self._thread_locks.setdefault(thread_id, asyncio.Lock())

    async def _evict_idle_threads(self) -> None:
        cutoff = time.monotonic() - self._idle_ttl_seconds
        for idle_thread_id in [
            waiting_id for waiting_id, last_active in self._waiting_threads.items() if last_active < cutoff
        ]:
            self._waiting_threads.pop(idle_thread_id, None)
            idle_lock = self._thread_locks.get(idle_thread_id)
            if idle_lock is None or not idle_lock.locked():
                self._thread_locks.pop(idle_thread_id, None)
            await self._checkpointer.adelete_thread(idle_thread_id)
            logger.info(
                "Regularization thread evicted after inactivity",
                extra={"agent": AGENT_NAME, "thread_id": idle_thread_id},
            )
