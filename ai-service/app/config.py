"""
Service configuration, read once from the environment at startup.

Every module receives the `Settings` object instead of calling `os.getenv`, so the complete set
of knobs the service depends on is visible here. Invalid values fail startup with a message
naming the variable, rather than surfacing later as a confusing runtime error.

For local development, variables may be placed in `ai-service/.env` (see `.env.example`).
Real environment variables always take precedence over the file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load ai-service/.env if it exists; never overrides variables already set in the environment.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)

# HMAC-grade shared secrets must be at least this long (matches the backend's rule).
MIN_SECRET_LENGTH = 32

# Groq retired llama-3.3-70b-versatile; gpt-oss-120b is Groq's strongest general chat model with
# tool calling (needed for structured routing). Override with GROQ_MODEL.
DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"
REASONING_EFFORT_LEVELS = frozenset({"low", "medium", "high"})


class ConfigurationError(ValueError):
    """Raised at startup when an environment variable is missing or invalid."""


def _read_float(variable_name: str, default_value: float, minimum: float, maximum: float) -> float:
    raw_value = os.getenv(variable_name)
    if raw_value is None or raw_value.strip() == "":
        return default_value
    try:
        parsed_value = float(raw_value)
    except ValueError as conversion_error:
        raise ConfigurationError(f"{variable_name} must be a number") from conversion_error
    if not minimum <= parsed_value <= maximum:
        raise ConfigurationError(f"{variable_name} must be between {minimum} and {maximum}")
    return parsed_value


def _read_int(variable_name: str, default_value: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(variable_name)
    if raw_value is None or raw_value.strip() == "":
        return default_value
    try:
        parsed_value = int(raw_value)
    except ValueError as conversion_error:
        raise ConfigurationError(f"{variable_name} must be an integer") from conversion_error
    if not minimum <= parsed_value <= maximum:
        raise ConfigurationError(f"{variable_name} must be between {minimum} and {maximum}")
    return parsed_value


@dataclass(frozen=True)
class Settings:
    """All configuration for the service. See `.env.example` for what each value means."""

    environment: str
    log_level: str

    # Shared secret the Node backend sends in X-Internal-Api-Key.
    internal_api_key: str

    # Groq LLM access. Without an API key the service starts, reports itself degraded, and
    # answers /ai/process with 503, so the backend falls back to a human handoff.
    groq_api_key: str | None
    groq_model: str
    groq_base_url: str | None
    llm_request_timeout_seconds: float
    llm_max_retries: int
    llm_temperature: float
    llm_max_output_tokens: int
    # For reasoning models (gpt-oss, qwen3): how much hidden reasoning to do before answering.
    # None means the parameter is not sent, which non-reasoning models require.
    llm_reasoning_effort: str | None

    # Hard deadline for one /ai/process call. Must be shorter than the backend's
    # AI_SERVICE_TIMEOUT_MS so the backend receives a clean 504 instead of timing out itself.
    process_timeout_seconds: float

    # Worker tools backed by simulated data (app/nodes/workers.py). Never allowed in production,
    # where customers would receive invented ledger and log data as fact.
    simulated_tools_enabled: bool

    # Conversation memory bounds (see agent.ThreadRegistry).
    max_context_messages: int
    thread_idle_ttl_seconds: int
    max_tracked_threads: int
    compact_thread_after_turns: int

    @classmethod
    def from_environment(cls) -> "Settings":
        internal_api_key = os.getenv("AI_SERVICE_API_KEY", "")
        if len(internal_api_key) < MIN_SECRET_LENGTH:
            raise ConfigurationError(
                f"AI_SERVICE_API_KEY is required and must be at least {MIN_SECRET_LENGTH} characters"
            )

        groq_api_key = os.getenv("GROQ_API_KEY", "").strip() or None
        groq_base_url = os.getenv("GROQ_BASE_URL", "").strip() or None
        if groq_base_url is None:
            # The Groq SDK reads GROQ_BASE_URL from the environment on its own; an empty value
            # (e.g. "GROQ_BASE_URL=" in .env) would become an empty endpoint URL. Unset it so the
            # SDK falls back to Groq's default.
            os.environ.pop("GROQ_BASE_URL", None)
        elif not groq_base_url.startswith(("http://", "https://")):
            raise ConfigurationError("GROQ_BASE_URL must start with http:// or https://")

        log_level = os.getenv("LOG_LEVEL", "INFO").strip().upper()
        if log_level not in {"DEBUG", "INFO", "WARNING", "ERROR"}:
            raise ConfigurationError("LOG_LEVEL must be one of DEBUG, INFO, WARNING, ERROR")

        reasoning_effort_setting = os.getenv("LLM_REASONING_EFFORT")
        if reasoning_effort_setting is None:
            llm_reasoning_effort = "low"
        else:
            llm_reasoning_effort = reasoning_effort_setting.strip().lower() or None
            if llm_reasoning_effort is not None and llm_reasoning_effort not in REASONING_EFFORT_LEVELS:
                raise ConfigurationError("LLM_REASONING_EFFORT must be low, medium, high, or empty")

        llm_request_timeout_seconds = _read_float("LLM_REQUEST_TIMEOUT_SECONDS", 8.0, 1.0, 120.0)
        process_timeout_seconds = _read_float("AI_PROCESS_TIMEOUT_SECONDS", 18.0, 2.0, 115.0)
        if process_timeout_seconds <= llm_request_timeout_seconds:
            raise ConfigurationError("AI_PROCESS_TIMEOUT_SECONDS must be greater than LLM_REQUEST_TIMEOUT_SECONDS")

        environment = os.getenv("APP_ENV", "development").strip()
        simulated_tools_setting = os.getenv("SIMULATED_TOOLS_ENABLED", "").strip().lower()
        if simulated_tools_setting not in {"", "true", "false"}:
            raise ConfigurationError('SIMULATED_TOOLS_ENABLED must be "true" or "false"')
        # Default: on everywhere except production.
        simulated_tools_enabled = (
            environment != "production" if simulated_tools_setting == "" else simulated_tools_setting == "true"
        )
        if environment == "production" and simulated_tools_enabled:
            raise ConfigurationError("SIMULATED_TOOLS_ENABLED cannot be true in production: customers would receive simulated data")

        return cls(
            environment=environment,
            log_level=log_level,
            internal_api_key=internal_api_key,
            groq_api_key=groq_api_key,
            groq_model=os.getenv("GROQ_MODEL", DEFAULT_GROQ_MODEL).strip() or DEFAULT_GROQ_MODEL,
            groq_base_url=groq_base_url,
            llm_request_timeout_seconds=llm_request_timeout_seconds,
            llm_max_retries=_read_int("LLM_MAX_RETRIES", 1, 0, 5),
            llm_temperature=_read_float("LLM_TEMPERATURE", 0.3, 0.0, 2.0),
            llm_max_output_tokens=_read_int("LLM_MAX_OUTPUT_TOKENS", 2048, 64, 8192),
            llm_reasoning_effort=llm_reasoning_effort,
            process_timeout_seconds=process_timeout_seconds,
            simulated_tools_enabled=simulated_tools_enabled,
            max_context_messages=_read_int("MAX_CONTEXT_MESSAGES", 30, 2, 100),
            thread_idle_ttl_seconds=_read_int("THREAD_IDLE_TTL_SECONDS", 7200, 60, 7 * 24 * 3600),
            max_tracked_threads=_read_int("MAX_TRACKED_THREADS", 1000, 1, 100_000),
            compact_thread_after_turns=_read_int("COMPACT_THREAD_AFTER_TURNS", 10, 1, 1000),
        )
