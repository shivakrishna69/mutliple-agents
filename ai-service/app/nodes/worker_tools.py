"""
Tools the worker models may call, backed by simulated data (development only).

SIMULATED_TOOLS_ENABLED gates them (app/config.py forbids it in production, where customers would
receive invented ledger and log data as fact). Each tool is deterministic: the same input always
gives the same answer. Server-injected arguments (InjectedToolArg) are never shown to the model;
app/nodes/workers.py supplies them from graph state.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date
from typing import Annotated, Any

from langchain_core.tools import InjectedToolArg, tool

SIMULATED_DATA_SOURCE = "simulated"


class ToolExecutionError(Exception):
    """A tool could not complete (backend unavailable, missing identity). Not recoverable by the model."""


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
        "customer_steps": [
            "Retry the request after a few seconds.",
            "If it persists for more than 10 minutes, share the request ID and timestamp.",
        ],
        "incident_open": False,
    },
    "ERR_401_UNAUTHORIZED": {
        "service": "auth-service",
        "http_status": 401,
        "sample_log_line": "token verification failed: signature expired",
        "probable_cause": "The access token or API key used for the request has expired or was revoked.",
        "customer_steps": [
            "Sign out and sign in again.",
            "For API access, generate a new API key and update the integration.",
        ],
        "incident_open": False,
    },
    "ERR_403_FORBIDDEN": {
        "service": "auth-service",
        "http_status": 403,
        "sample_log_line": "permission denied: role lacks scope 'billing:read'",
        "probable_cause": "The signed-in user's role does not include the permission this action needs.",
        "customer_steps": [
            "Ask a workspace admin to grant the required role.",
            "Confirm you are signed in to the correct workspace.",
        ],
        "incident_open": False,
    },
    "ERR_429_RATE_LIMITED": {
        "service": "api-gateway",
        "http_status": 429,
        "sample_log_line": "rate limit exceeded: 600 requests/minute for key prefix pk_live",
        "probable_cause": "The client sent more requests than the plan's rate limit allows.",
        "customer_steps": [
            "Add exponential backoff and respect the Retry-After header.",
            "Batch requests where the API supports it.",
        ],
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
