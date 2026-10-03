"""
The support workflow state machine: a cyclic LangGraph in which the supervisor routes, workers
reply, and every worker returns control to the supervisor until the turn is complete.

=================================================================================================
1. Topology
=================================================================================================

                                   ┌──────────────────────────────────────────────┐
                                   │                                              │
                                   ▼                                              │
     START ───────────────► ┌─────────────┐                                       │
                            │ supervisor  │ route_after_supervisor                │
                            └──────┬──────┘                                       │
              ┌─────────────┬──────┴───────┬───────────────────┬──────────┐       │
              ▼             ▼              ▼                   ▼          ▼       │
      ┌──────────────┐ ┌────────────┐ ┌─────────────────────┐ ┌─────────────┐ END │
      │billing_agent │ │ tech_agent │ │ supervisor_response │ │human_handoff│     │
      └──────┬───────┘ └─────┬──────┘ └──────────┬──────────┘ └──────┬──────┘     │
             │ route_after_worker        │ route_after_worker        │            │
             ├───────────────────────────┴─────────── (handed off) ──┴──► END     │
             └──────────────── (replied) ─────────────────────────────────────────┘
                                         supervisor_response (replied) ──► END

  supervisor            app/nodes/supervisor.py   writes next_worker (routing decision)
  billing_agent         app/nodes/workers.py      replies; may call check_invoice_status
  tech_agent            app/nodes/workers.py      replies; may call query_system_logs
  supervisor_response   app/nodes/workers.py      the supervisor's own reply (FINISH, no tools)
  human_handoff         this module                fixed handoff reply; escalates to a person
  attendance_regularization
                        app/nodes/attendance_worker.py
                                                   runs the attendance regularization sub-agent
                                                   (app/nodes/attendance_agent.py); returns to the
                                                   supervisor for review like billing/tech. Not
                                                   drawn above: it sits beside billing_agent and
                                                   tech_agent and follows the same edges.

=================================================================================================
2. One turn = one customer message
=================================================================================================

  Each POST /ai/process runs the graph once, from START, with the backend's transcript ending in
  the customer's newest message. The run ends at END with one or more replies, which are joined
  into the response. Conversation memory across turns comes from the checkpointer (section 5),
  not from the graph staying alive between messages.

=================================================================================================
3. The loop: why workers return to the supervisor
=================================================================================================

  A worker replies, then hands control back so the supervisor can review the turn. This lets one
  customer message that raises two topics get both answered in the same turn:

    customer: "I was charged twice, and the app crashes on login."
       │
       ▼
    supervisor (no reply yet)            -> BILLING_WORKER
       │
       ▼
    billing_agent  replies about the double charge
       │ route_after_worker: replied -> supervisor
       ▼
    supervisor (review: 1 reply so far)  -> TECH_WORKER     (crash not yet addressed)
       │
       ▼
    tech_agent     replies about the crash
       │ route_after_worker: reply cap (2) reached -> END   (no review call needed)
       ▼
    END            both replies are joined into the turn's response

  For a single-topic message the review chooses FINISH and the turn ends after one reply:

    supervisor -> billing_agent -> supervisor (review) -> FINISH -> END

=================================================================================================
4. Routing rules and loop termination
=================================================================================================

  route_after_supervisor(state), with replies = final replies given this turn:

    replies == 0   (first decision of the turn)
      billing_agent -> billing_agent      tech_agent -> tech_agent
      attendance_agent -> attendance_regularization
      supervisor    -> supervisor_response (FINISH: the supervisor answers itself)
      human         -> human_handoff
    replies >= 1   (review after a worker replied)
      replies >= MAX_REPLIES_PER_TURN            -> END   (hard cap)
      supervisor (FINISH)                        -> END   (turn complete)
      the worker that just replied               -> END   (never the same specialist twice)
      another specialist                         -> that specialist
      human                                      -> human_handoff

  route_after_worker(state):
      the worker handed off (last_replying_worker == "human")  -> END
      supervisor_response replied                               -> END (the supervisor already
                                                                  answered the turn as a whole)
      replies >= MAX_REPLIES_PER_TURN                           -> END (a review could only end it)
      billing_agent / tech_agent / attendance_agent replied     -> supervisor (review)

  Why the loop always terminates: every pass through a worker adds exactly one final reply or
  ends the turn; the review can only route to a specialist that has not replied this turn; and
  MAX_REPLIES_PER_TURN caps replies. The longest possible path is
  supervisor, worker, supervisor, worker -> END (4 steps), or supervisor, worker, supervisor,
  human_handoff -> END. RECURSION_LIMIT is a backstop above that, never expected to be reached.

=================================================================================================
5. State channels and persistence
=================================================================================================

  messages              add_messages reducer. Each turn's input starts with
                        RemoveMessage(REMOVE_ALL_MESSAGES) + the backend transcript, so the stored
                        transcript always equals the backend's; workers append their tool exchanges
                        and replies during the turn.
  next_worker           last value: the supervisor's most recent routing decision.
  last_replying_worker  last value: who produced the most recent reply (billing_agent, tech_agent,
                        supervisor, or human). Persisted across turns: it is what the backend
                        records as the conversation's active worker, and the supervisor's
                        "previous turn was handled by" hint at the start of the next turn.
  routing_reasoning     last value: the supervisor's latest justification.
  internal_logs         bounded append reducer (merge_internal_logs); each turn is delimited by a
                        unique marker so only that turn's entries are returned.
  customer_id           last value, set from the request each turn; read only by server-side tool
                        argument injection, never shown to a model.
  employee_context      last value, set from the request each turn (None for non-employees); read
                        only by the attendance node.
  conversation_thread_id
                        last value, set each turn; the attendance node's sub-agent thread is
                        "support:<conversation_thread_id>".
  regularization_awaiting_input
                        last value: the attendance sub-agent is paused on a question. Set by the
                        attendance node, cleared by the supervisor when it routes elsewhere.

  The graph is compiled with a checkpointer (MemorySaver in AgentRuntime). Runs use
  durability="exit": one checkpoint per completed turn; a failed or timed-out turn writes nothing.
  A new turn's input always starts a fresh run from START, so the checkpoint only carries memory
  (next_worker, last_replying_worker, logs), never half-finished work.
"""

