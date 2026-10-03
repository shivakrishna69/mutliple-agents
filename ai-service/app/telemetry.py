"""
Live agent telemetry: reports how each turn runs (graph nodes, model calls, tool runs, retriever
queries) to the Node backend, which relays it to admin telemetry consoles over Socket.IO.

=================================================================================================
Pipeline
=================================================================================================

  turn scope    AgentRuntime wraps every turn in `telemetry_turn(...)`, which binds a
                TurnTelemetryHandler to a context variable for the duration of the turn.
  capture       The context variable is registered with LangChain (register_configure_hook), so
                every LangChain run started inside the turn (the graph, its nodes, each model
                call, each tool, each retriever) gets the handler automatically, without passing
                callbacks through the graph or the regularization agent. Context variables are
                copied into the tasks LangGraph starts, and are per-task, so concurrent turns
                never see each other's handler.
  queue         Handler callbacks only build a small dict and put it on TelemetryPublisher's
                bounded in-memory queue (put_nowait): they never wait on the network, so
                telemetry cannot slow a turn down.
  delivery      One background task drains the queue in batches (up to BATCH_SIZE events, or
                whatever arrived within FLUSH_INTERVAL_SECONDS) and posts each batch to
                POST /api/internal/agent-telemetry/events.

=================================================================================================
Failure behaviour: telemetry is best-effort and never affects a turn
=================================================================================================

  - Callback exceptions are swallowed by LangChain (handler.raise_error is False) and, inside
    the handler, every emit is guarded as well.
  - A full queue (backend slow or down) drops new events and counts them; the drop count is
    logged at most once per DROP_LOG_INTERVAL_SECONDS.
  - A failed batch is dropped after the client's single retry. Sending stale events later would
    show a console a "live" view of the past.
  - On shutdown the queue is flushed for up to SHUTDOWN_FLUSH_SECONDS, then abandoned.

=================================================================================================
What is reported (privacy)
=================================================================================================

Identifiers, enums, counts and durations only: never message text, tool arguments, tool output,
model reasoning or customer/employee ids. The backend enforces the same allowlist
(backend/services/agentTelemetry.js) and rejects anything else; names that would not pass its
patterns are dropped here so the rest of the event still arrives.

Event types and phases:
  AGENT_THINKING_EVENT       phase = turn_started | node_started | node_completed |
                             model_call_completed | model_call_failed | retrieval_completed |
                             turn_completed | turn_failed
  TOOL_EXECUTION_STARTED     tool_name, run_id
  TOOL_EXECUTION_COMPLETED   tool_name, run_id, status, duration_ms, result_chars

Retrieval relevance is reported only when the retriever puts a 0..1 score in each document's
metadata ("relevance_score", "similarity_score" or "score"); other score scales (raw distances)
are not comparable across stores and are left out rather than shown misleadingly.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.tracers.context import register_configure_hook

from app.services.backend_client import BackendInternalClient, BackendRejectedError, BackendUnavailableError

logger = logging.getLogger("ai_service.telemetry")

TELEMETRY_PATH = "/api/internal/agent-telemetry/events"

AGENT_THINKING_EVENT = "AGENT_THINKING_EVENT"
TOOL_EXECUTION_STARTED = "TOOL_EXECUTION_STARTED"
TOOL_EXECUTION_COMPLETED = "TOOL_EXECUTION_COMPLETED"

WORKFLOW_SUPPORT = "support"
WORKFLOW_REGULARIZATION = "regularization"

MAX_QUEUED_EVENTS = 2000
BATCH_SIZE = 100  # the backend accepts up to 200 per request
FLUSH_INTERVAL_SECONDS = 0.25
SHUTDOWN_FLUSH_SECONDS = 2.0
DROP_LOG_INTERVAL_SECONDS = 60.0

# Mirrors the backend's patterns (backend/services/agentTelemetry.js).
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
_MODEL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_./:-]{0,99}$")
_OBJECT_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{24}$")
_RELEVANCE_METADATA_KEYS = ("relevance_score", "similarity_score", "score")


def _identifier_or_none(candidate: Any) -> str | None:
    return candidate if isinstance(candidate, str) and _IDENTIFIER_PATTERN.match(candidate) else None


def _model_name_or_none(candidate: Any) -> str | None:
    return candidate if isinstance(candidate, str) and _MODEL_NAME_PATTERN.match(candidate) else None


def _elapsed_ms(started_monotonic: float) -> float:
    return round((time.monotonic() - started_monotonic) * 1000, 1)


# =================================================================================================
# Publisher: bounded queue and background batch delivery
# =================================================================================================


class TelemetryPublisher:
    """One per process. `publish` never blocks; `start` and `aclose` follow the app lifespan."""

    def __init__(self, backend_client: BackendInternalClient) -> None:
        self._backend_client = backend_client
        self._event_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_QUEUED_EVENTS)
        self._delivery_task: asyncio.Task[None] | None = None
        self._is_accepting = False
        self._dropped_since_last_log = 0
        self._last_drop_log_monotonic = 0.0
        self._last_failure_log_monotonic = 0.0

    def start(self) -> None:
        if self._delivery_task is None:
            self._is_accepting = True
            self._delivery_task = asyncio.create_task(self._deliver_forever(), name="agent-telemetry-delivery")

    def publish(self, telemetry_event: dict[str, Any]) -> None:
        if not self._is_accepting:
            return
        try:
            self._event_queue.put_nowait(telemetry_event)
        except asyncio.QueueFull:
            self._dropped_since_last_log += 1
            now_monotonic = time.monotonic()
            if now_monotonic - self._last_drop_log_monotonic >= DROP_LOG_INTERVAL_SECONDS:
                logger.warning("Telemetry queue full; events dropped", extra={"dropped_events": self._dropped_since_last_log})
                self._dropped_since_last_log = 0
                self._last_drop_log_monotonic = now_monotonic

    async def aclose(self) -> None:
        """Stops accepting events, flushes what is queued (bounded), and stops the delivery task."""
        self._is_accepting = False
        if self._delivery_task is None:
            return
        # Stop the background sender first so the flush below is the only sender (a batch it was
        # sending at that moment is lost, which best-effort delivery accepts).
        self._delivery_task.cancel()
        try:
            await self._delivery_task
        except asyncio.CancelledError:
            pass
        self._delivery_task = None
        try:
            async with asyncio.timeout(SHUTDOWN_FLUSH_SECONDS):
                while not self._event_queue.empty():
                    await self._send_batch(self._take_available(BATCH_SIZE))
        except TimeoutError:
            logger.warning("Telemetry flush on shutdown timed out", extra={"abandoned_events": self._event_queue.qsize()})

    def _take_available(self, max_events: int) -> list[dict[str, Any]]:
        taken_events: list[dict[str, Any]] = []
        while len(taken_events) < max_events and not self._event_queue.empty():
            taken_events.append(self._event_queue.get_nowait())
        return taken_events

    async def _deliver_forever(self) -> None:
        while True:
            batch = [await self._event_queue.get()]
            # Give the rest of a burst (one turn emits several events within milliseconds) a short
            # window to arrive, so it goes out in one request.
            batch_deadline = time.monotonic() + FLUSH_INTERVAL_SECONDS
            while len(batch) < BATCH_SIZE:
                remaining_seconds = batch_deadline - time.monotonic()
                if remaining_seconds <= 0:
                    break
                try:
                    batch.append(await asyncio.wait_for(self._event_queue.get(), remaining_seconds))
                except TimeoutError:
                    break
            await self._send_batch(batch)

    async def _send_batch(self, batch: list[dict[str, Any]]) -> None:
        if not batch:
            return
        try:
            delivery_result = await self._backend_client.post_json(TELEMETRY_PATH, {"events": batch})
        except (BackendUnavailableError, BackendRejectedError) as delivery_error:
            now_monotonic = time.monotonic()
            if now_monotonic - self._last_failure_log_monotonic >= DROP_LOG_INTERVAL_SECONDS:
                logger.warning("Telemetry batch not delivered", extra={"events": len(batch), "error": str(delivery_error)[:200]})
                self._last_failure_log_monotonic = now_monotonic
            return
        rejected_events = delivery_result.get("rejected") or []
        if rejected_events:
            # The backend refused part of the batch: a contract mismatch, so worth surfacing.
            logger.error("Telemetry events rejected by backend", extra={"rejected": rejected_events[:3]})


# =================================================================================================
# Per-turn callback handler
# =================================================================================================


class TurnTelemetryHandler(AsyncCallbackHandler):
    """
    Translates LangChain callbacks of one turn into telemetry events. Created by `telemetry_turn`;
    every method only records timing state and calls `_emit`, which never blocks or raises.
    """

    def __init__(self, publisher: TelemetryPublisher, *, workflow: str, conversation_id: str | None) -> None:
        self._publisher = publisher
        self.workflow = workflow
        self.conversation_id = conversation_id if conversation_id and _OBJECT_ID_PATTERN.match(conversation_id) else None
        self.turn_id = uuid.uuid4().hex
        self.route_decision: str | None = None
        self.model_call_count = 0
        self.tool_call_count = 0
        self._sequence = 0
        # run_id -> (node name or tool name or model name, started monotonic)
        self._node_runs: dict[UUID, tuple[str, float]] = {}
        self._model_runs: dict[UUID, tuple[str | None, str | None, float]] = {}
        self._tool_runs: dict[UUID, tuple[str, str | None, float]] = {}
        self._retriever_runs: dict[UUID, tuple[str | None, float]] = {}

    # ----------------------------------------------------------------------------------------------
    # Emission
    # ----------------------------------------------------------------------------------------------

    def _emit(
        self,
        event_type: str,
        *,
        phase: str | None = None,
        node: str | None = None,
        run_id: UUID | None = None,
        tool_name: str | None = None,
        status: str | None = None,
        error: BaseException | None = None,
        metrics: dict[str, Any] | None = None,
    ) -> None:
        try:
            telemetry_event = {
                "event_id": uuid.uuid4().hex,
                "event_type": event_type,
                "occurred_at": datetime.now(UTC).isoformat(),
                "workflow": self.workflow,
                "turn_id": self.turn_id,
                "sequence": self._sequence,
                "conversation_id": self.conversation_id,
                "node": _identifier_or_none(node),
                "phase": phase,
                "run_id": run_id.hex if run_id else None,
                "tool_name": _identifier_or_none(tool_name),
                "status": status,
                "error_type": _identifier_or_none(type(error).__name__) if error else None,
                "metrics": {metric_name: metric_value for metric_name, metric_value in (metrics or {}).items() if metric_value is not None},
            }
            self._sequence += 1
            self._publisher.publish(telemetry_event)
        except Exception:  # noqa: BLE001 - telemetry must never break a turn
            logger.debug("Telemetry event could not be built", exc_info=True)

    def emit_turn_started(self, transcript_messages: int | None) -> None:
        self._emit(AGENT_THINKING_EVENT, phase="turn_started", metrics={"transcript_messages": transcript_messages})

    def emit_turn_finished(self, started_monotonic: float, error: BaseException | None) -> None:
        self._emit(
            AGENT_THINKING_EVENT,
            phase="turn_failed" if error else "turn_completed",
            status="error" if error else "success",
            error=error,
            metrics={
                "duration_ms": _elapsed_ms(started_monotonic),
                "model_calls": self.model_call_count,
                "tool_calls": self.tool_call_count,
                "route_decision": _identifier_or_none(self.route_decision),
            },
        )

    # ----------------------------------------------------------------------------------------------
    # Graph nodes. LangGraph starts one chain run per node execution, named after the node and
    # tagged with metadata["langgraph_node"]; chains nested inside a node carry the same metadata
    # under a different name, which is how they are told apart.
    # ----------------------------------------------------------------------------------------------

    async def on_chain_start(
        self,
        serialized: dict[str, Any] | None,
        inputs: dict[str, Any],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        node_name = (metadata or {}).get("langgraph_node")
        if node_name and kwargs.get("name") == node_name:
            self._node_runs[run_id] = (node_name, time.monotonic())
            self._emit(AGENT_THINKING_EVENT, phase="node_started", node=node_name)

    async def on_chain_end(self, outputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        node_run = self._node_runs.pop(run_id, None)
        if node_run is None:
            return
        node_name, started_monotonic = node_run
        route_decision = outputs.get("next_worker") if isinstance(outputs, dict) else None
        if isinstance(route_decision, str):
            self.route_decision = route_decision
        self._emit(
            AGENT_THINKING_EVENT,
            phase="node_completed",
            node=node_name,
            status="success",
            metrics={"duration_ms": _elapsed_ms(started_monotonic), "route_decision": _identifier_or_none(route_decision)},
        )

    async def on_chain_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        node_run = self._node_runs.pop(run_id, None)
        if node_run is None:
            return
        node_name, started_monotonic = node_run
        self._emit(
            AGENT_THINKING_EVENT,
            phase="node_completed",
            node=node_name,
            status="error",
            error=error,
            metrics={"duration_ms": _elapsed_ms(started_monotonic)},
        )

    # ----------------------------------------------------------------------------------------------
    # Model calls
    # ----------------------------------------------------------------------------------------------

    async def on_chat_model_start(
        self,
        serialized: dict[str, Any] | None,
        messages: list[list[Any]],
        *,
        run_id: UUID,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        call_metadata = metadata or {}
        self._model_runs[run_id] = (call_metadata.get("langgraph_node"), call_metadata.get("ls_model_name"), time.monotonic())

    async def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        model_run = self._model_runs.pop(run_id, None)
        if model_run is None:
            return
        node_name, model_name, started_monotonic = model_run
        self.model_call_count += 1
        duration_ms = _elapsed_ms(started_monotonic)
        input_tokens, output_tokens = _token_usage(response)
        llm_output = getattr(response, "llm_output", None) or {}
        self._emit(
            AGENT_THINKING_EVENT,
            phase="model_call_completed",
            node=node_name,
            status="success",
            metrics={
                "duration_ms": duration_ms,
                "model_name": _model_name_or_none(llm_output.get("model_name") or model_name),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                # Generation speed as the caller experiences it (includes network and queueing).
                "tokens_per_second": round(output_tokens / (duration_ms / 1000), 1) if output_tokens and duration_ms > 0 else None,
            },
        )

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        model_run = self._model_runs.pop(run_id, None)
        if model_run is None:
            return
        node_name, model_name, started_monotonic = model_run
        self.model_call_count += 1
        self._emit(
            AGENT_THINKING_EVENT,
            phase="model_call_failed",
            node=node_name,
            status="error",
            error=error,
            metrics={"duration_ms": _elapsed_ms(started_monotonic), "model_name": _model_name_or_none(model_name)},
        )

    # ----------------------------------------------------------------------------------------------
    # Tools
    # ----------------------------------------------------------------------------------------------

    async def on_tool_start(
        self,
        serialized: dict[str, Any] | None,
        input_str: str,
        *,
        run_id: UUID,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        tool_name = kwargs.get("name") or (serialized or {}).get("name") or "unknown_tool"
        node_name = (metadata or {}).get("langgraph_node")
        self._tool_runs[run_id] = (tool_name, node_name, time.monotonic())
        self.tool_call_count += 1
        self._emit(TOOL_EXECUTION_STARTED, node=node_name, run_id=run_id, tool_name=tool_name)

    async def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        tool_run = self._tool_runs.pop(run_id, None)
        if tool_run is None:
            return
        tool_name, node_name, started_monotonic = tool_run
        result_content = getattr(output, "content", output)
        self._emit(
            TOOL_EXECUTION_COMPLETED,
            node=node_name,
            run_id=run_id,
            tool_name=tool_name,
            status="success",
            metrics={"duration_ms": _elapsed_ms(started_monotonic), "result_chars": len(str(result_content))},
        )

    async def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        tool_run = self._tool_runs.pop(run_id, None)
        if tool_run is None:
            return
        tool_name, node_name, started_monotonic = tool_run
        self._emit(
            TOOL_EXECUTION_COMPLETED,
            node=node_name,
            run_id=run_id,
            tool_name=tool_name,
            status="error",
            error=error,
            metrics={"duration_ms": _elapsed_ms(started_monotonic)},
        )

    # ----------------------------------------------------------------------------------------------
    # Retrievers (vector store searches)
    # ----------------------------------------------------------------------------------------------

    async def on_retriever_start(
        self,
        serialized: dict[str, Any] | None,
        query: str,
        *,
        run_id: UUID,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._retriever_runs[run_id] = ((metadata or {}).get("langgraph_node"), time.monotonic())

    async def on_retriever_end(self, documents: Sequence[Any], *, run_id: UUID, **kwargs: Any) -> None:
        retriever_run = self._retriever_runs.pop(run_id, None)
        if retriever_run is None:
            return
        node_name, started_monotonic = retriever_run
        relevance_scores = _relevance_scores(documents)
        self._emit(
            AGENT_THINKING_EVENT,
            phase="retrieval_completed",
            node=node_name,
            status="success",
            metrics={
                "duration_ms": _elapsed_ms(started_monotonic),
                "documents_returned": len(documents),
                "top_relevance_score": round(max(relevance_scores), 4) if relevance_scores else None,
                "mean_relevance_score": round(sum(relevance_scores) / len(relevance_scores), 4) if relevance_scores else None,
            },
        )

    async def on_retriever_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        retriever_run = self._retriever_runs.pop(run_id, None)
        if retriever_run is None:
            return
        node_name, started_monotonic = retriever_run
        self._emit(
            AGENT_THINKING_EVENT,
            phase="retrieval_completed",
            node=node_name,
            status="error",
            error=error,
            metrics={"duration_ms": _elapsed_ms(started_monotonic), "documents_returned": 0},
        )


def _token_usage(llm_result: Any) -> tuple[int | None, int | None]:
    """(input_tokens, output_tokens) from the first generation's usage metadata, if reported."""
    try:
        usage_metadata = llm_result.generations[0][0].message.usage_metadata or {}
    except (AttributeError, IndexError, TypeError):
        return None, None
    input_tokens = usage_metadata.get("input_tokens")
    output_tokens = usage_metadata.get("output_tokens")
    return (
        input_tokens if isinstance(input_tokens, int) and input_tokens >= 0 else None,
        output_tokens if isinstance(output_tokens, int) and output_tokens >= 0 else None,
    )


