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

from langchain_core.language_models.chat_models import BaseChatModel


@dataclass(frozen=True)
class AgentContext:
    # Deterministic (temperature 0.0) model used only for routing decisions.
    supervisor_model: BaseChatModel
    # How many recent transcript messages a node sends to its model.
    max_context_messages: int
