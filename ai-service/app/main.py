"""
ai-service HTTP entry point.

Run:
    uvicorn app.main:app --host 0.0.0.0 --port 8000        (from the ai-service directory)

Endpoints
    GET  /health      Liveness/readiness. 200 when the LLM is configured, 503 "degraded" otherwise.
                      Unauthenticated so orchestrators can probe it; exposes no conversation data.
    POST /ai/process  One conversation turn (see schemas.py for the contract). Requires the
                      X-Internal-Api-Key header to equal AI_SERVICE_API_KEY.

Request lifecycle for POST /ai/process
    1. Middleware assigns/propagates X-Request-Id and logs the request when it completes.
    2. `require_internal_api_key` rejects calls without the shared key (401), compared in
       constant time, before the body is used.
    3. FastAPI validates the body against ConversationInput (422 on failure, no model call).
    4. `convert_to_langchain_messages` maps each {message_id, role, content} to a LangChain message
       primitive carrying the same id: user -> HumanMessage, assistant -> AIMessage. SystemMessages
       are not accepted from callers; the graph's nodes add their own per call.
    5. AgentRuntime.process_conversation runs the LangGraph turn under the thread's lock, with the
       checkpointer thread key = thread_id or conversation_id, and a hard deadline.
    6. The reply, next worker, and this turn's audit log are returned as AIProcessResponse.

Error mapping (body is always { "error": { message, requestId, details? } }):
    401 missing/invalid internal key        422 invalid body
    503 GROQ_API_KEY not set, or Groq rate limited (with Retry-After when Groq provided one)
    502 Groq unreachable / failed / rejected the key, or the model returned unusable output
    504 the turn exceeded AI_PROCESS_TIMEOUT_SECONDS
    500 anything unexpected (logged with traceback; details hidden in production)
The backend treats every non-2xx answer as "AI unavailable" and escalates the conversation to a
human, so these codes are for observability; none of them loses a customer message.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import sys
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

from app.agent import (
    AgentRuntime,
    AgentTimeoutError,
    InvalidModelOutputError,
    LLMNotConfiguredError,
    LLMUpstreamError,
)
from app.config import ConfigurationError, Settings
from app.logging_config import configure_logging
from app.schemas import AIProcessResponse, ChatRole, ConversationInput, ConversationMessage, ErrorResponse

# ---------------------------------------------------------------------------------------------
# Configuration and logging (fail fast on invalid configuration)
# ---------------------------------------------------------------------------------------------

try:
    settings = Settings.from_environment()
except ConfigurationError as configuration_error:
    configure_logging("INFO")
    logging.getLogger("ai_service").critical("Invalid configuration", extra={"error": str(configuration_error)})
    sys.exit(1)

configure_logging(settings.log_level)
logger = logging.getLogger("ai_service")

INTERNAL_API_KEY_HEADER = "X-Internal-Api-Key"
REQUEST_ID_HEADER = "X-Request-Id"
THREAD_EVICTION_INTERVAL_SECONDS = 60


# ---------------------------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------------------------


class ServiceError(Exception):
    """An expected failure with a status code and a message that is safe to return."""

    def __init__(self, status_code: int, message: str, *, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.headers = headers


def build_error_body(request: Request, message: str, details: Any = None) -> dict[str, Any]:
    error_detail: dict[str, Any] = {"message": message, "requestId": getattr(request.state, "request_id", None)}
    if details is not None:
        error_detail["details"] = details
    return {"error": error_detail}


# ---------------------------------------------------------------------------------------------
# Lifespan: runtime and background eviction
# ---------------------------------------------------------------------------------------------


async def run_thread_eviction_loop(agent_runtime: AgentRuntime) -> None:
    """Deletes idle conversation threads from the checkpointer once a minute until cancelled."""
    while True:
        await asyncio.sleep(THREAD_EVICTION_INTERVAL_SECONDS)
        try:
            evicted_thread_count = await agent_runtime.thread_registry.evict_idle_threads()
            if evicted_thread_count:
                logger.info(
                    "Idle threads evicted",
                    extra={"evicted_threads": evicted_thread_count, "tracked_threads": agent_runtime.thread_registry.tracked_thread_count},
                )
        except Exception:  # noqa: BLE001 - one failed sweep must not stop future sweeps
            logger.exception("Thread eviction sweep failed")


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    agent_runtime = AgentRuntime(settings)
    application.state.agent_runtime = agent_runtime
    eviction_task = asyncio.create_task(run_thread_eviction_loop(agent_runtime), name="thread-eviction")

    if agent_runtime.is_llm_configured:
        logger.info("ai-service started", extra={"env": settings.environment, "model": settings.groq_model})
    else:
        logger.warning("ai-service started without GROQ_API_KEY; /ai/process will answer 503", extra={"env": settings.environment})

    try:
        yield
    finally:
        eviction_task.cancel()
        try:
            await eviction_task
        except asyncio.CancelledError:
            pass
        logger.info("ai-service stopped")


app = FastAPI(
    title="ai-service",
    version="1.0.0",
    description="Multi-agent customer support runtime: a LangGraph supervisor routes each customer message "
    "to billing, technical, or general support workers backed by Groq, or escalates to a human.",
    lifespan=lifespan,
    # Internal service: interactive docs are only served outside production.
    docs_url="/docs" if settings.environment != "production" else None,
    redoc_url=None,
    openapi_url="/openapi.json" if settings.environment != "production" else None,
)


# ---------------------------------------------------------------------------------------------
# Middleware and exception handlers
# ---------------------------------------------------------------------------------------------


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Propagates X-Request-Id from the backend (or creates one) and logs each request once."""
    incoming_request_id = request.headers.get(REQUEST_ID_HEADER, "")
    request_id = incoming_request_id if 0 < len(incoming_request_id) <= 200 else str(uuid.uuid4())
    request.state.request_id = request_id
    started_at = time.perf_counter()

    response = await call_next(request)

    response.headers[REQUEST_ID_HEADER] = request_id
    log_level = logging.ERROR if response.status_code >= 500 else logging.WARNING if response.status_code >= 400 else logging.INFO
    logger.log(
        log_level,
        "request completed",
        extra={
            "requestId": request_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "durationMs": round((time.perf_counter() - started_at) * 1000, 2),
        },
    )
    return response


