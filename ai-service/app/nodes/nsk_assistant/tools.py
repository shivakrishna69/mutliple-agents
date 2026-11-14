"""
The NSK assistant's tools for one turn (build_nsk_tools), and the numbered sources its reply cites.

Each tool is offered to the model only when the backend listed it for this person
(NskTurnInput.allowed_tools), and the backend checks again when it runs (systems.py). No tool takes
a person: the actor token fixes whose data it is.

  get_my_attendance_today       today's status, punch and office            (my_attendance_today)
  get_my_attendance_month       one month day by day, with totals           (my_attendance_month)
  get_my_leave_balances         leave balances this leave year              (my_leave_balances)
  list_my_leave_requests        leave requests, newest first                (my_leave_requests)
  search_company_docs           passages of the knowledge bases the person may read, closest to a
                                query, each with its document              (knowledge_scope)

Sources. Every tool result the backend labels, and every passage a search returns, becomes a
numbered source; the result handed to the model carries its number ("source": 3), and the model
cites it as [3]. Earlier sessions are numbered before the turn starts (the prompt lists them).
Each source keeps its text as evidence for the number check (grounding.py).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field

from app.knowledge.service import KnowledgeUnavailableError
from app.nodes.knowledge_agent.citations import excerpt_of
from app.nodes.nsk_assistant.schemas import ConversationSource, DocumentSource, MemorySession, ToolSource
from app.nodes.nsk_assistant.systems import DocumentSearch, NskSystems, NskToolRefusedError

MAX_TOOL_RESULT_CHARACTERS = 12_000
SEARCH_QUERY_MAX_LENGTH = 300
SEARCH_UNAVAILABLE = "The company documents cannot be searched right now."

BACKEND_TOOLS = {
    "get_my_attendance_today": "my_attendance_today",
    "get_my_attendance_month": "my_attendance_month",
    "get_my_leave_balances": "my_leave_balances",
    "list_my_leave_requests": "my_leave_requests",
}
KNOWLEDGE_SCOPE_TOOL = "knowledge_scope"


@dataclass(frozen=True)
class SearchSettings:
    top_k: int
    min_relevance: float
    excerpt_chars: int


@dataclass
class NumberedSource:
    number: int
    source: ToolSource | DocumentSource | ConversationSource
    evidence: str


@dataclass
class NskTurnState:
    """What one turn knows and produced; tools read and fill it."""

    actor_token: str
    sources: list[NumberedSource] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    readable_department_ids: list[str] | None = None
    searched_documents: bool = False

    def add_source(self, build: Any, evidence: str) -> int:
        number = len(self.sources) + 1
        self.sources.append(NumberedSource(number=number, source=build(number), evidence=evidence))
        return number

    def add_memories(self, memories: list[MemorySession]) -> list[tuple[int, MemorySession]]:
        numbered = []
        for memory in memories:
            evidence = json.dumps(memory.model_dump(mode="json"), ensure_ascii=False)
            number = self.add_source(
                lambda n, session_id=memory.session_id: ConversationSource(number=n, session_id=session_id), evidence
            )
            numbered.append((number, memory))
        return numbered


# =================================================================================================
# Argument schemas (what the model sees)
# =================================================================================================


class NoArguments(BaseModel):
    pass


class MonthArgument(BaseModel):
    month: str | None = Field(
        default=None,
        pattern=r"^\d{4}-(0[1-9]|1[0-2])$",
        description="The month as YYYY-MM; omit for the current month.",
    )


class RequestFilter(BaseModel):
    status: Literal["PENDING", "APPROVED", "REJECTED", "CANCELLED"] | None = Field(
        default=None, description="Only requests with this status; omit for all."
    )


class SearchQuery(BaseModel):
    query: str = Field(
        min_length=2,
        max_length=SEARCH_QUERY_MAX_LENGTH,
        description="What to look for in the company's documents, in a few words (e.g. 'notice period').",
    )


# =================================================================================================
# Tools
# =================================================================================================


def _for_model(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)[:MAX_TOOL_RESULT_CHARACTERS]


def build_nsk_tools(
    systems: NskSystems,
    search: DocumentSearch | None,
    state: NskTurnState,
    allowed_tools: list[str],
    search_settings: SearchSettings,
) -> list[BaseTool]:
    """The tools this person may use in this turn."""

    async def call_backend(backend_name: str, arguments: dict[str, Any]) -> str:
        state.tools_used.append(backend_name)
        try:
            response = await systems.call_tool(backend_name, arguments, state.actor_token)
        except NskToolRefusedError as refused_error:
            return _for_model({"refused": {"code": refused_error.code, "message": refused_error.message}})
        result, label = response.get("result"), response.get("source")
        if not label:
            return _for_model({"data": result})
        evidence = json.dumps(result, ensure_ascii=False, default=str)
        number = state.add_source(lambda n: ToolSource(number=n, tool=backend_name, label=label), evidence)
        return _for_model({"source": number, "data": result})

    def backend_tool(model_name: str, description: str, args_schema: type[BaseModel]) -> BaseTool:
        backend_name = BACKEND_TOOLS[model_name]

        async def run(**arguments: Any) -> str:
            return await call_backend(
                backend_name, {key: value for key, value in arguments.items() if value is not None}
            )

        return StructuredTool.from_function(
            coroutine=run, name=model_name, description=description, args_schema=args_schema
        )

    async def search_company_docs(query: str) -> str:
        if search is None:
            return _for_model({"error": SEARCH_UNAVAILABLE})
        if state.readable_department_ids is None:
            state.tools_used.append(KNOWLEDGE_SCOPE_TOOL)
            try:
                scope = await systems.call_tool(KNOWLEDGE_SCOPE_TOOL, {}, state.actor_token)
            except NskToolRefusedError as refused_error:
                return _for_model({"refused": {"code": refused_error.code, "message": refused_error.message}})
            state.readable_department_ids = [department["id"] for department in scope["result"]["departments"]]
        state.searched_documents = True
        if not state.readable_department_ids:
            return _for_model({"passages": [], "note": "No knowledge base is open to this person."})
        try:
            passages = await search.search_department_passages(
                department_ids=state.readable_department_ids, question=query, limit=search_settings.top_k
            )
        except KnowledgeUnavailableError:
            return _for_model({"error": SEARCH_UNAVAILABLE})
        relevant = [passage for passage in passages if passage.score >= search_settings.min_relevance]
        shown = []
        for passage in relevant:
            number = state.add_source(
                lambda n, p=passage: DocumentSource(
                    number=n,
                    document_id=p.document_id,
                    department_id=p.department_id,
                    chunk_index=p.chunk_index,
                    heading_path=p.heading_path,
                    page=p.page,
                    excerpt=excerpt_of(p.text, search_settings.excerpt_chars),
                    score=round(p.score, 4),
                ),
                passage.text,
            )
            shown.append(
                {"source": number, "headings": passage.heading_path, "page": passage.page, "text": passage.text}
            )
        if not shown:
            return _for_model({"passages": [], "note": "Nothing in the company's documents matches this."})
        return _for_model({"passages": shown})

    candidates: list[tuple[str, BaseTool]] = [
        (
            "my_attendance_today",
            backend_tool(
                "get_my_attendance_today",
                "The person's attendance today: status, punch-in and punch-out (office time), office and shift.",
                NoArguments,
            ),
        ),
        (
            "my_attendance_month",
            backend_tool(
                "get_my_attendance_month",
                "The person's attendance for one month, day by day (status, punch times, worked time), with days "
                "expected, present and late and the completion percentage.",
                MonthArgument,
            ),
        ),
        (
            "my_leave_balances",
            backend_tool(
                "get_my_leave_balances",
                "The person's leave balances this leave year: available, held for pending requests, and total days.",
                NoArguments,
            ),
        ),
        (
            "my_leave_requests",
            backend_tool(
                "list_my_leave_requests",
                "The person's own leave requests, newest first: type, dates, days, status and reason.",
                RequestFilter,
            ),
        ),
        (
            KNOWLEDGE_SCOPE_TOOL,
            StructuredTool.from_function(
                coroutine=search_company_docs,
                name="search_company_docs",
                description="Search the company's policies, handbooks and HR documents the person may read. "
                "Returns numbered passages to cite.",
                args_schema=SearchQuery,
            ),
        ),
    ]
    return [tool for backend_name, tool in candidates if backend_name in allowed_tools]
