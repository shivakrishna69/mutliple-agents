"""
ai-service entry point.

Run locally:
    uvicorn main:app --reload --port 8000

Boot sequence (see `lifespan`):
    1. Read and validate settings from environment variables.
    2. Open the MongoDB client (Motor) and check it with a `ping`.
       If MONGO_URI is unset, the service starts without a database and /health reports it.
    3. Create the Groq client if GROQ_API_KEY is set.
    4. Store these shared clients on `app.state`; route handlers read them from there.
    On shutdown the same function closes the clients in reverse order.

Error boundaries, from innermost to outermost:
    - Route code raises `ServiceError` for expected failures with a status code and safe message.
    - `RequestValidationError` (bad request body or params) becomes a 422 with field details.
    - `unhandled_exception_handler` catches everything else, logs the traceback, and returns
      a generic 500 so internal details never reach the client.

Logging: every log record is emitted as one JSON object on stdout with `ts`, `level`,
`logger`, `msg`, and any `extra={...}` fields, so log collectors can parse it directly.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from groq import AsyncGroq
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------

# Attributes present on every LogRecord; anything else was passed through `extra=` and is
# copied into the JSON output as context.
_STANDARD_RECORD_ATTRS = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    """Formats each log record as a single JSON line, including `extra` fields and tracebacks."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": "ai-service",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _STANDARD_RECORD_ATTRS:
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str) -> None:
    """
    Replaces the root handlers with one JSON handler on stdout and routes Uvicorn's
    loggers through it, so application and server logs share one format.
    Uvicorn's access log is disabled because `log_requests` below logs each request
    with its request id and duration.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())

    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
    logging.getLogger("uvicorn.access").disabled = True


logger = logging.getLogger("ai_service")

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Settings:
    """
    All configuration the service reads from the environment. Modules receive this
    object instead of calling `os.getenv`, so every setting is defined in one place.
    """

    env: str
    log_level: str
    mongo_uri: str | None
    mongo_db_name: str
    groq_api_key: str | None
    cors_origins: list[str]

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            env=os.getenv("APP_ENV", "development"),
            log_level=os.getenv("LOG_LEVEL", "INFO"),
            mongo_uri=os.getenv("MONGO_URI") or None,
            mongo_db_name=os.getenv("MONGO_DB_NAME", "multiagent"),
            groq_api_key=os.getenv("GROQ_API_KEY") or None,
            cors_origins=[
                origin.strip()
                for origin in os.getenv(
                    "CORS_ORIGINS", "http://localhost:5173,http://localhost:5000"
                ).split(",")
                if origin.strip()
            ],
        )


settings = Settings.from_env()
configure_logging(settings.log_level)

# ---------------------------------------------------------------------------
# Error primitives
# ---------------------------------------------------------------------------


class ServiceError(Exception):
    """
    An expected failure whose message is safe to return to the caller.
    Raise it from route or agent code, e.g. `raise ServiceError(404, "Session not found")`;
    `service_error_handler` turns it into a JSON response with that status code.
    """

    def __init__(self, status_code: int, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.details = details


def error_body(request: Request, message: str, details: Any = None) -> dict[str, Any]:
    """Builds the error response shape shared with the backend: `{error: {message, requestId, details?}}`."""
    body: dict[str, Any] = {
        "message": message,
        "requestId": getattr(request.state, "request_id", None),
    }
    if details is not None:
        body["details"] = details
    return {"error": body}


# ---------------------------------------------------------------------------
# Lifespan: shared clients
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Creates the clients shared by all requests and closes them on shutdown.
    A failed MongoDB ping is logged and leaves `app.state.mongo_db` as None rather
    than aborting startup, so the service can still report its state via /health.
    """
    app.state.settings = settings
    app.state.mongo_client = None
    app.state.mongo_db = None
    app.state.groq = None

    if settings.mongo_uri:
        client: AsyncIOMotorClient = AsyncIOMotorClient(
            settings.mongo_uri, serverSelectionTimeoutMS=5_000
        )
        app.state.mongo_client = client
        try:
            await client.admin.command("ping")
            app.state.mongo_db = client[settings.mongo_db_name]
            logger.info("MongoDB connected", extra={"db": settings.mongo_db_name})
        except Exception:
            logger.exception("MongoDB ping failed; continuing without database")
    else:
        logger.warning("MONGO_URI not set; starting without database")

    if settings.groq_api_key:
        app.state.groq = AsyncGroq(api_key=settings.groq_api_key)
        logger.info("Groq client initialised")
    else:
        logger.warning("GROQ_API_KEY not set; LLM calls are unavailable")

    logger.info("ai-service started", extra={"env": settings.env})
    try:
        yield
    finally:
        if app.state.groq is not None:
            await app.state.groq.close()
        if app.state.mongo_client is not None:
            app.state.mongo_client.close()
        logger.info("ai-service stopped")


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="ai-service",
    version="0.1.0",
    description="LangGraph agent orchestration backed by Groq LLMs.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """
    Assigns a request id (reusing an incoming `X-Request-Id` so a call forwarded from the
    backend keeps the same id), returns it in the response header, and logs one line per
    request with status and duration.
    """
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    started = time.perf_counter()

    response = await call_next(request)

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    response.headers["X-Request-Id"] = request_id
    level = (
        logging.ERROR
        if response.status_code >= 500
        else logging.WARNING
        if response.status_code >= 400
        else logging.INFO
    )
    logger.log(
        level,
        "request completed",
        extra={
            "requestId": request_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "durationMs": duration_ms,
        },
    )
    return response


@app.exception_handler(ServiceError)
async def service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
    """Returns the status code and message carried by an expected `ServiceError`."""
    logger.warning(
        exc.message,
        extra={"requestId": getattr(request.state, "request_id", None), "status": exc.status_code},
    )
    return JSONResponse(
        status_code=exc.status_code, content=error_body(request, exc.message, exc.details)
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Returns 422 with the field-level errors Pydantic reported for the request."""
    details = [
        {"loc": list(err.get("loc", [])), "message": err.get("msg"), "type": err.get("type")}
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=error_body(request, "Validation failed", details),
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Final boundary for errors no other handler matched. Logs the full traceback with
    the request id and returns a generic 500; the exception message is included in the
    response only outside production.
    """
    logger.exception(
        "Unhandled error",
        extra={
            "requestId": getattr(request.state, "request_id", None),
            "method": request.method,
            "path": request.url.path,
        },
    )
    message = str(exc) if settings.env != "production" else "Internal server error"
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=error_body(request, message)
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: str
    service: str
    database: str
    llm: str
    uptime_seconds: int


_STARTED_AT = time.monotonic()


@app.get("/health", response_model=HealthResponse, tags=["system"])
async def health(request: Request) -> JSONResponse:
    """
    Liveness and readiness probe. Pings MongoDB on each call and returns 503 with
    `status: "degraded"` when the database is unreachable or not configured, so an
    orchestrator stops routing traffic here. `llm` reports whether a Groq client exists;
    it does not call the Groq API, to keep the probe fast and free.
    """
    database = "not_configured"
    if request.app.state.mongo_client is not None:
        try:
            await request.app.state.mongo_client.admin.command("ping")
            database = "connected"
        except Exception as exc:
            logger.warning("Health check ping failed", extra={"error": str(exc)})
            database = "disconnected"

    healthy = database == "connected"
    body = HealthResponse(
        status="ok" if healthy else "degraded",
        service="ai-service",
        database=database,
        llm="configured" if request.app.state.groq is not None else "not_configured",
        uptime_seconds=int(time.monotonic() - _STARTED_AT),
    )
    return JSONResponse(
        status_code=status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE,
        content=body.model_dump(),
    )
