"""Turning the supervisor model's raw text into a routing decision, and the routing edges."""

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END
from pydantic import ValidationError

from app.graph import (
    NODE_BILLING_AGENT,
    NODE_HUMAN_HANDOFF,
    NODE_SUPERVISOR,
    NODE_TECH_AGENT,
    route_after_supervisor,
    route_after_worker,
)
from app.nodes.supervisor import NextActionEnum, parse_supervisor_output


@pytest.mark.parametrize(
    "raw_text",
    [
        '{"next_action": "BILLING_WORKER", "reasoning": "invoice question"}',
        '```json\n{"next_action": "billing worker", "reasoning": "invoice question"}\n```',
        'Sure! Here is my decision: {"next_action": "Billing-Worker", "reasoning": "invoice question"} Thanks.',
    ],
)
def test_formatting_drift_is_accepted(raw_text):
    assert parse_supervisor_output(raw_text).next_action is NextActionEnum.BILLING_WORKER


def test_extra_keys_are_ignored_and_reasoning_is_collapsed():
    decision = parse_supervisor_output(
        json.dumps({"next_action": "FINISH", "reasoning": "  all   answered \n ", "confidence": 0.9})
    )
    assert decision.next_action is NextActionEnum.FINISH
    assert decision.reasoning == "all answered"


@pytest.mark.parametrize("raw_text", ["", "I think billing should handle this.", '{"next_action": "BILLING'])
def test_non_json_is_rejected(raw_text):
    with pytest.raises(json.JSONDecodeError):
        parse_supervisor_output(raw_text)


@pytest.mark.parametrize(
    "payload",
    [
        {"next_action": "REFUND_WORKER", "reasoning": "unknown action"},
        {"next_action": "TECH_WORKER"},
        ["TECH_WORKER"],
    ],
)
def test_schema_violations_are_rejected(payload):
    with pytest.raises(ValidationError):
        parse_supervisor_output(json.dumps(payload))


def _turn(*replies):
    return [HumanMessage(content="question", id="customer-1"), *replies]


def test_routing_sends_the_first_decision_to_the_chosen_worker():
    assert route_after_supervisor({"next_worker": "billing_agent", "messages": _turn()}) == NODE_BILLING_AGENT
    assert route_after_supervisor({"next_worker": "unknown_worker", "messages": _turn()}) == NODE_HUMAN_HANDOFF


def test_review_ends_the_turn_on_finish_or_the_same_specialist_again():
    one_reply = _turn(AIMessage(content="Here is the billing answer."))
    assert route_after_supervisor({"next_worker": "supervisor", "messages": one_reply}) == END
    assert (
        route_after_supervisor(
            {"next_worker": "billing_agent", "last_replying_worker": "billing_agent", "messages": one_reply}
        )
        == END
    )
    assert (
        route_after_supervisor(
            {"next_worker": "tech_agent", "last_replying_worker": "billing_agent", "messages": one_reply}
        )
        == NODE_TECH_AGENT
    )


def test_a_turn_never_gets_more_than_two_replies():
    two_replies = _turn(AIMessage(content="first"), AIMessage(content="second"))
    assert route_after_worker({"last_replying_worker": "tech_agent", "messages": two_replies}) == END
    assert route_after_supervisor({"next_worker": "tech_agent", "messages": two_replies}) == END


def test_workers_return_to_the_supervisor_unless_the_turn_was_handed_off():
    one_reply = _turn(AIMessage(content="answer"))
    assert route_after_worker({"last_replying_worker": "billing_agent", "messages": one_reply}) == NODE_SUPERVISOR
    assert route_after_worker({"last_replying_worker": "human", "messages": one_reply}) == END
