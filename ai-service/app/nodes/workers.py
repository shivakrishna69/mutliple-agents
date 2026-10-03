"""
Worker nodes that write customer replies: tech_worker_node, billing_worker_node, and
supervisor_response_node (general questions, no tools).

=================================================================================================
Tool execution pathway (run_worker_turn)
=================================================================================================

  1. Model evaluation      Build [SystemMessage(worker prompt), *recent transcript] and call the
                           worker model.
  2. Dynamic tool binding  The worker's tools are bound to the model for this call only
                           (`worker_model.bind_tools(tools)`), so the shared model in the runtime
                           context stays tool-free and each worker exposes only its own tools.
  3. Execution intercept   If the reply contains tool calls, the node executes them itself:
                           look the tool up by name (only this worker's tools are reachable),
                           validate the arguments, inject server-side arguments the model must
                           never control (the customer id), run the tool, and wrap the result in a
                           ToolMessage tied to the call id.
  4. State update          The AIMessage carrying the tool calls and the ToolMessages are appended
                           to the working message list, and the model is invoked again to write the
                           answer from the results. Up to MAX_TOOL_ROUNDS rounds; after that one
                           more call is made with tool_choice="none", so the model must answer.
  5. Control yielding      The final text passes through the output guard. The node returns
                           messages [tool-call AIMessages, ToolMessages, final AIMessage] and its
                           log entries. Every path then reaches END, and the next customer message
                           starts again at START -> supervisor, so the supervisor re-routes every
                           turn. `next_worker` keeps naming this worker on success (the backend
                           records it as the conversation's active worker and attributes the reply
                           to it); it is overwritten with "human" only when the node hands off.

=================================================================================================
Failure handling
=================================================================================================

  Recoverable, the model can fix it    Unknown tool name or invalid arguments: an error
                                       ToolMessage is returned to the model, which can retry or
                                       answer without the data (counts toward MAX_TOOL_ROUNDS).
  Not recoverable, hand off to human   A tool that fails while running (ToolExecutionError, or any
                                       unexpected exception from a tool), a model call that fails,
                                       or an empty final reply. The node returns the human handoff
                                       message with next_worker = "human", and the backend
                                       escalates the conversation.
  Cancellation                         asyncio.CancelledError (the turn deadline) is a
                                       BaseException and is never caught, so timeouts still abort.

=================================================================================================
Simulated tools
=================================================================================================

query_system_logs and check_invoice_status return deterministic simulated data, marked
"data_source": "simulated" in every result. The service refuses to start in production with
SIMULATED_TOOLS_ENABLED=true (see config.py), so simulated data can never reach real customers.
Replacing them with real integrations only requires changing the two tool bodies; their names,
argument schemas, and result shapes are the contract the prompts and the pathway rely on.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Any

from langchain_core.messages import AIMessage, BaseMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, InjectedToolArg, ToolException, tool
from langgraph.runtime import Runtime
from pydantic import ValidationError

from app.guards.output_guard import GuardOutcome, validate_and_sanitize_output
from app.nodes.context import AgentContext
from app.nodes.policies import HUMAN_HANDOFF_REPLY, SHARED_POLICY_PROMPT
from app.schemas import MESSAGE_CONTENT_MAX_LENGTH

logger = logging.getLogger("ai_service.workers")

TECH_WORKER_NODE_NAME = "tech_agent"
BILLING_WORKER_NODE_NAME = "billing_agent"
SUPERVISOR_RESPONSE_NODE_NAME = "supervisor_response"
OUTPUT_GUARD_LOG_PREFIX = "output_guard"
HUMAN_WORKER = "human"

# Tool-calling rounds before the model is required to answer (tool_choice="none").
MAX_TOOL_ROUNDS = 2
# Tool results are truncated to this many characters before going back to the model.
MAX_TOOL_RESULT_CHARACTERS = 4_000
SIMULATED_DATA_SOURCE = "simulated"


class ToolExecutionError(Exception):
    """A tool could not complete (backend unavailable, missing identity). Not recoverable by the model."""


class EmptyWorkerReplyError(Exception):
    """The model finished without any reply text."""


# =================================================================================================
# Simulated tool backends
# =================================================================================================

# Error codes: uppercase letters, digits, and underscores, as written in API error responses.
ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")

# What the cluster logging service knows about each error code.
SYSTEM_LOG_CATALOG: dict[str, dict[str, Any]] = {
    "ERR_502_GATEWAY": {
        "service": "api-gateway",
        "http_status": 502,
        "sample_log_line": "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
        "probable_cause": "An upstream service instance was restarting and briefly refused connections.",
        "customer_steps": ["Retry the request after a few seconds.", "If it persists for more than 10 minutes, share the request ID and timestamp."],
        "incident_open": False,
    },
    "ERR_401_UNAUTHORIZED": {
        "service": "auth-service",
        "http_status": 401,
        "sample_log_line": "token verification failed: signature expired",
        "probable_cause": "The access token or API key used for the request has expired or was revoked.",
        "customer_steps": ["Sign out and sign in again.", "For API access, generate a new API key and update the integration."],
        "incident_open": False,
    },
    "ERR_403_FORBIDDEN": {
        "service": "auth-service",
        "http_status": 403,
        "sample_log_line": "permission denied: role lacks scope 'billing:read'",
        "probable_cause": "The signed-in user's role does not include the permission this action needs.",
        "customer_steps": ["Ask a workspace admin to grant the required role.", "Confirm you are signed in to the correct workspace."],
        "incident_open": False,
    },
    "ERR_429_RATE_LIMITED": {
        "service": "api-gateway",
        "http_status": 429,
        "sample_log_line": "rate limit exceeded: 600 requests/minute for key prefix pk_live",
        "probable_cause": "The client sent more requests than the plan's rate limit allows.",
        "customer_steps": ["Add exponential backoff and respect the Retry-After header.", "Batch requests where the API supports it."],
        "incident_open": False,
    },
    "ERR_500_INTERNAL": {
        "service": "core-api",
        "http_status": 500,
        "sample_log_line": "unhandled exception in request handler: NullReferenceError at InvoiceRenderer.render",
        "probable_cause": "An unexpected server-side error; engineering is alerted automatically for this signature.",
        "customer_steps": ["Retry once.", "If it repeats, share the request ID and the exact steps that trigger it."],
        "incident_open": True,
    },
    "ERR_503_UNAVAILABLE": {
        "service": "core-api",
        "http_status": 503,
        "sample_log_line": "service unavailable: database connection pool exhausted",
        "probable_cause": "The service was temporarily overloaded.",
        "customer_steps": ["Wait a few minutes and retry.", "Check the status page for an ongoing incident."],
        "incident_open": True,
    },
    "ERR_504_TIMEOUT": {
        "service": "api-gateway",
        "http_status": 504,
        "sample_log_line": "upstream request timeout after 30000ms",
        "probable_cause": "A long-running request (often a large export) exceeded the 30-second gateway limit.",
        "customer_steps": ["Narrow the date range or use the asynchronous export option.", "Retry outside peak hours."],
        "incident_open": False,
    },
}

PLAN_CATALOG = (
    {"plan": "Starter", "monthly_price": 19.00},
    {"plan": "Pro", "monthly_price": 49.00},
    {"plan": "Business", "monthly_price": 199.00},
)


def _deterministic_seed(*seed_parts: str) -> int:
    """Stable integer from the inputs, so the same question always gets the same simulated answer."""
    return int(hashlib.sha256("|".join(seed_parts).encode("utf-8")).hexdigest()[:12], 16)


def _first_day_of_month_offset(reference_date: date, months_back: int) -> date:
    """The first day of the month `months_back` months before reference_date's month (0 = same month)."""
    month_index = reference_date.year * 12 + (reference_date.month - 1) - months_back
    return date(month_index // 12, month_index % 12 + 1, 1)


def _normalize_error_code(raw_error_code: str) -> str:
    return re.sub(r"[\s\-]+", "_", raw_error_code.strip()).upper()


@tool
def query_system_logs(error_code: str) -> str:
    """Look up recent server-side log entries for an error code the customer reported, such as
    ERR_502_GATEWAY or ERR_401_UNAUTHORIZED. Returns how often it occurred in the last 24 hours,
    a sample log line, the probable cause, whether an incident is open, and steps the customer can take."""
    normalized_error_code = _normalize_error_code(error_code)
    if not ERROR_CODE_PATTERN.match(normalized_error_code):
        return json.dumps(
            {
                "found": False,
                "error_code": normalized_error_code[:64],
                "message": "Not a valid error code format. Error codes look like ERR_502_GATEWAY.",
                "data_source": SIMULATED_DATA_SOURCE,
            }
        )

    log_entry = SYSTEM_LOG_CATALOG.get(normalized_error_code)
    if log_entry is None:
        return json.dumps(
            {
                "found": False,
                "error_code": normalized_error_code,
                "message": "No log entries for this error code in the last 24 hours.",
                "known_error_codes": sorted(SYSTEM_LOG_CATALOG),
                "data_source": SIMULATED_DATA_SOURCE,
            }
        )

    today = date.today()
    seed = _deterministic_seed(normalized_error_code, today.isoformat())
    occurrences_last_24_hours = 3 + seed % 480
    return json.dumps(
        {
            "found": True,
            "error_code": normalized_error_code,
            "service": log_entry["service"],
            "http_status": log_entry["http_status"],
            "occurrences_last_24_hours": occurrences_last_24_hours,
            "last_seen_minutes_ago": 1 + seed % 55,
            "sample_log_line": log_entry["sample_log_line"],
            "probable_cause": log_entry["probable_cause"],
            "incident_open": log_entry["incident_open"],
            "customer_steps": log_entry["customer_steps"],
            "data_source": SIMULATED_DATA_SOURCE,
        }
    )


@tool
def check_invoice_status(user_id: Annotated[str, InjectedToolArg]) -> str:
    """Look up the current customer's subscription plan and standing, their three most recent
    invoices, and any pending balance in the billing ledger. Takes no arguments: the customer is
    identified automatically from the conversation."""
    # `user_id` is an InjectedToolArg: it is absent from the schema the model sees and is always
    # supplied by the server (execute_tool_call), so a customer cannot query another account.
    if not user_id:
        raise ToolExecutionError("customer identity is not available for this conversation")

    seed = _deterministic_seed(user_id)
    plan = PLAN_CATALOG[seed % len(PLAN_CATALOG)]
    has_failed_latest_payment = seed % 5 == 0
    has_duplicate_charge = seed % 7 == 0

    today = date.today()
    recent_invoices = []
    for months_ago in range(3):
        invoice_date = _first_day_of_month_offset(today, months_ago)
        invoice_status = "payment_failed" if months_ago == 0 and has_failed_latest_payment else "paid"
        recent_invoices.append(
            {
                "invoice_id": f"INV-{invoice_date:%Y%m}-{seed % 9000 + 1000}",
                "issued_on": invoice_date.isoformat(),
                "amount": plan["monthly_price"],
                "currency": "USD",
                "status": invoice_status,
                "charges_recorded": 2 if months_ago == 0 and has_duplicate_charge else 1,
            }
        )

    pending_balance = plan["monthly_price"] if has_failed_latest_payment else 0.0
    return json.dumps(
        {
            "subscription": {
                "plan": plan["plan"],
                "status": "past_due" if has_failed_latest_payment else "active",
                "renews_on": _first_day_of_month_offset(today, -1).isoformat(),
            },
            "recent_invoices": recent_invoices,
            "pending_balance": pending_balance,
            "currency": "USD",
            "data_source": SIMULATED_DATA_SOURCE,
        }
    )


# =================================================================================================
# Prompts
# =================================================================================================

TECH_WORKER_SYSTEM_PROMPT = (
    "You are the technical support specialist. Diagnose system errors, API failures, and integration bugs step by step. "
    "Ask for the exact error message or code, the device or client, and what the customer was doing when it happened, and "
    "give numbered troubleshooting steps the customer can follow. "
    + SHARED_POLICY_PROMPT
)
TECH_WORKER_TOOL_INSTRUCTIONS = (
    " When the customer mentions an error code (for example ERR_502_GATEWAY), call query_system_logs with that code and "
    "base your diagnosis on the result: explain the probable cause in plain language and give the listed customer steps. "
    "If an incident is open, say the team is already aware of the issue. Never show raw log lines or internal service names."
)

BILLING_WORKER_SYSTEM_PROMPT = (
    "You are the billing and invoice dispute specialist. Explain invoices, charges, payment status, subscriptions, and "
    "pricing clearly. Strict rule: you cannot change anything. Never promise or imply a refund, credit, cancellation, "
    "plan change, or any manual correction, and never say one is being or will be done; instead explain what the records "
    "show and that a member of the billing team can review requests to change anything. "
    + SHARED_POLICY_PROMPT
)
BILLING_WORKER_TOOL_INSTRUCTIONS = (
    " To answer questions about this customer's own invoices, payments, plan, or balance, call check_invoice_status "
    "(it takes no arguments and only ever returns this customer's records). Report what the records show in the form "
    "'our records show ...', with dates and amounts exactly as returned. If the records show two charges for one invoice, "
    "acknowledge it and explain that the billing team can review it."
)

SUPERVISOR_RESPONSE_SYSTEM_PROMPT = (
    "You are the support team lead answering general questions. Greet the customer, answer general questions, "
    "and ask a clarifying question when the request is unclear. "
    + SHARED_POLICY_PROMPT
)


@dataclass(frozen=True)
class WorkerProfile:
    """Everything that distinguishes one worker: its node name, prompt, and tools."""

    node_name: str
    system_prompt: str
    tool_instructions: str
    tools: tuple[BaseTool, ...]

    def resolved_tools(self, simulated_tools_enabled: bool) -> tuple[BaseTool, ...]:
        return self.tools if simulated_tools_enabled else ()

    def resolved_system_prompt(self, simulated_tools_enabled: bool) -> str:
        return self.system_prompt + (self.tool_instructions if self.resolved_tools(simulated_tools_enabled) else "")


TECH_WORKER_PROFILE = WorkerProfile(TECH_WORKER_NODE_NAME, TECH_WORKER_SYSTEM_PROMPT, TECH_WORKER_TOOL_INSTRUCTIONS, (query_system_logs,))
BILLING_WORKER_PROFILE = WorkerProfile(BILLING_WORKER_NODE_NAME, BILLING_WORKER_SYSTEM_PROMPT, BILLING_WORKER_TOOL_INSTRUCTIONS, (check_invoice_status,))
SUPERVISOR_RESPONSE_PROFILE = WorkerProfile(SUPERVISOR_RESPONSE_NODE_NAME, SUPERVISOR_RESPONSE_SYSTEM_PROMPT, "", ())

# Arguments the server always supplies itself, per tool, and the state key each one comes from.
SERVER_INJECTED_TOOL_ARGUMENTS: dict[str, dict[str, str]] = {
    check_invoice_status.name: {"user_id": "customer_id"},
}


# =================================================================================================
# Pathway helpers
# =================================================================================================


def extract_reply_text(model_reply: BaseMessage) -> str:
    reply_content = model_reply.content
    if isinstance(reply_content, str):
        return reply_content.strip()
    if isinstance(reply_content, list):
        return "".join(
            content_block.get("text", "") if isinstance(content_block, dict) else str(content_block)
            for content_block in reply_content
        ).strip()
    return ""


def _token_usage(model_reply: BaseMessage) -> dict[str, int]:
    usage_metadata = getattr(model_reply, "usage_metadata", None) or {}
    return {key: usage_metadata[key] for key in ("input_tokens", "output_tokens", "total_tokens") if isinstance(usage_metadata.get(key), int)}


def _error_tool_message(tool_call_id: str, tool_name: str, error_description: str) -> ToolMessage:
    return ToolMessage(
        content=json.dumps({"error": error_description}),
        tool_call_id=tool_call_id,
        name=tool_name,
        status="error",
    )


async def execute_tool_call(
    tool_call: dict[str, Any],
    tools_by_name: dict[str, BaseTool],
    state: dict[str, Any],
    node_name: str,
) -> tuple[ToolMessage, str]:
    """
    Step 3 of the pathway: runs one tool call and returns (ToolMessage, internal log entry).

    Unknown tools and invalid arguments become error ToolMessages the model can react to.
    A tool that fails while running raises ToolExecutionError, which ends the turn with a handoff.
    """
    tool_name = str(tool_call.get("name", ""))
    tool_call_id = str(tool_call.get("id") or f"call-{uuid.uuid4().hex}")
    model_arguments = tool_call.get("args")

    selected_tool = tools_by_name.get(tool_name)
    if selected_tool is None:
        return (
            _error_tool_message(tool_call_id, tool_name, f"Unknown tool '{tool_name}'. Available: {sorted(tools_by_name)}"),
            f"{node_name}: rejected call to unknown tool '{tool_name[:40]}'",
        )
    if not isinstance(model_arguments, dict):
        return (
            _error_tool_message(tool_call_id, tool_name, "Tool arguments must be a JSON object."),
            f"{node_name}: rejected {tool_name} call with non-object arguments",
        )

    # Server-side arguments: always taken from state, never from the model. A value the model
    # supplied anyway is discarded and logged, since it may be an attempt to reach another account.
    tool_arguments = dict(model_arguments)
    for argument_name, state_key in SERVER_INJECTED_TOOL_ARGUMENTS.get(tool_name, {}).items():
        if argument_name in tool_arguments:
            logger.warning(
                "Discarded model-supplied value for a server-injected tool argument",
                extra={"node": node_name, "tool": tool_name, "argument": argument_name},
            )
        tool_arguments[argument_name] = str(state.get(state_key) or "")

    started_at = time.perf_counter()
    try:
        tool_result = await selected_tool.ainvoke(tool_arguments)
    except (ValidationError, ToolException, TypeError) as argument_error:
        return (
            _error_tool_message(tool_call_id, tool_name, f"Invalid arguments: {str(argument_error)[:300]}"),
            f"{node_name}: {tool_name} rejected invalid arguments",
        )
    except ToolExecutionError:
        raise
    except Exception as unexpected_tool_error:
        raise ToolExecutionError(f"{tool_name} failed: {type(unexpected_tool_error).__name__}") from unexpected_tool_error

    duration_ms = round((time.perf_counter() - started_at) * 1000, 1)
    result_text = str(tool_result)[:MAX_TOOL_RESULT_CHARACTERS]
    logger.info("Tool executed", extra={"node": node_name, "tool": tool_name, "result_length": len(result_text), "duration_ms": duration_ms})
    visible_arguments = {key: value for key, value in model_arguments.items() if key not in SERVER_INJECTED_TOOL_ARGUMENTS.get(tool_name, {})}
    return (
        ToolMessage(content=result_text, tool_call_id=tool_call_id, name=tool_name, status="success"),
        f"{node_name}: called {tool_name}({json.dumps(visible_arguments)[:120]}) -> {len(result_text)} chars in {duration_ms} ms",
    )


def build_handoff_update(node_name: str, failure_category: str, failure_detail: str, log_entries: list[str]) -> dict[str, Any]:
    """
    Fallback state update: hand the conversation to a human. Overwrites next_worker with "human",
    which routes nothing further this turn (every worker edge goes to END) and tells the backend
    to escalate.
    """
    logger.warning(
        "Worker handed off to a human",
        extra={"node": node_name, "failure_category": failure_category, "failure_detail": failure_detail[:300]},
    )
    return {
        "messages": [AIMessage(content=HUMAN_HANDOFF_REPLY, id=f"ai-{uuid.uuid4().hex}")],
        "next_worker": HUMAN_WORKER,
        "internal_logs": [*log_entries, f"{node_name}: handed off to a human ({failure_category}: {failure_detail[:200]})"],
    }


def build_guarded_reply_update(
    node_name: str,
    generated_text: str,
    tool_exchange_messages: list[BaseMessage],
    log_entries: list[str],
) -> dict[str, Any]:
    """
    Step 5 of the pathway: applies the output guard to the final text and builds the state update.
    PASSED / SANITIZED keep next_worker unchanged; ESCALATED hands off to a human.
    """
    guard_result = validate_and_sanitize_output(generated_text)
    guard_log_entry = f"{OUTPUT_GUARD_LOG_PREFIX}: {node_name} reply {guard_result.describe()}"
    if guard_result.outcome is not GuardOutcome.PASSED:
        logger.warning(
            "Output guard intervened",
            extra={
                "node": node_name,
                "guard_outcome": guard_result.outcome.value,
                "removed_sentences": guard_result.removed_sentence_count,
                "violation_categories": sorted({violation.category.value for violation in guard_result.violations}),
                "violation_patterns": sorted({violation.pattern_id for violation in guard_result.violations}),
            },
        )

    if guard_result.outcome is GuardOutcome.ESCALATED:
        return {
            "messages": [*tool_exchange_messages, AIMessage(content=HUMAN_HANDOFF_REPLY, id=f"ai-{uuid.uuid4().hex}")],
            "next_worker": HUMAN_WORKER,
            "internal_logs": [*log_entries, guard_log_entry],
        }

    reply_text = guard_result.final_text[:MESSAGE_CONTENT_MAX_LENGTH]
    # A fresh AIMessage keeps only what the transcript needs; provider metadata is not checkpointed.
    return {
        "messages": [*tool_exchange_messages, AIMessage(content=reply_text, id=f"ai-{uuid.uuid4().hex}")],
        "internal_logs": [*log_entries, guard_log_entry],
    }


async def run_worker_turn(profile: WorkerProfile, state: dict[str, Any], runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """The tool execution pathway shared by every worker (see the module docstring, steps 1-5)."""
    agent_context = runtime.context
    started_at = time.perf_counter()
    available_tools = profile.resolved_tools(agent_context.simulated_tools_enabled)
    tools_by_name = {available_tool.name: available_tool for available_tool in available_tools}

    # Step 1: model input = worker prompt + recent transcript. The system prompt is built per call
    # and never stored in state.
    recent_transcript = list(state.get("messages", []))[-agent_context.max_context_messages :]
    model_input: list[BaseMessage] = [
        SystemMessage(content=profile.resolved_system_prompt(agent_context.simulated_tools_enabled)),
        *recent_transcript,
    ]

    # Step 2: dynamic tool binding. One binding offers the tools; the other forbids calling them,
    # used for the final answer once the round budget is spent.
    if available_tools:
        model_offering_tools = agent_context.worker_model.bind_tools(list(available_tools))
        model_answering_only = agent_context.worker_model.bind_tools(list(available_tools), tool_choice="none")
    else:
        model_offering_tools = model_answering_only = agent_context.worker_model

    tool_exchange_messages: list[BaseMessage] = []
    log_entries: list[str] = []
    tool_rounds_used = 0
    output_tokens_total = 0

    try:
        while True:
            tools_offered = bool(available_tools) and tool_rounds_used < MAX_TOOL_ROUNDS
            active_model = model_offering_tools if tools_offered else model_answering_only
            model_reply = await active_model.ainvoke([*model_input, *tool_exchange_messages])
            output_tokens_total += _token_usage(model_reply).get("output_tokens", 0)

            requested_tool_calls = getattr(model_reply, "tool_calls", None) or []
            if not tools_offered or not requested_tool_calls:
                break

            # Steps 3-4: intercept the tool calls, execute them, and append the call and its
            # results to the working message list before the next model evaluation.
            tool_rounds_used += 1
            tool_exchange_messages.append(model_reply)
            for requested_tool_call in requested_tool_calls:
                tool_message, tool_log_entry = await execute_tool_call(requested_tool_call, tools_by_name, state, profile.node_name)
                tool_exchange_messages.append(tool_message)
                log_entries.append(tool_log_entry)

        generated_text = extract_reply_text(model_reply)
        if not generated_text:
            raise EmptyWorkerReplyError(f"{profile.node_name} returned no reply text")
    # ---------------------------------------------------------------------------------------------
    # Fallbacks. Each ends the turn with the human handoff message; see "Failure handling" above.
    # ---------------------------------------------------------------------------------------------
    except ToolExecutionError as tool_failure:
        return build_handoff_update(profile.node_name, "tool_execution_failed", str(tool_failure), log_entries)
    except EmptyWorkerReplyError as empty_reply_failure:
        return build_handoff_update(profile.node_name, "empty_reply", str(empty_reply_failure), log_entries)
    except Exception as model_failure:  # noqa: BLE001 - any model failure must hand off, never crash the turn
        return build_handoff_update(
            profile.node_name,
            "model_invocation_failed",
            f"{type(model_failure).__name__}: {str(model_failure)[:200]}",
            log_entries,
        )

    duration_ms = round((time.perf_counter() - started_at) * 1000, 1)
    log_entries.append(
        f"{profile.node_name}: generated reply ({len(generated_text)} chars, {duration_ms} ms, "
        f"{tool_rounds_used} tool round(s), {output_tokens_total} output tokens)"
    )
    logger.info(
        "Worker reply generated",
        extra={
            "node": profile.node_name,
            "reply_length": len(generated_text),
            "tool_rounds": tool_rounds_used,
            "output_tokens": output_tokens_total,
            "duration_ms": duration_ms,
        },
    )
    return build_guarded_reply_update(profile.node_name, generated_text, tool_exchange_messages, log_entries)


# =================================================================================================
# Nodes
# =================================================================================================


async def tech_worker_node(state: dict[str, Any], runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """Diagnoses technical errors; may call query_system_logs."""
    return await run_worker_turn(TECH_WORKER_PROFILE, state, runtime)


async def billing_worker_node(state: dict[str, Any], runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """Explains invoices and payment status; may call check_invoice_status for the current customer only."""
    return await run_worker_turn(BILLING_WORKER_PROFILE, state, runtime)


async def supervisor_response_node(state: dict[str, Any], runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """General questions the supervisor answers itself (FINISH); no tools."""
    return await run_worker_turn(SUPERVISOR_RESPONSE_PROFILE, state, runtime)
