"""Wires the nodes into the compiled regularization graph."""

from __future__ import annotations

import logging

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from app.nodes.attendance_agent.nodes import (
    approve_entry_node,
    ask_employee_node,
    evaluate_evidence_node,
    extract_request_node,
    fetch_activity_logs_node,
    reply_out_of_scope_node,
    route_after_approval,
    route_after_evaluation,
    route_after_extraction,
    route_after_fetch,
    route_to_manager_node,
)
from app.nodes.attendance_agent.schemas import RegularizationState
from app.nodes.attendance_agent.systems import RegularizationContext

logger = logging.getLogger("ai_service.attendance_agent")


# =================================================================================================
# Graph
# =================================================================================================


def build_regularization_graph(checkpointer: MemorySaver) -> CompiledStateGraph:
    """Compiles the topology in section 1. A checkpointer is required for interrupt()/resume."""
    graph_builder = StateGraph(RegularizationState, context_schema=RegularizationContext)
    graph_builder.add_node("extract_request", extract_request_node)
    graph_builder.add_node("ask_employee", ask_employee_node)
    graph_builder.add_node("fetch_activity_logs", fetch_activity_logs_node)
    graph_builder.add_node("evaluate_evidence", evaluate_evidence_node)
    graph_builder.add_node("approve_entry", approve_entry_node)
    graph_builder.add_node("route_to_manager", route_to_manager_node)
    graph_builder.add_node("reply_out_of_scope", reply_out_of_scope_node)

    graph_builder.add_edge(START, "extract_request")
    graph_builder.add_conditional_edges(
        "extract_request",
        route_after_extraction,
        ["ask_employee", "route_to_manager", "reply_out_of_scope", "fetch_activity_logs"],
    )
    graph_builder.add_edge("ask_employee", "extract_request")
    graph_builder.add_conditional_edges(
        "fetch_activity_logs", route_after_fetch, ["evaluate_evidence", "route_to_manager"]
    )
    graph_builder.add_conditional_edges(
        "evaluate_evidence", route_after_evaluation, ["approve_entry", "route_to_manager"]
    )
    graph_builder.add_conditional_edges("approve_entry", route_after_approval, [END, "route_to_manager"])
    graph_builder.add_edge("route_to_manager", END)
    graph_builder.add_edge("reply_out_of_scope", END)
    return graph_builder.compile(checkpointer=checkpointer)
