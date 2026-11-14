"""
Where the NSK assistant's tools get their facts: the backend's internal tool endpoint
(backend/controllers/internalNskController.js, POST /api/internal/nsk/tools/:tool), always with the
turn's actor token, so the backend decides on every call whose data it is and whether the person may
read it; and the department knowledge index, searched only within the departments the backend says
the person may read.

NskSystems and DocumentSearch are the interfaces the tools use, so tests can supply in-memory
versions.

  NskDataUnavailableError   the backend could not answer (down, timeout, 5xx), or refused the turn's
                            actor token: the turn fails rather than answer without facts
  NskToolRefusedError       the backend refused the call (no access, bad arguments): the model is
                            told why, and can say so or try differently
"""

from __future__ import annotations

from typing import Any, Protocol

from app.knowledge.schemas import RetrievedPassage
from app.services.backend_client import BackendInternalClient, BackendRejectedError, BackendUnavailableError

HTTP_UNAUTHORIZED = 401


class NskDataUnavailableError(Exception):
    """The backend could not provide the facts; the assistant cannot answer reliably."""


class NskToolRefusedError(Exception):
    def __init__(self, code: str | None, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class NskSystems(Protocol):
    async def call_tool(self, name: str, arguments: dict[str, Any], actor_token: str) -> dict[str, Any]:
        """{"result": {...}, "source": "label" | None}"""
        ...


class DocumentSearch(Protocol):
    async def search_department_passages(
        self, *, department_ids: list[str], question: str, limit: int
    ) -> list[RetrievedPassage]: ...


class BackendNskSystems:
    """NskSystems over the backend's /api/internal/nsk/tools endpoint."""

    def __init__(self, client: BackendInternalClient) -> None:
        self._client = client

    async def call_tool(self, name: str, arguments: dict[str, Any], actor_token: str) -> dict[str, Any]:
        try:
            return await self._client.post_json(
                f"/api/internal/nsk/tools/{name}", {"actor_token": actor_token, "arguments": arguments}
            )
        except BackendUnavailableError as unavailable_error:
            raise NskDataUnavailableError(str(unavailable_error)) from unavailable_error
        except BackendRejectedError as rejected_error:
            if rejected_error.http_status == HTTP_UNAUTHORIZED:
                raise NskDataUnavailableError("the actor token was refused") from rejected_error
            raise NskToolRefusedError(rejected_error.code, rejected_error.message) from rejected_error