from __future__ import annotations

import logging
import uuid
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, AnyMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.graph.state import CompiledStateGraph

from app.nodes.attendance_worker import NODE_NAME as ATTENDANCE_NODE_NAME
from app.nodes.attendance_worker import attendance_regularization_node
from app.nodes.context import AgentContext
from app.nodes.policies import HUMAN_HANDOFF_REPLY
from app.nodes.supervisor import NODE_NAME as SUPERVISOR_NODE_NAME
from app.nodes.supervisor import supervisor_node
from app.nodes.transcript import replies_given_this_turn
from app.nodes.workers import (
    BILLING_WORKER_NODE_NAME,
    SUPERVISOR_RESPONSE_NODE_NAME,
    TECH_WORKER_NODE_NAME,
    billing_worker_node,
    supervisor_response_node,
    tech_worker_node,
)
from app.schemas import MAX_INTERNAL_LOG_ENTRIES, WorkerName

logger = logging.getLogger("ai_service.graph")

# =================================================================================================
# Node names and routing tables
# =================================================================================================

NODE_SUPERVISOR = SUPERVISOR_NODE_NAME
NODE_BILLING_AGENT = BILLING_WORKER_NODE_NAME
NODE_TECH_AGENT = TECH_WORKER_NODE_NAME
NODE_SUPERVISOR_RESPONSE = SUPERVISOR_RESPONSE_NODE_NAME
NODE_HUMAN_HANDOFF = "human_handoff"
NODE_ATTENDANCE_REGULARIZATION = ATTENDANCE_NODE_NAME

# The supervisor's decision string (state.next_worker) -> the node that carries it out.
NODE_BY_ROUTING_DECISION: dict[str, str] = {
    WorkerName.BILLING_AGENT.value: NODE_BILLING_AGENT,
    WorkerName.TECH_AGENT.value: NODE_TECH_AGENT,
    WorkerName.ATTENDANCE_AGENT.value: NODE_ATTENDANCE_REGULARIZATION,
    WorkerName.SUPERVISOR.value: NODE_SUPERVISOR_RESPONSE,
    WorkerName.HUMAN.value: NODE_HUMAN_HANDOFF,
}

# At most this many replies per turn: the first answer plus one more specialist for a second topic.
MAX_REPLIES_PER_TURN = 2
# LangGraph step limit per run; the longest legitimate path is 4 steps (see section 4).
RECURSION_LIMIT = 12

MAX_RETAINED_INTERNAL_LOGS = MAX_INTERNAL_LOG_ENTRIES


# =================================================================================================
# State
# =================================================================================================


def merge_internal_logs(existing_log_entries: list[str] | None, new_log_entries: list[str] | None) -> list[str]:
    """Reducer for internal_logs: append, then keep only the newest MAX_RETAINED_INTERNAL_LOGS entries."""
    combined_log_entries = [*(existing_log_entries or []), *(new_log_entries or [])]
    return combined_log_entries[-MAX_RETAINED_INTERNAL_LOGS:]


class AgentState(TypedDict, total=False):
    """Graph state for one conversation thread; see section 5 of the module docstring."""

    messages: Annotated[list[AnyMessage], add_messages]
    next_worker: str
    last_replying_worker: str
    routing_reasoning: str
    internal_logs: Annotated[list[str], merge_internal_logs]
    customer_id: str
    # Set from the request each turn: the customer's employment record (EmployeeContext as a dict)
    # loaded by the backend from MongoDB, or None when they are not an employee with an office.
    employee_context: dict[str, Any] | None
    # The checkpointer thread of this conversation; the attendance node derives the sub-agent's
    # thread from it.
    conversation_thread_id: str
    # True while the attendance regularization sub-agent is waiting for the customer's answer to a
    # question; the supervisor routes the answer back to it (app/nodes/supervisor.py).
    regularization_awaiting_input: bool


