"""
Run-scoped dependencies injected into graph nodes.

Nodes receive these through LangGraph's runtime context (`graph.ainvoke(..., context=AgentContext(...))`
and a `runtime: Runtime[AgentContext]` node parameter). Unlike graph state, the context is never
written to the checkpointer, so it can safely hold live clients such as chat models, and it lets
each AgentRuntime (and each test) supply its own configured instances instead of nodes reaching
for module-level globals.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from langchain_core.language_models.chat_models import BaseChatModel

if TYPE_CHECKING:
    from app.nodes.attendance_agent import RegularizationAgent


@dataclass(frozen=True)
class AgentContext:
    # Deterministic (temperature 0.0) model used only for routing decisions.
    supervisor_model: BaseChatModel
    # Model that writes customer replies. Worker nodes bind their tools to it per call.
    worker_model: BaseChatModel
    # How many recent transcript messages a node sends to its model.
    max_context_messages: int
    # Whether workers may call the simulated tools (query_system_logs, check_invoice_status).
    # Always False in production; see Settings.simulated_tools_enabled.
    simulated_tools_enabled: bool
    # The attendance regularization sub-agent, shared with POST /ai/attendance/regularize. None when
    # BACKEND_INTERNAL_URL is not configured (the attendance node then says the feature is unavailable).
    regularization_agent: "RegularizationAgent | None" = None