def _relevance_scores(documents: Sequence[Any]) -> list[float]:
    """0..1 relevance scores found in document metadata (see the module docstring)."""
    relevance_scores: list[float] = []
    for document in documents:
        document_metadata = getattr(document, "metadata", None) or {}
        for metadata_key in _RELEVANCE_METADATA_KEYS:
            candidate_score = document_metadata.get(metadata_key)
            if isinstance(candidate_score, (int, float)) and not isinstance(candidate_score, bool) and 0 <= candidate_score <= 1:
                relevance_scores.append(float(candidate_score))
                break
    return relevance_scores


# =================================================================================================
# Turn scope
# =================================================================================================

# The handler of the turn running in the current task; LangChain adds it to every run it
# configures while it is set (inheritable, so child runs receive it too).
_active_turn_handler: ContextVar[TurnTelemetryHandler | None] = ContextVar("agent_telemetry_turn_handler", default=None)
register_configure_hook(_active_turn_handler, True)


@asynccontextmanager
async def telemetry_turn(
    publisher: TelemetryPublisher | None,
    *,
    workflow: str,
    conversation_id: str | None = None,
    transcript_messages: int | None = None,
) -> AsyncIterator[TurnTelemetryHandler | None]:
    """
    Reports one turn: turn_started on entry, then everything LangChain runs inside, then
    turn_completed or turn_failed (with the exception's class name) on exit. Yields the handler so
    the caller can record the outcome (`handler.route_decision`), or None when telemetry is off.
    Exceptions are re-raised unchanged.
    """
    if publisher is None:
        yield None
        return
    turn_handler = TurnTelemetryHandler(publisher, workflow=workflow, conversation_id=conversation_id)
    context_token = _active_turn_handler.set(turn_handler)
    started_monotonic = time.monotonic()
    turn_handler.emit_turn_started(transcript_messages)
    try:
        yield turn_handler
    except BaseException as turn_error:
        turn_handler.emit_turn_finished(started_monotonic, turn_error)
        raise
    else:
        turn_handler.emit_turn_finished(started_monotonic, None)
    finally:
        _active_turn_handler.reset(context_token)
