"""
Whole support turns through the compiled LangGraph, with scripted models in place of Groq:
routing, tool use, the second-topic loop, the output guard, and every fallback to a human.
"""

from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from app.graph import build_support_graph
from app.nodes.context import AgentContext
from app.nodes.policies import HUMAN_HANDOFF_REPLY
from app.nodes.transcript import replies_given_this_turn
from app.nodes.workers import check_invoice_status
from tests.fakes import ScriptedChatModel, routing_reply, text_reply, tool_call_reply

CUSTOMER_ID = "customer-a"


async def run_turn(supervisor_model, worker_model, customer_message, *, simulated_tools_enabled=True):
    graph = build_support_graph(InMemorySaver())
    final_state = await graph.ainvoke(
        {
            "messages": [HumanMessage(content=customer_message, id="customer-message-1")],
            "customer_id": CUSTOMER_ID,
            "conversation_thread_id": "thread-1",
            "internal_logs": [],
        },
        config={"configurable": {"thread_id": "thread-1"}},
        context=AgentContext(
            supervisor_model=supervisor_model,
            worker_model=worker_model,
            max_context_messages=10,
            simulated_tools_enabled=simulated_tools_enabled,
        ),
    )
    return final_state, [reply.content for reply in replies_given_this_turn(final_state["messages"])]


async def test_billing_question_uses_the_tool_for_the_signed_in_customer_only():
    supervisor = ScriptedChatModel(replies=[routing_reply("BILLING_WORKER"), routing_reply("FINISH")])
    worker = ScriptedChatModel(
        replies=[
            tool_call_reply("check_invoice_status", {"user_id": "someone-else"}),
            text_reply("Our records show your October invoice was paid on time."),
        ]
    )

    final_state, replies = await run_turn(supervisor, worker, "Was my last invoice paid?")

    assert replies == ["Our records show your October invoice was paid on time."]
    assert final_state["last_replying_worker"] == "billing_agent"
    assert worker.bound_tool_names == ["check_invoice_status"]
    tool_messages = [message for message in final_state["messages"] if isinstance(message, ToolMessage)]
    assert [message.content for message in tool_messages] == [check_invoice_status.invoke({"user_id": CUSTOMER_ID})]


async def test_a_message_with_two_topics_gets_an_answer_from_each_specialist():
    supervisor = ScriptedChatModel(replies=[routing_reply("TECH_WORKER"), routing_reply("BILLING_WORKER")])
    worker = ScriptedChatModel(
        replies=[
            text_reply("For the 502 error, please retry the export with a smaller date range."),
            text_reply("Your plan renews on the first of next month."),
        ]
    )

    final_state, replies = await run_turn(
        supervisor, worker, "I get ERR_502_GATEWAY on exports, and when does my plan renew?"
    )

    assert len(replies) == 2
    assert final_state["last_replying_worker"] == "billing_agent"
    # The second specialist is told a colleague already answered part of the message.
    second_specialist_prompt = worker.received_inputs[1][0].content
    assert "A colleague has already replied" in second_specialist_prompt


async def test_unparseable_routing_hands_the_conversation_to_a_human():
    supervisor = ScriptedChatModel(replies=[text_reply("billing, probably")])
    worker = ScriptedChatModel(replies=[])

    final_state, replies = await run_turn(supervisor, worker, "Hello?")

    assert replies == [HUMAN_HANDOFF_REPLY]
    assert final_state["last_replying_worker"] == "human"
    assert worker.received_inputs == []


async def test_a_reply_that_only_claims_actions_is_replaced_by_a_handoff():
    supervisor = ScriptedChatModel(replies=[routing_reply("BILLING_WORKER")])
    worker = ScriptedChatModel(replies=[text_reply("I've processed your refund. Your account has been credited.")])

    final_state, replies = await run_turn(supervisor, worker, "Refund me", simulated_tools_enabled=False)

    assert replies == [HUMAN_HANDOFF_REPLY]
    assert final_state["next_worker"] == "human"
    assert any("output_guard" in log_entry and "escalated" in log_entry for log_entry in final_state["internal_logs"])


async def test_a_failing_model_hands_off_instead_of_crashing_the_turn():
    supervisor = ScriptedChatModel(replies=[routing_reply("TECH_WORKER")])
    worker = ScriptedChatModel(replies=[RuntimeError("rate limited")])

    final_state, replies = await run_turn(supervisor, worker, "The app crashes")

    assert replies == [HUMAN_HANDOFF_REPLY]
    assert any("model_invocation_failed" in log_entry for log_entry in final_state["internal_logs"])


async def test_tools_are_not_offered_when_simulated_tools_are_disabled():
    supervisor = ScriptedChatModel(replies=[routing_reply("BILLING_WORKER"), routing_reply("FINISH")])
    worker = ScriptedChatModel(replies=[text_reply("A member of the billing team can look at invoices with you.")])

    await run_turn(supervisor, worker, "Show my invoices", simulated_tools_enabled=False)

    assert worker.bound_tool_names == []
    system_prompt = worker.received_inputs[0][0].content
    assert "check_invoice_status" not in system_prompt
