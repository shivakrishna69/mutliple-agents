"""
Structured JSON logging.

Every record is one JSON object on stdout with `ts`, `level`, `service`, `logger`, `msg`, and any
fields passed through `extra={...}`, so log collectors can parse it without regexes. Uvicorn's
loggers are routed through the same handler so server and application logs share one format.
Message content and customer text are never logged by this service; only ids, sizes, routing
decisions, timings, and token counts are.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any

# Attributes present on every LogRecord; anything else came from `extra=` and is emitted as context.
_STANDARD_RECORD_ATTRIBUTES = set(vars(logging.makeLogRecord({}))) | {"message", "asctime", "color_message"}


class JsonFormatter(logging.Formatter):
    """Formats each log record as a single JSON line, including `extra` fields and tracebacks."""

    def format(self, record: logging.LogRecord) -> str:
        log_payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": "ai-service",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for attribute_name, attribute_value in vars(record).items():
            if attribute_name not in _STANDARD_RECORD_ATTRIBUTES:
                log_payload[attribute_name] = attribute_value
        if record.exc_info:
            log_payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(log_payload, default=str)


def configure_logging(log_level: str) -> None:
    """
    Installs the JSON handler on the root logger and routes Uvicorn's loggers through it.
    Uvicorn's access log is disabled because the request middleware in main.py logs each request
    with its request id and duration.
    """
    json_handler = logging.StreamHandler(sys.stdout)
    json_handler.setFormatter(JsonFormatter())

    root_logger = logging.getLogger()
    root_logger.handlers = [json_handler]
    root_logger.setLevel(log_level)

    for uvicorn_logger_name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(uvicorn_logger_name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
    logging.getLogger("uvicorn.access").disabled = True

    # HTTP client libraries log every request at INFO; keep them quiet unless debugging.
    for chatty_logger_name in ("httpx", "httpcore", "groq"):
        logging.getLogger(chatty_logger_name).setLevel(max(logging.WARNING, logging.getLevelName(log_level)))