@app.exception_handler(ServiceError)
async def handle_service_error(request: Request, service_error: ServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=service_error.status_code,
        content=build_error_body(request, service_error.message),
        headers=service_error.headers,
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, validation_error: RequestValidationError) -> JSONResponse:
    """422 with field-level details. Input values are not echoed back, since they may contain customer text."""
    validation_details = [
        {"loc": list(error_entry.get("loc", [])), "message": error_entry.get("msg"), "type": error_entry.get("type")}
        for error_entry in validation_error.errors()
    ]
    logger.warning(
        "Request validation failed",
        extra={"requestId": getattr(request.state, "request_id", None), "fields": [detail["loc"] for detail in validation_details]},
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content=build_error_body(request, "Validation failed", validation_details),
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, unexpected_error: Exception) -> JSONResponse:
    logger.exception(
        "Unhandled error",
        extra={"requestId": getattr(request.state, "request_id", None), "path": request.url.path},
    )
    message = str(unexpected_error) if settings.environment != "production" else "Internal server error"
    return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=build_error_body(request, message))


# ---------------------------------------------------------------------------------------------
# Dependencies and mapping helpers
# ---------------------------------------------------------------------------------------------


async def require_internal_api_key(request: Request) -> None:
    """Allows the request only if X-Internal-Api-Key equals AI_SERVICE_API_KEY (constant-time compare)."""
    presented_api_key = request.headers.get(INTERNAL_API_KEY_HEADER, "")
    if not hmac.compare_digest(presented_api_key.encode("utf-8"), settings.internal_api_key.encode("utf-8")):
        logger.warning(
            "Rejected request with missing or invalid internal API key",
            extra={"requestId": getattr(request.state, "request_id", None), "path": request.url.path},
        )
        raise ServiceError(status.HTTP_401_UNAUTHORIZED, "Missing or invalid internal API key")


