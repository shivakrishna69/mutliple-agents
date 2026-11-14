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
  lookup_employee_profile       a colleague by name, employee ID or work email; several matches come
                                back as candidates to pick from           (lookup_employee_profile)
  get_department_metrics        a department's headcount, attendance today, sprint and pending
                                approvals                                  (get_department_metrics)
  find_offboarding_employee     the person someone says is leaving, with the action cards to offer
                                (start their offboarding package, view their profile first)
                                                                           (find_offboarding_employee)
  search_the_web                web search results (SearXNG)              (web_search)
  read_web_page                 one public page, read safely by the backend and kept as external
                                knowledge; cited as a web source with its URL and fetch date
                                                                           (fetch_web_page)
  get_stock_quote               an NSE or BSE quote, or search snippets when no verified quote
                                can be had                                 (get_stock_quote)
  search_external_knowledge     passages of cached web pages, closest to a query: approved pages
                                only, unless the backend says the person has live research
                                                                           (external_knowledge_scope)

When a lookup returns several candidates, they are kept on the turn (clarification_candidates, with
the tool that found them), so the reply can offer each as a card to pick. Action cards a tool
returns are kept too (proposed_actions); the backend checks them again before showing them.

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
from app.nodes.nsk_assistant.schemas import (
    ACTIONS_MAX,
    Action,
    ConversationSource,
    DocumentSource,
    MemorySession,
    ToolSource,
    WebSource,
)
from app.nodes.nsk_assistant.systems import DocumentSearch, NskSystems, NskToolRefusedError

MAX_TOOL_RESULT_CHARACTERS = 12_000
SEARCH_QUERY_MAX_LENGTH = 300
SEARCH_UNAVAILABLE = "The company documents cannot be searched right now."

BACKEND_TOOLS = {
    "get_my_attendance_today": "my_attendance_today",
    "get_my_attendance_month": "my_attendance_month",
    "get_my_leave_balances": "my_leave_balances",
    "list_my_leave_requests": "my_leave_requests",
    "lookup_employee_profile": "lookup_employee_profile",
    "get_department_metrics": "get_department_metrics",
    "find_offboarding_employee": "find_offboarding_employee",
    "search_the_web": "web_search",
    "read_web_page": "fetch_web_page",
    "get_stock_quote": "get_stock_quote",
}
WEB_PAGE_TOOL = "fetch_web_page"
EXTERNAL_SCOPE_TOOL = "external_knowledge_scope"
WEB_QUERY_MAX_LENGTH = 200
WEB_URL_MAX_LENGTH = 2048
EXTERNAL_UNAVAILABLE = "Saved web pages cannot be searched right now."
PEOPLE_QUERY_MAX_LENGTH = 100
DEPARTMENT_QUERY_MAX_LENGTH = 120
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
    # People a lookup could not tell apart: [{"name", "employee_code", ...}], offered as cards.
    clarification_candidates: list[dict[str, Any]] = field(default_factory=list)
    # The backend tool that found them (a lookup, or finding someone to offboard).
    clarification_tool: str | None = None
    # Whether this person may search pages read for others (live research); None until asked.
    external_include_unapproved: bool | None = None
    # Action cards the tools proposed for one resolved person, at most ACTIONS_MAX.
    proposed_actions: list[Action] = field(default_factory=list)

    def propose_actions(self, raw_actions: list[Any]) -> None:
        for raw in raw_actions:
            if len(self.proposed_actions) >= ACTIONS_MAX:
                return
            try:
                action = Action.model_validate(raw)
            except ValueError:
                continue
            if action not in self.proposed_actions:
                self.proposed_actions.append(action)

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


class PeopleQuery(BaseModel):
    query: str = Field(
        min_length=2,
        max_length=PEOPLE_QUERY_MAX_LENGTH,
        description="The colleague's name (or part of it), employee ID (e.g. NSK0104) or work email.",
    )


class WebQuery(BaseModel):
    query: str = Field(
        min_length=2,
        max_length=WEB_QUERY_MAX_LENGTH,
        description="What to look up on the web, in a few words (e.g. RBI repo rate November 2026).",
    )


class PageUrl(BaseModel):
    url: str = Field(
        min_length=4,
        max_length=WEB_URL_MAX_LENGTH,
        description="The full address of a public web page, starting with https:// or http://.",
    )


class QuoteQuery(BaseModel):
    symbol: str = Field(
        min_length=1, max_length=20, description="The stock's exchange symbol, e.g. RELIANCE, TCS, INFY."
    )
    exchange: Literal["NSE", "BSE"] = Field(default="NSE", description="NSE (default) or BSE.")


class DepartmentQuery(BaseModel):
    department: str | None = Field(
        default=None,
        max_length=DEPARTMENT_QUERY_MAX_LENGTH,
        description="The department's name or code; omit to get the departments that can be chosen.",
    )


# =================================================================================================
# Tools
# =================================================================================================