# =================================================================================================
# Nodes defined here
# =================================================================================================


async def human_handoff_node(state: dict[str, Any]) -> dict[str, Any]:
    """Fixed handoff reply, no model call. The handoff is real: the backend escalates on "human"."""
    logger.info("Conversation handed off to a human", extra={"node": NODE_HUMAN_HANDOFF})
    return {
        "messages": [AIMessage(content=HUMAN_HANDOFF_REPLY, id=f"ai-{uuid.uuid4().hex}")],
        "last_replying_worker": WorkerName.HUMAN.value,
        "internal_logs": [f"{NODE_HUMAN_HANDOFF}: escalation reply sent; a human agent takes over"],
    }


# =================================================================================================
# Routing functions (conditional edges)
# =================================================================================================


def route_after_supervisor(state: dict[str, Any]) -> str:
    """Maps the supervisor's decision string to the next node, or END; see section 4."""
    routing_decision = state.get("next_worker", WorkerName.HUMAN.value)
    replies_so_far = replies_given_this_turn(state.get("messages", []))

    if not replies_so_far:
        return NODE_BY_ROUTING_DECISION.get(routing_decision, NODE_HUMAN_HANDOFF)

    if len(replies_so_far) >= MAX_REPLIES_PER_TURN:
        return END
    if routing_decision == WorkerName.SUPERVISOR.value:
        return END
    if routing_decision == state.get("last_replying_worker"):
        return END
    return NODE_BY_ROUTING_DECISION.get(routing_decision, END)


def route_after_worker(state: dict[str, Any]) -> str:
    """After a worker: back to the supervisor for review, or END; see section 4."""
    last_replying_worker = state.get("last_replying_worker")
    if last_replying_worker in (WorkerName.HUMAN.value, WorkerName.SUPERVISOR.value):
        return END
    # At the cap a review could only end the turn, so skip the model call and end it here.
    if len(replies_given_this_turn(state.get("messages", []))) >= MAX_REPLIES_PER_TURN:
        return END
    return NODE_SUPERVISOR


# =================================================================================================
# Compilation
# =================================================================================================


def build_support_graph(memory_checkpointer: BaseCheckpointSaver) -> CompiledStateGraph:
    """
    Builds and compiles the workflow drawn in section 1. `context_schema=AgentContext` declares the
    run-scoped dependencies (models, settings) nodes receive through LangGraph's runtime context;
    `memory_checkpointer` persists state between turns per thread.
    """
    graph_builder = StateGraph(AgentState, context_schema=AgentContext)

    graph_builder.add_node(NODE_SUPERVISOR, supervisor_node)
    graph_builder.add_node(NODE_BILLING_AGENT, billing_worker_node)
    graph_builder.add_node(NODE_TECH_AGENT, tech_worker_node)
    graph_builder.add_node(NODE_SUPERVISOR_RESPONSE, supervisor_response_node)
    graph_builder.add_node(NODE_HUMAN_HANDOFF, human_handoff_node)
    graph_builder.add_node(NODE_ATTENDANCE_REGULARIZATION, attendance_regularization_node)

    graph_builder.add_edge(START, NODE_SUPERVISOR)

    # Conditional routing from the supervisor: decision string -> worker node, or END.
    graph_builder.add_conditional_edges(
        NODE_SUPERVISOR,
        route_after_supervisor,
        {
            NODE_BILLING_AGENT: NODE_BILLING_AGENT,
            NODE_TECH_AGENT: NODE_TECH_AGENT,
            NODE_ATTENDANCE_REGULARIZATION: NODE_ATTENDANCE_REGULARIZATION,
            NODE_SUPERVISOR_RESPONSE: NODE_SUPERVISOR_RESPONSE,
            NODE_HUMAN_HANDOFF: NODE_HUMAN_HANDOFF,
            END: END,
        },
    )

    # Worker exits loop back to the supervisor, unless the worker ended the turn.
    for worker_node_name in (NODE_BILLING_AGENT, NODE_TECH_AGENT, NODE_ATTENDANCE_REGULARIZATION, NODE_SUPERVISOR_RESPONSE):
        graph_builder.add_conditional_edges(
            worker_node_name,
            route_after_worker,
            {NODE_SUPERVISOR: NODE_SUPERVISOR, END: END},
        )

    graph_builder.add_edge(NODE_HUMAN_HANDOFF, END)

    return graph_builder.compile(checkpointer=memory_checkpointer)
