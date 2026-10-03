"""
Read-only views over the `messages` channel, shared by the graph's routing functions and nodes.

Within one turn the channel holds, in order: the transcript sent by the backend (ending with the
customer's message), then for each worker that ran: its tool-call AIMessages, the ToolMessages
answering them, and its final reply AIMessage. These helpers answer the two questions the cyclic
graph needs: "which replies has this turn produced so far?" and "what should a model be shown?".
"""

from __future__ import annotations

from collections.abc import Sequence

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage


def is_final_reply(message: BaseMessage) -> bool:
    """An AIMessage addressed to the customer: not a tool-call request."""
    return isinstance(message, AIMessage) and not message.tool_calls


def replies_given_this_turn(messages: Sequence[BaseMessage]) -> list[AIMessage]:
    """
    Final replies produced after the customer's latest message, oldest first. Every turn's input
    ends with a customer (Human) message, so everything after the last HumanMessage belongs to the
    current turn.
    """
    latest_customer_index = max(
        (message_index for message_index, message in enumerate(messages) if isinstance(message, HumanMessage)),
        default=-1,
    )
    return [message for message in messages[latest_customer_index + 1 :] if is_final_reply(message)]


def conversation_messages_for_model(messages: Sequence[BaseMessage], max_messages: int) -> list[BaseMessage]:
    """
    The most recent `max_messages` conversation messages (customer messages and final replies),
    without other workers' tool-call AIMessages and ToolMessages. Those belong to another worker's
    tools and would be invalid if a context window cut a tool call off from its result; each worker
    appends its own tool exchange separately.
    """
    conversation_messages = [
        message for message in messages if not isinstance(message, ToolMessage) and not (isinstance(message, AIMessage) and message.tool_calls)
    ]
    return conversation_messages[-max_messages:]
