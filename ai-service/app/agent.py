"""
AgentRuntime: owns the model clients, the compiled support graph, the checkpointer, and the thread
registry, and runs one conversation turn per /ai/process request.

The workflow itself (nodes, cyclic routing, loop termination, state channels) is defined and drawn
in app/graph.py. This module covers what surrounds it: building the models, injecting them through
the runtime context, running a turn under a lock and a deadline, assembling the response, and
bounding the memory the checkpointer holds.

=================================================================================================
Turn execution (process_conversation)
=================================================================================================

  input    messages = [RemoveMessage(REMOVE_ALL_MESSAGES), *backend transcript]  (transcript replaced)
           internal_logs = [unique turn marker]                                 (appended)
           customer_id = authenticated customer from the request                (overwritten)
  run      compiled_graph.ainvoke(..., context=AgentContext, durability="exit",
           recursion_limit=RECURSION_LIMIT) under the thread lock and AI_PROCESS_TIMEOUT_SECONDS
  output   response_content = every final reply of this turn joined with a blank line
           next_worker      = last_replying_worker (who actually answered last)
           internal_logs    = the entries from this turn's marker on

=================================================================================================
State-history persistence and memory bounds
=================================================================================================

The graph is compiled with `memory_checkpointer` (LangGraph's in-process MemorySaver). Each turn is
invoked with `thread_id` = ConversationInput.resolved_thread_id and `durability="exit"`, so exactly
one checkpoint is written per turn, after the run completes; a run that fails or times out writes
nothing and leaves the previous state intact.

MemorySaver never forgets on its own, so ThreadRegistry bounds it:
  - per-thread asyncio.Lock: turns of one thread run one at a time, never interleaving state writes;
  - compaction: after COMPACT_THREAD_AFTER_TURNS turns the latest state is read, the thread's whole
    checkpoint history deleted, and the state re-seeded as a single checkpoint;
  - idle eviction: threads unused for THREAD_IDLE_TTL_SECONDS are deleted by a background task;
  - capacity: beyond MAX_TRACKED_THREADS, the least recently used idle threads are deleted.
Losing a thread's checkpoint is harmless for correctness: the backend resends the transcript every
turn; only the "previous worker" hint for routing is lost. MemorySaver is per process, so with
several replicas each keeps its own hints; a shared checkpointer (Postgres, Redis, MongoDB) is the
upgrade path when routing continuity across replicas matters.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import BaseMessage, RemoveMessage
from langchain_groq import ChatGroq
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from app.config import Settings
from app.graph import NODE_HUMAN_HANDOFF, RECURSION_LIMIT, build_support_graph
from app.nodes.attendance_agent import (
    BackendRegularizationSystems,
    EmployeeProfileSnapshot,
    RegularizationAgent,
    RegularizationContext,
    RegularizationTurnResult,
    SimulatedActivityEvidenceSource,
    create_regularization_model,
)
from app.nodes.context import AgentContext
from app.nodes.supervisor import create_supervisor_model
from app.nodes.transcript import replies_given_this_turn
from app.schemas import MESSAGE_CONTENT_MAX_LENGTH, EmployeeContext
from app.services.backend_client import BackendInternalClient

logger = logging.getLogger("ai_service.agent")

# =================================================================================================
# Errors
# =================================================================================================


class AgentError(Exception):
    """Base class for failures the HTTP layer maps to specific status codes."""

    def __init__(self, failure_kind: str, detail: str) -> None:
        super().__init__(f"{failure_kind}: {detail}")
        self.failure_kind = failure_kind
        self.detail = detail


class LLMNotConfiguredError(AgentError):
    """GROQ_API_KEY is not set, so no model call can be made."""


class InvalidModelOutputError(AgentError):
    """The model answered, but not in a usable form (no routing decision, empty reply)."""


class AgentTimeoutError(AgentError):
    """The whole turn exceeded AI_PROCESS_TIMEOUT_SECONDS."""


class RegularizationUnavailableError(AgentError):
    """BACKEND_INTERNAL_URL is not configured, so attendance cannot be read or written."""


@dataclass(frozen=True)
class TurnResult:
    """What one completed turn produced, before mapping to the HTTP response schema."""

    response_content: str
    next_worker: str
    internal_logs: list[str]


# =================================================================================================
# Thread registry: locking, compaction, and eviction for MemorySaver threads
# =================================================================================================


@dataclass
class ThreadActivity:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_used_monotonic: float = field(default_factory=time.monotonic)
    turns_since_compaction: int = 0
    pending_requests: int = 0


class ThreadRegistry:
    """
    Tracks every thread that has state in the checkpointer and bounds how much is kept.
    All methods run on the event loop; there is no cross-thread access.
    """

    def __init__(
        self,
        memory_checkpointer: MemorySaver,
        *,
        idle_ttl_seconds: int,
        max_tracked_threads: int,
        compact_after_turns: int,
    ) -> None:
        self._memory_checkpointer = memory_checkpointer
        self._idle_ttl_seconds = idle_ttl_seconds
        self._max_tracked_threads = max_tracked_threads
        self._compact_after_turns = compact_after_turns
        self._activity_by_thread: OrderedDict[str, ThreadActivity] = OrderedDict()

    @property
    def tracked_thread_count(self) -> int:
        return len(self._activity_by_thread)

    @asynccontextmanager
    async def exclusive_thread_access(self, thread_id: str) -> AsyncIterator[ThreadActivity]:
        """
        Holds the thread's lock for the duration of a turn. `pending_requests` is raised before
        waiting for the lock, so a thread with queued work is never evicted.
        """
        thread_activity = self._activity_by_thread.get(thread_id)
        if thread_activity is None:
            thread_activity = ThreadActivity()
            self._activity_by_thread[thread_id] = thread_activity
        self._activity_by_thread.move_to_end(thread_id)
        thread_activity.pending_requests += 1
        try:
            async with thread_activity.lock:
                yield thread_activity
        finally:
            thread_activity.pending_requests -= 1
            thread_activity.last_used_monotonic = time.monotonic()
        await self.evict_over_capacity()

    def should_compact(self, thread_activity: ThreadActivity) -> bool:
        thread_activity.turns_since_compaction += 1
        return thread_activity.turns_since_compaction >= self._compact_after_turns

    async def _delete_thread(self, thread_id: str, reason: str) -> None:
        await self._memory_checkpointer.adelete_thread(thread_id)
        self._activity_by_thread.pop(thread_id, None)
        logger.info("Thread state evicted", extra={"thread_id": thread_id, "reason": reason})

    async def evict_idle_threads(self) -> int:
        """Deletes threads idle longer than the TTL. Returns how many were deleted."""
        idle_cutoff = time.monotonic() - self._idle_ttl_seconds
        idle_thread_ids = [
            thread_id
            for thread_id, thread_activity in self._activity_by_thread.items()
            if thread_activity.pending_requests == 0 and thread_activity.last_used_monotonic < idle_cutoff
        ]
        for thread_id in idle_thread_ids:
            await self._delete_thread(thread_id, "idle_ttl")
        return len(idle_thread_ids)

    async def evict_over_capacity(self) -> None:
        """Deletes least recently used idle threads until within MAX_TRACKED_THREADS."""
        while len(self._activity_by_thread) > self._max_tracked_threads:
            least_recent_idle_thread = next(
                (thread_id for thread_id, activity in self._activity_by_thread.items() if activity.pending_requests == 0),
                None,
            )
            if least_recent_idle_thread is None:
                # Every tracked thread has a request in flight; capacity is restored as they finish.
                return
            await self._delete_thread(least_recent_idle_thread, "capacity")


# =================================================================================================
# Runtime
# =================================================================================================


class AgentRuntime:
    """Owns the model clients, the compiled graph, the checkpointer, and the thread registry."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.memory_checkpointer = MemorySaver()
        self.thread_registry = ThreadRegistry(
            self.memory_checkpointer,
            idle_ttl_seconds=settings.thread_idle_ttl_seconds,
            max_tracked_threads=settings.max_tracked_threads,
            compact_after_turns=settings.compact_thread_after_turns,
        )

        self._response_model: ChatGroq | None = None
        self._agent_context: AgentContext | None = None
        self._backend_client: BackendInternalClient | None = None
        self.regularization_agent: RegularizationAgent | None = None
        if settings.groq_api_key:
            self._response_model = self._create_chat_model(settings.llm_temperature)
            # The attendance regularization sub-agent writes through the backend's internal API.
            # Activity evidence comes from the simulated source only where simulated data is
            # allowed (never in production); without a source every request goes to the manager.
            if settings.backend_internal_url:
                self._backend_client = BackendInternalClient(settings.backend_internal_url, settings.internal_api_key)
                evidence_source = SimulatedActivityEvidenceSource() if settings.simulated_tools_enabled else None
                self.regularization_agent = RegularizationAgent(
                    RegularizationContext(
                        extraction_model=create_regularization_model(settings),
                        systems=BackendRegularizationSystems(self._backend_client, evidence_source),
                    ),
                    idle_ttl_seconds=settings.thread_idle_ttl_seconds,
                )
            # Dependencies handed to nodes through LangGraph's runtime context on every run;
            # never written to the checkpointer.
            self._agent_context = AgentContext(
                supervisor_model=create_supervisor_model(settings),
                worker_model=self._response_model,
                max_context_messages=settings.max_context_messages,
                simulated_tools_enabled=settings.simulated_tools_enabled,
                regularization_agent=self.regularization_agent,
            )

        # The cyclic support workflow (app/graph.py), persisted per thread by memory_checkpointer.
        self.compiled_graph = build_support_graph(self.memory_checkpointer)

    async def aclose(self) -> None:
        """Releases pooled connections (called on application shutdown)."""
        if self._backend_client is not None:
            await self._backend_client.aclose()

    @property
    def is_regularization_configured(self) -> bool:
        return self.regularization_agent is not None

    @property
    def is_llm_configured(self) -> bool:
        return self._response_model is not None

    @property
    def model_name(self) -> str:
        return self._settings.groq_model

    def _create_chat_model(self, temperature: float) -> ChatGroq:
        """
        Groq chat model client. `max_retries` retries transient failures (connection errors, 429,
        5xx) with backoff inside the SDK; `timeout` bounds each attempt. The overall turn deadline
        (AI_PROCESS_TIMEOUT_SECONDS) still caps the total.
        """
        optional_client_settings: dict[str, Any] = {}
        # Only pass base_url when overridden: an explicit None leaves the client with an empty URL
        # instead of falling back to Groq's default endpoint.
        if self._settings.groq_base_url:
            optional_client_settings["base_url"] = self._settings.groq_base_url
        # Reasoning models spend output tokens on hidden reasoning before answering; "low" keeps a
        # turn within the latency budget. Non-reasoning models reject the parameter, so it is only
        # sent when configured.
        if self._settings.llm_reasoning_effort:
            optional_client_settings["reasoning_effort"] = self._settings.llm_reasoning_effort
        return ChatGroq(
            model=self._settings.groq_model,
            api_key=self._settings.groq_api_key,
            temperature=temperature,
            max_tokens=self._settings.llm_max_output_tokens,
            timeout=self._settings.llm_request_timeout_seconds,
            max_retries=self._settings.llm_max_retries,
            **optional_client_settings,
        )

    # ---------------------------------------------------------------------------------------------
    # Turn execution
    # ---------------------------------------------------------------------------------------------

    async def process_conversation(
        self,
        *,
        thread_id: str,
        transcript_messages: list[BaseMessage],
        customer_id: str | None,
        request_id: str | None,
        employee_context: EmployeeContext | None = None,
    ) -> TurnResult:
        """
        Runs one turn for `thread_id` and returns the reply, the next worker, and this turn's logs.

        Input update applied to the thread's stored state:
          messages       [RemoveMessage(REMOVE_ALL_MESSAGES), *transcript_messages]  -> transcript replaced
          internal_logs  [turn marker]                                             -> appended
          customer_id    the authenticated customer from the request (empty if not sent) -> overwritten
          employee_context / conversation_thread_id   from the request                -> overwritten
        `next_worker` and `routing_reasoning` are not in the input, so the stored values from the
        previous turn are visible to the supervisor.
        """
        if not self.is_llm_configured:
            raise LLMNotConfiguredError("llm_not_configured", "GROQ_API_KEY is not set")

        turn_marker = f"gateway: turn {uuid.uuid4().hex} started with {len(transcript_messages)} transcript messages"
        graph_input = {
            "messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *transcript_messages],
            "internal_logs": [turn_marker],
            "customer_id": customer_id or "",
            "employee_context": employee_context.model_dump(mode="json") if employee_context else None,
            "conversation_thread_id": thread_id,
        }
        graph_config = {
            "configurable": {"thread_id": thread_id},
            "metadata": {"request_id": request_id},
            # Backstop only: the longest legitimate path is 4 steps (app/graph.py section 4).
            "recursion_limit": RECURSION_LIMIT,
        }

        try:
            async with asyncio.timeout(self._settings.process_timeout_seconds):
                async with self.thread_registry.exclusive_thread_access(thread_id) as thread_activity:
                    final_state = await self.compiled_graph.ainvoke(
                        graph_input, config=graph_config, context=self._agent_context, durability="exit"
                    )
                    if self.thread_registry.should_compact(thread_activity):
                        await self._compact_thread_history(thread_id, thread_activity)
        except TimeoutError as timeout_error:
            raise AgentTimeoutError(
                "turn_timeout", f"turn exceeded {self._settings.process_timeout_seconds} s"
            ) from timeout_error

        # Every final reply produced after the customer message, in order: one normally, two when
        # the supervisor sent a second topic to another specialist (see app/graph.py section 3).
        turn_replies = replies_given_this_turn(final_state.get("messages", []))
        if not turn_replies:
            raise InvalidModelOutputError("missing_reply", "the graph finished without producing a reply message")
        response_content = "\n\n".join(str(turn_reply.content).strip() for turn_reply in turn_replies)[:MESSAGE_CONTENT_MAX_LENGTH]

        stored_log_entries = final_state.get("internal_logs", [])
        turn_start_index = max(
            (entry_index for entry_index, log_entry in enumerate(stored_log_entries) if log_entry == turn_marker),
            default=0,
        )
        return TurnResult(
            response_content=response_content,
            # Who actually answered last (billing_agent, tech_agent, supervisor, or human), not the
            # supervisor's final review decision: the backend records this as the active worker.
            next_worker=final_state.get("last_replying_worker") or final_state["next_worker"],
            internal_logs=stored_log_entries[turn_start_index:],
        )

    async def _compact_thread_history(self, thread_id: str, thread_activity: ThreadActivity) -> None:
        """
        Collapses the thread's checkpoint history into one checkpoint holding the latest state.
        The values are written as if by human_handoff, whose only edge goes to END, so the re-seeded
        checkpoint has no pending work (new input would discard it anyway and start from START).
        Failure is logged and swallowed: the turn already succeeded, and losing history is harmless.
        """
        graph_config = {"configurable": {"thread_id": thread_id}}
        try:
            latest_snapshot = await self.compiled_graph.aget_state(graph_config)
            retained_values = {
                channel_name: latest_snapshot.values[channel_name]
                for channel_name in ("messages", "next_worker", "last_replying_worker", "routing_reasoning", "internal_logs")
                if channel_name in latest_snapshot.values
            }
            await self.memory_checkpointer.adelete_thread(thread_id)
            await self.compiled_graph.aupdate_state(graph_config, retained_values, as_node=NODE_HUMAN_HANDOFF)
            thread_activity.turns_since_compaction = 0
            logger.info("Thread history compacted", extra={"thread_id": thread_id})
        except Exception:  # noqa: BLE001 - compaction is best-effort by design (see docstring)
            logger.exception("Thread history compaction failed", extra={"thread_id": thread_id})

    # ---------------------------------------------------------------------------------------------
    # Attendance regularization (POST /ai/attendance/regularize)
    # ---------------------------------------------------------------------------------------------

    async def process_regularization(
        self,
        *,
        thread_id: str,
        message: str,
        employee_context: EmployeeContext,
        start_new: bool,
    ) -> RegularizationTurnResult:
        """
        One employee message for the regularization sub-agent, outside the support conversation:
        the answer to its pending question if it is waiting for one, otherwise a new request.
        Bounded by AI_PROCESS_TIMEOUT_SECONDS. A timeout can interrupt the run after the backend
        has written the entry; that is safe, because a retry finds the entry and reports it as
        already recorded instead of writing a second one.
        """
        if not self.is_llm_configured:
            raise LLMNotConfiguredError("llm_not_configured", "GROQ_API_KEY is not set")
        if self.regularization_agent is None:
            raise RegularizationUnavailableError("regularization_not_configured", "BACKEND_INTERNAL_URL is not set")
        employee_profile = EmployeeProfileSnapshot.from_employee_context(employee_context)
        try:
            async with asyncio.timeout(self._settings.process_timeout_seconds):
                return await self.regularization_agent.handle_message(thread_id, employee_profile, message, start_new=start_new)
        except TimeoutError as timeout_error:
            raise AgentTimeoutError("turn_timeout", f"regularization exceeded {self._settings.process_timeout_seconds} s") from timeout_error