def web_source_of(number: int, page: dict[str, Any]) -> WebSource:
    """A web source from read_web_page's result."""
    return WebSource(
        number=number,
        source_id=page["source_id"],
        url=page.get("final_url") or page["url"],
        title=page.get("title") or page.get("domain") or page["url"],
        fetched_at=page["fetched_at"],
        excerpt=str(page.get("text") or "")[:300],
    )


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
        if isinstance(result, dict) and isinstance(result.get("candidates"), list):
            state.clarification_candidates = result["candidates"]
            state.clarification_tool = backend_name
        if isinstance(result, dict) and isinstance(result.get("actions"), list):
            state.propose_actions(result["actions"])
        if not label:
            return _for_model({"data": result})
        evidence = json.dumps(result, ensure_ascii=False, default=str)
        if backend_name == WEB_PAGE_TOOL and isinstance(result, dict) and result.get("source_id"):
            number = state.add_source(lambda n: web_source_of(n, result), evidence)
        else:
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

    async def search_external_knowledge(query: str) -> str:
        if search is None:
            return _for_model({"error": EXTERNAL_UNAVAILABLE})
        if state.external_include_unapproved is None:
            state.tools_used.append(EXTERNAL_SCOPE_TOOL)
            try:
                scope = await systems.call_tool(EXTERNAL_SCOPE_TOOL, {}, state.actor_token)
            except NskToolRefusedError as refused_error:
                return _for_model({"refused": {"code": refused_error.code, "message": refused_error.message}})
            state.external_include_unapproved = scope["result"]["include_unapproved"] is True
        # Like company documents, an answer from saved pages must cite them.
        state.searched_documents = True
        try:
            passages = await search.search_external_passages(
                question=query, include_unapproved=state.external_include_unapproved, limit=search_settings.top_k
            )
        except KnowledgeUnavailableError:
            return _for_model({"error": EXTERNAL_UNAVAILABLE})
        shown = []
        for passage in passages:
            if passage.score < search_settings.min_relevance:
                continue
            number = state.add_source(
                lambda n, p=passage: WebSource(
                    number=n,
                    source_id=p.source_id,
                    url=p.source_url,
                    title=p.title,
                    fetched_at=p.fetched_at,
                    excerpt=excerpt_of(p.text, search_settings.excerpt_chars),
                ),
                passage.text,
            )
            shown.append(
                {
                    "source": number,
                    "title": passage.title,
                    "url": passage.source_url,
                    "fetched_at": passage.fetched_at,
                    "text": passage.text,
                }
            )
        if not shown:
            return _for_model({"passages": [], "note": "No saved web page matches this."})
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
    candidates += [
        (
            "lookup_employee_profile",
            backend_tool(
                "lookup_employee_profile",
                "Look up a colleague's work profile by name, employee ID or work email: role, department, manager, "
                "joining date, office, shift, attendance today and leave balances. The phone number comes masked and "
                "salary only when this person may see it. Several matches come back as candidates to choose from.",
                PeopleQuery,
            ),
        ),
        (
            "get_department_metrics",
            backend_tool(
                "get_department_metrics",
                "A department's headcount, attendance today by status, its active sprint and open tasks, and its "
                "pending approvals (leave and attendance regularizations).",
                DepartmentQuery,
            ),
        ),
        (
            "find_offboarding_employee",
            backend_tool(
                "find_offboarding_employee",
                "Find the employee someone says is leaving (resigning, serving notice, being let go) by name, employee "
                "ID or work email: who they are, their status, and whether offboarding has already started. The "
                "portal then shows cards to start their offboarding package or view their profile first. Several "
                "matches come back as candidates to choose from.",
                PeopleQuery,
            ),
        ),
        (
            "web_search",
            backend_tool(
                "search_the_web",
                "Search the public web. Returns result titles, addresses and short snippets; snippets can be out of "
                "date, so read the page for facts that matter.",
                WebQuery,
            ),
        ),
        (
            "fetch_web_page",
            backend_tool(
                "read_web_page",
                "Read one public web page (only sites the administrator allows). Returns its title, address, "
                "when it was fetched and its text. Cite it with its source number.",
                PageUrl,
            ),
        ),
        (
            "get_stock_quote",
            backend_tool(
                "get_stock_quote",
                "An Indian stock's latest end-of-day quote on NSE or BSE. When no verified quote is available it "
                "returns web search snippets instead, with a note saying so.",
                QuoteQuery,
            ),
        ),
        (
            EXTERNAL_SCOPE_TOOL,
            StructuredTool.from_function(
                coroutine=search_external_knowledge,
                name="search_external_knowledge",
                description="Search web pages saved earlier (market news, rates, public information). Returns "
                "numbered passages with their address and fetch date to cite.",
                args_schema=WebQuery,
            ),
        ),
    ]
    return [tool for backend_name, tool in candidates if backend_name in allowed_tools]
