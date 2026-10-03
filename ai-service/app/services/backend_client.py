"""
Client for the Node backend's internal API, used by the attendance regularization agent to make
real changes in MongoDB. The backend owns the Attendance collection and its rules (office time
zone, shift window, duplicate protection, status calculation); this service never writes to the
database itself, so those rules exist in exactly one place.

Endpoints (backend/routes/internalRoutes.js), authenticated with X-Internal-Api-Key = AI_SERVICE_API_KEY:

  POST /api/internal/attendance/regularizations
      { employee_id, date, punch_in_time, evidence_event_count, reason, thread_id }
      201 { data: { attendance, newlyCreated: true } }   entry written
      200 { data: { attendance, newlyCreated: false } }  an entry for that day already existed (idempotent)
      400 / 404 / 422                                    refused by the backend's rules -> BackendRejectedError

  POST /api/internal/attendance/regularization-reviews
      { employee_id, date, claimed_punch_in_time, reason, routing_reason, qualifying_event_count,
        allowed_geofence_radius, idempotency_key }
      201 / 200 { data: { review: { id, status } } }    created, or the existing one for the same key

Both operations are idempotent on the backend (per employee and day, and per idempotency key), so a
request whose response was lost is retried once safely. Connection failures, timeouts and 5xx
raise BackendUnavailableError; 4xx raise BackendRejectedError with the backend's message.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

logger = logging.getLogger("ai_service.backend_client")

INTERNAL_API_KEY_HEADER = "X-Internal-Api-Key"
REQUEST_TIMEOUT_SECONDS = 5.0
RETRY_DELAY_SECONDS = 0.3
MAX_ATTEMPTS = 2


class BackendUnavailableError(Exception):
    """The backend could not be reached or failed (timeout, connection error, 5xx)."""


class BackendRejectedError(Exception):
    """The backend refused the request (4xx); retrying the same request cannot succeed."""

    def __init__(self, http_status: int, message: str) -> None:
        super().__init__(f"HTTP {http_status}: {message}")
        self.http_status = http_status
        self.message = message


class BackendInternalClient:
    """One pooled HTTP client per process; close it on shutdown."""

    def __init__(self, base_url: str, internal_api_key: str) -> None:
        self._http_client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS),
            headers={INTERNAL_API_KEY_HEADER: internal_api_key, "Accept": "application/json"},
            # An internal API never redirects; following a redirect could leak the key.
            follow_redirects=False,
        )

    async def aclose(self) -> None:
        await self._http_client.aclose()

    async def post_json(self, path: str, payload: dict[str, Any], *, request_id: str | None = None) -> dict[str, Any]:
        """POSTs JSON and returns the response's `data` object. Retries once on unavailability."""
        headers = {"X-Request-Id": request_id} if request_id else {}
        last_failure: Exception | None = None
        for attempt_number in range(1, MAX_ATTEMPTS + 1):
            try:
                response = await self._http_client.post(path, json=payload, headers=headers)
            except httpx.HTTPError as transport_error:
                last_failure = BackendUnavailableError(f"{type(transport_error).__name__}: {transport_error}")
            else:
                if response.status_code >= 500:
                    last_failure = BackendUnavailableError(f"HTTP {response.status_code}")
                elif response.status_code >= 400:
                    raise BackendRejectedError(response.status_code, _error_message(response))
                else:
                    response_body = _json_object(response)
                    response_data = response_body.get("data")
                    if not isinstance(response_data, dict):
                        raise BackendUnavailableError("response has no data object")
                    return response_data
            logger.warning("Backend internal call failed", extra={"path": path, "attempt": attempt_number, "error": str(last_failure)[:200]})
            if attempt_number < MAX_ATTEMPTS:
                await asyncio.sleep(RETRY_DELAY_SECONDS)
        raise last_failure  # type: ignore[misc]


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        decoded_body = response.json()
    except ValueError as decode_error:
        raise BackendUnavailableError("response is not JSON") from decode_error
    if not isinstance(decoded_body, dict):
        raise BackendUnavailableError("response is not a JSON object")
    return decoded_body


def _error_message(response: httpx.Response) -> str:
    try:
        error_body = response.json().get("error", {})
        message = error_body.get("message") if isinstance(error_body, dict) else None
    except (ValueError, AttributeError):
        message = None
    return str(message or f"HTTP {response.status_code}")[:300]
