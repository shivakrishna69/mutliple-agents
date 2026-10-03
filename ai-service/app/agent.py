"""
LangGraph multi-agent runtime: a supervisor routes each customer message to a specialist worker,
which answers with a Groq-hosted model (GROQ_MODEL, default openai/gpt-oss-120b).

=================================================================================================
Graph topology and state transitions
=================================================================================================

    START ──► supervisor ──(conditional on state.next_worker)──┬──► billing_agent       ──► END
                                                               ├──► tech_agent          ──► END
                                                               ├──► supervisor_response ──► END
                                                               └──► human_handoff       ──► END

One graph run is one conversation turn (one customer message). Per node:

  supervisor           app/nodes/supervisor.py. Reads the transcript and the worker that handled
                       the previous turn (persisted state), asks a temperature-0 model for a raw
                       JSON SupervisorOutput (TECH_WORKER | BILLING_WORKER | HUMAN_ESCALATION |
                       FINISH), and writes `next_worker`, `routing_reasoning`, and one
                       `internal_logs` entry. Malformed output or a failed model call defaults to
                       HUMAN_ESCALATION instead of failing the turn. It never writes a message.
  billing_agent        app/nodes/workers.py billing_worker_node: invoices and payment status; may
                       call check_invoice_status (always scoped to the conversation's customer).
  tech_agent           app/nodes/workers.py tech_worker_node: errors, API failures, integration
                       bugs; may call query_system_logs.
  supervisor_response  app/nodes/workers.py supervisor_response_node: general questions the
                       supervisor answers itself (FINISH); no tools.
                       All three run the same tool execution pathway (workers.run_worker_turn) and
                       append [tool-call AIMessages, ToolMessages, final AIMessage]. A failed tool,
                       model call, or empty reply hands off to a human instead of failing the turn.
  human_handoff        No model call: appends a fixed handoff message and leaves
                       `next_worker = "human"`, which the backend turns into an escalation.

Every path ends with exactly one new final AIMessage (no tool calls), which becomes the turn's reply.

Output guardrail (app/guards/output_guard.py): every model-written worker reply is checked before it
is added to state. Sentences claiming actions the AI cannot take ("I've forwarded this to billing",
"your refund has been processed") are removed and an honest clarification appended; if the claim is
most of the reply, the worker instead returns the human handoff message and overwrites
`next_worker` with "human", escalating the conversation. The human_handoff node's fixed message is
not checked: that handoff really happens.

=================================================================================================
State and reducers
=================================================================================================

`AgentState` channels and how updates are merged:

  messages          `add_messages` (LangGraph's message reducer). Updates are merged by message id:
                    an id already present replaces the stored message, a new id is appended, and a
                    RemoveMessage deletes by id; RemoveMessage(id=REMOVE_ALL_MESSAGES) clears the
                    list. Each turn's input starts with REMOVE_ALL followed by the transcript from
                    the backend, so the stored transcript always equals the backend's (the source of
                    truth, which also holds human-agent messages this service never sees otherwise).
                    The worker's reply is then appended by the reducer.
  next_worker       Last-value channel (no reducer): each write overwrites it. Persisted across
                    turns, so the supervisor knows who handled the previous turn and can keep the
                    customer with the same specialist.
  routing_reasoning Last-value channel: the supervisor's one-sentence justification.
  internal_logs     `merge_internal_logs`: appends new entries and keeps only the newest
                    MAX_RETAINED_INTERNAL_LOGS, so the channel is bounded however long the thread
                    lives. Each turn begins with a unique marker entry; the response returns only the
                    entries from that marker on, i.e. this turn's audit trail.

System prompts are never stored in state: each node builds [SystemMessage, *recent transcript] just
for its model call, so prompts can change without migrating stored threads and never accumulate.

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
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, BaseMessage, RemoveMessage
from langchain_groq import ChatGroq
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import REMOVE_ALL_MESSAGES, add_messages

from app.config import Settings
from app.nodes.context import AgentContext
from app.nodes.policies import HUMAN_HANDOFF_REPLY
from app.nodes.supervisor import NODE_NAME as SUPERVISOR_NODE_NAME
from app.nodes.supervisor import create_supervisor_model, supervisor_node
from app.nodes.workers import (
    BILLING_WORKER_NODE_NAME,
    SUPERVISOR_RESPONSE_NODE_NAME,
    TECH_WORKER_NODE_NAME,
    billing_worker_node,
    supervisor_response_node,
    tech_worker_node,
)
from app.schemas import MAX_INTERNAL_LOG_ENTRIES, WorkerName

logger = logging.getLogger("ai_service.agent")

# =================================================================================================
# Constants
# =================================================================================================

MAX_RETAINED_INTERNAL_LOGS = MAX_INTERNAL_LOG_ENTRIES

NODE_SUPERVISOR = SUPERVISOR_NODE_NAME
NODE_SUPERVISOR_RESPONSE = SUPERVISOR_RESPONSE_NODE_NAME
NODE_BILLING_AGENT = BILLING_WORKER_NODE_NAME
NODE_TECH_AGENT = TECH_WORKER_NODE_NAME
NODE_HUMAN_HANDOFF = "human_handoff"

# Routing decision value -> graph node that executes it.
WORKER_NODE_BY_DECISION: dict[str, str] = {
    WorkerName.BILLING_AGENT.value: NODE_BILLING_AGENT,
    WorkerName.TECH_AGENT.value: NODE_TECH_AGENT,
    WorkerName.SUPERVISOR.value: NODE_SUPERVISOR_RESPONSE,
    WorkerName.HUMAN.value: NODE_HUMAN_HANDOFF,
}


# =================================================================================================
# State
# =================================================================================================


def merge_internal_logs(existing_log_entries: list[str] | None, new_log_entries: list[str] | None) -> list[str]:
    """
    Reducer for `internal_logs`: append the update to the stored list and keep only the newest
    MAX_RETAINED_INTERNAL_LOGS entries. Being a pure function of its inputs, it gives the same
    result whether applied during a run or when a checkpoint is replayed.
    """
    combined_log_entries = [*(existing_log_entries or []), *(new_log_entries or [])]
    return combined_log_entries[-MAX_RETAINED_INTERNAL_LOGS:]


class AgentState(TypedDict, total=False):
    """
    Graph state for one conversation thread. `total=False` because a thread's first turn starts
    without `next_worker` or `routing_reasoning`; nodes read them with `.get`.
    """

    messages: Annotated[list[AnyMessage], add_messages]
    next_worker: str
    routing_reasoning: str
    internal_logs: Annotated[list[str], merge_internal_logs]
    # The authenticated customer this conversation belongs to, set from the request every turn.
    # Read only by server-side tool argument injection (workers.SERVER_INJECTED_TOOL_ARGUMENTS),
    # never shown to the model, so tools are always scoped to this customer.
    customer_id: str


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
        if settings.groq_api_key:
            self._response_model = self._create_chat_model(settings.llm_temperature)
            # Dependencies handed to nodes through LangGraph's runtime context on every run;
            # never written to the checkpointer.
            self._agent_context = AgentContext(
                supervisor_model=create_supervisor_model(settings),
                worker_model=self._response_model,
                max_context_messages=settings.max_context_messages,
                simulated_tools_enabled=settings.simulated_tools_enabled,
            )

        self.compiled_graph = self._build_graph()

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
    # Graph construction
    # ---------------------------------------------------------------------------------------------

    def _build_graph(self):
        # context_schema declares the run-scoped dependencies (AgentContext) nodes may receive.
        graph_builder = StateGraph(AgentState, context_schema=AgentContext)
        graph_builder.add_node(NODE_SUPERVISOR, supervisor_node)
        graph_builder.add_node(NODE_BILLING_AGENT, billing_worker_node)
        graph_builder.add_node(NODE_TECH_AGENT, tech_worker_node)
        graph_builder.add_node(NODE_SUPERVISOR_RESPONSE, supervisor_response_node)
        graph_builder.add_node(NODE_HUMAN_HANDOFF, self._human_handoff_node)

        graph_builder.add_edge(START, NODE_SUPERVISOR)
        graph_builder.add_conditional_edges(NODE_SUPERVISOR, self._select_worker_node, list(WORKER_NODE_BY_DECISION.values()))
        for worker_node_name in WORKER_NODE_BY_DECISION.values():
            graph_builder.add_edge(worker_node_name, END)

        return graph_builder.compile(checkpointer=self.memory_checkpointer)

    @staticmethod
    def _select_worker_node(agent_state: AgentState) -> str:
        """Conditional edge: the node for the worker the supervisor chose."""
        return WORKER_NODE_BY_DECISION[agent_state["next_worker"]]

    async def _human_handoff_node(self, agent_state: AgentState) -> dict[str, Any]:
        logger.info("Conversation handed off to a human", extra={"node": NODE_HUMAN_HANDOFF})
        return {
            "messages": [AIMessage(content=HUMAN_HANDOFF_REPLY, id=f"ai-{uuid.uuid4().hex}")],
            "internal_logs": [f"{NODE_HUMAN_HANDOFF}: escalation reply sent; a human agent takes over"],
        }

    # ---------------------------------------------------------------------------------------------
    # Model invocation
    # ---------------------------------------------------------------------------------------------

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
    ) -> TurnResult:
        """
        Runs one turn for `thread_id` and returns the reply, the next worker, and this turn's logs.

        Input update applied to the thread's stored state:
          messages       [RemoveMessage(REMOVE_ALL_MESSAGES), *transcript_messages]  -> transcript replaced
          internal_logs  [turn marker]                                             -> appended
          customer_id    the authenticated customer from the request (empty if not sent) -> overwritten
        `next_worker` and `routing_reasoning` are not in the input, so the stored values from the
        previous turn are visible to the supervisor.
        """
        if not self.is_llm_configured:
            raise LLMNotConfiguredError("llm_not_configured", "GROQ_API_KEY is not set")

        turn_marker = f"gateway: turn {uuid.uuid4().hex} started with {len(transcript_messages)} transcript messages"
        incoming_message_ids = {transcript_message.id for transcript_message in transcript_messages}
        graph_input = {
            "messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *transcript_messages],
            "internal_logs": [turn_marker],
            "customer_id": customer_id or "",
        }
        graph_config ={"configurable": {"thread_id": thread_id}, "metadata": {"request_id": request_id}}

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

        final_messages = final_state.get("messages", [])
        reply_message = final_messages[-1] if final_messages else None
        if not isinstance(reply_message, AIMessage) or reply_message.id in incoming_message_ids:
            raise InvalidModelOutputError("missing_reply", "the graph finished without producing a reply message")

        stored_log_entries = final_state.get("internal_logs", [])
        turn_start_index = max(
            (entry_index for entry_index, log_entry in enumerate(stored_log_entries) if log_entry == turn_marker),
            default=0,
        )
        return TurnResult(
            response_content=reply_message.content,
            next_worker=final_state["next_worker"],
            internal_logs=stored_log_entries[turn_start_index:],
        )

    async def _compact_thread_history(self, thread_id: str, thread_activity: ThreadActivity) -> None:
        """
        Collapses the thread's checkpoint history into one checkpoint holding the latest state.
        `as_node` names the worker node that produced that state; its only edge goes to END, so the
        re-seeded checkpoint has no pending work and the next turn starts cleanly from START.
        Failure is logged and swallowed: the turn already succeeded, and losing history is harmless.
        """
        graph_config = {"configurable": {"thread_id": thread_id}}
        try:
            latest_snapshot = await self.compiled_graph.aget_state(graph_config)
            retained_values = {
                channel_name: latest_snapshot.values[channel_name]
                for channel_name in ("messages", "next_worker", "routing_reasoning", "internal_logs")
                if channel_name in latest_snapshot.values
            }
            producing_node = WORKER_NODE_BY_DECISION.get(retained_values.get("next_worker", ""), NODE_SUPERVISOR_RESPONSE)
            await self.memory_checkpointer.adelete_thread(thread_id)
            await self.compiled_graph.aupdate_state(graph_config, retained_values, as_node=producing_node)
            thread_activity.turns_since_compaction = 0
            logger.info("Thread history compacted", extra={"thread_id": thread_id})
        except Exception:  # noqa: BLE001 - compaction is best-effort by design (see docstring)
            logger.exception("Thread history compaction failed", extra={"thread_id": thread_id})