def convert_to_langchain_messages(conversation_messages: list[ConversationMessage]) -> list[BaseMessage]:
    """
    Maps validated transcript entries to LangChain message primitives, keeping each message's id
    so the `add_messages` reducer can identify it:
        user      -> HumanMessage   (the customer)
        assistant -> AIMessage      (AI workers and human agents answering for the company)
    """
    langchain_messages: list[BaseMessage] = []
    for conversation_message in conversation_messages:
        if conversation_message.role is ChatRole.USER:
            langchain_messages.append(HumanMessage(content=conversation_message.content, id=conversation_message.message_id))
        else:
            langchain_messages.append(AIMessage(content=conversation_message.content, id=conversation_message.message_id))
    return langchain_messages


# ---------------------------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------------------------

ERROR_RESPONSES = {
    status_code: {"model": ErrorResponse}
    for status_code in (401, 422, 500, 502, 503, 504)
}


@app.get("/health", tags=["system"])
async def health(request: Request) -> JSONResponse:
    agent_runtime: AgentRuntime = request.app.state.agent_runtime
    is_ready = agent_runtime.is_llm_configured
    return JSONResponse(
        status_code=status.HTTP_200_OK if is_ready else status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "status": "ok" if is_ready else "degraded",
            "service": "ai-service",
            "llm": "configured" if is_ready else "not_configured",
            "model": agent_runtime.model_name,
            "trackedThreads": agent_runtime.thread_registry.tracked_thread_count,
        },
    )


@app.post(
    "/ai/process",
    response_model=AIProcessResponse,
    responses=ERROR_RESPONSES,
    dependencies=[Depends(require_internal_api_key)],
    tags=["agent"],
)
async def process_conversation_turn(conversation_input: ConversationInput, request: Request) -> AIProcessResponse:
    """Runs one support turn for the conversation and returns the reply and routing outcome."""
    agent_runtime: AgentRuntime = request.app.state.agent_runtime
    request_id = getattr(request.state, "request_id", None)
    thread_id = conversation_input.resolved_thread_id
    log_context = {"requestId": request_id, "conversation_id": conversation_input.conversation_id, "thread_id": thread_id}
    started_at = time.perf_counter()

    try:
        turn_result = await agent_runtime.process_conversation(
            thread_id=thread_id,
            transcript_messages=convert_to_langchain_messages(conversation_input.messages),
            request_id=request_id,
        )
    except LLMNotConfiguredError as not_configured_error:
        logger.error("AI turn rejected: LLM not configured", extra=log_context)
        raise ServiceError(status.HTTP_503_SERVICE_UNAVAILABLE, "AI model is not configured") from not_configured_error
    except AgentTimeoutError as timeout_error:
        logger.error("AI turn timed out", extra={**log_context, "detail": timeout_error.detail})
        raise ServiceError(status.HTTP_504_GATEWAY_TIMEOUT, "AI processing timed out") from timeout_error
    except LLMUpstreamError as upstream_error:
        logger.error(
            "AI turn failed: model provider error",
            extra={**log_context, "failure_kind": upstream_error.failure_kind, "detail": upstream_error.detail},
        )
        if upstream_error.failure_kind == "rate_limited":
            retry_headers = {"Retry-After": str(upstream_error.retry_after_seconds)} if upstream_error.retry_after_seconds else None
            raise ServiceError(status.HTTP_503_SERVICE_UNAVAILABLE, "AI model is rate limited", headers=retry_headers) from upstream_error
        raise ServiceError(status.HTTP_502_BAD_GATEWAY, "AI model provider request failed") from upstream_error
    except InvalidModelOutputError as invalid_output_error:
        logger.error(
            "AI turn failed: unusable model output",
            extra={**log_context, "failure_kind": invalid_output_error.failure_kind, "detail": invalid_output_error.detail},
        )
        raise ServiceError(status.HTTP_502_BAD_GATEWAY, "AI model returned an unusable response") from invalid_output_error

    logger.info(
        "AI turn completed",
        extra={
            **log_context,
            "next_worker": turn_result.next_worker,
            "transcript_messages": len(conversation_input.messages),
            "reply_length": len(turn_result.response_content),
            "log_entries": len(turn_result.internal_logs),
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 1),
        },
    )
    return AIProcessResponse(
        conversation_id=conversation_input.conversation_id,
        response_content=turn_result.response_content,
        next_worker=turn_result.next_worker,
        internal_logs=turn_result.internal_logs,
    )
