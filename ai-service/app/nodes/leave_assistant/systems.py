"""
Where the leave assistant's tools get their facts: the Node backend's internal leave API
(backend/controllers/internalLeaveController.js), always for the one employee the backend named.
Read only; the backend owns every leave rule, so pricing here is the backend's own pricing.

LeaveSystems is the interface the tools use, so tests can supply an in-memory version.

  LeaveDataUnavailableError   the backend could not answer (down, timeout, 5xx): the turn fails
  LeaveRequestRefusedError    the backend refused a leave as asked (a policy rule, with its code):
                              the model is told why, so it can explain it or try other dates
"""

from __future__ import annotations

from typing import Any, Protocol

from app.services.backend_client import BackendInternalClient, BackendRejectedError, BackendUnavailableError


class LeaveDataUnavailableError(Exception):
    """The backend could not provide leave data; the assistant cannot answer reliably."""


class LeaveRequestRefusedError(Exception):
    """The backend refused a leave as described (bad dates, a policy rule)."""

    def __init__(self, code: str | None, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class LeaveSystems(Protocol):
    async def leave_types(self) -> list[dict[str, Any]]: ...

    async def balances(self, employee_id: str) -> dict[str, Any]: ...

    async def requests(self, employee_id: str, status: str | None) -> list[dict[str, Any]]: ...

    async def office_calendar(self, employee_id: str, from_date: str, to_date: str) -> dict[str, Any]: ...

    async def price_leave(self, employee_id: str, leave_request: dict[str, str]) -> dict[str, Any]: ...


class BackendLeaveSystems:
    """LeaveSystems over the backend's /api/internal/leave endpoints."""

    def __init__(self, client: BackendInternalClient) -> None:
        self._client = client

    async def _get(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        try:
            return await self._client.get_json(f"/api/internal/leave{path}", params)
        except BackendUnavailableError as unavailable_error:
            raise LeaveDataUnavailableError(str(unavailable_error)) from unavailable_error
        except BackendRejectedError as rejected_error:
            # The backend refused a read it should always allow (the employee left, has no office):
            # tell the model, which can explain it, rather than fail the turn.
            raise LeaveRequestRefusedError(rejected_error.code, rejected_error.message) from rejected_error

    async def leave_types(self) -> list[dict[str, Any]]:
        return (await self._get("/types"))["leaveTypes"]

    async def balances(self, employee_id: str) -> dict[str, Any]:
        return await self._get(f"/employees/{employee_id}/balances")

    async def requests(self, employee_id: str, status: str | None) -> list[dict[str, Any]]:
        params = {"status": status} if status else None
        return (await self._get(f"/employees/{employee_id}/requests", params))["requests"]

    async def office_calendar(self, employee_id: str, from_date: str, to_date: str) -> dict[str, Any]:
        return await self._get(f"/employees/{employee_id}/calendar", {"from": from_date, "to": to_date})

    async def price_leave(self, employee_id: str, leave_request: dict[str, str]) -> dict[str, Any]:
        try:
            response_data = await self._client.post_json(
                f"/api/internal/leave/employees/{employee_id}/preview", leave_request
            )
        except BackendUnavailableError as unavailable_error:
            raise LeaveDataUnavailableError(str(unavailable_error)) from unavailable_error
        except BackendRejectedError as rejected_error:
            raise LeaveRequestRefusedError(rejected_error.code, rejected_error.message) from rejected_error
        return response_data["preview"]
