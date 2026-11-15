"""
The NSK assistant (app/nodes/nsk_assistant/) with scripted models and in-memory systems:
classification and the tone rules, the number check, a turn from classification to checked reply
(tools carry the actor token, only allowed tools are offered, every fact traced to a source,
refusals for invented numbers and uncited policy, markers, memory), suggestions, and the endpoint.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import SystemMessage

from app.agent import AgentTimeoutError
from app.knowledge.external_schemas import ExternalPassage
from app.knowledge.schemas import RetrievedPassage
from app.main import app
from app.nodes.nsk_assistant import (
    NskAssistant,
    NskToolRefusedError,
    NskTurnInput,
    NskTurnResult,
    SearchSettings,
)
from app.nodes.nsk_assistant.assistant import NOT_FOUND_REPLY, REFUSED_REPLY, split_marker
from app.nodes.nsk_assistant.classifier import apply_tone_rules, fallback_classification, parse_classification
from app.nodes.nsk_assistant.grounding import check_numbers, numbers_in
from app.nodes.nsk_assistant.schemas import Action, ActionKind, Classification, Intent, Sentiment, TurnOutcome
from app.nodes.nsk_assistant.suggestions import fallback_suggestions, parse_suggestions
from tests.conftest import TEST_INTERNAL_API_KEY
from tests.fakes import ScriptedChatModel, json_reply, text_reply, tool_call_reply

ACTOR_TOKEN = "v1.payload.signature"
SESSION_ID = "64b0000000000000000000d1"
DEPARTMENT_ID = "64b0000000000000000000e1"
DOCUMENT_ID = "64b0000000000000000000f1"
TODAY = date(2026, 11, 14)  # a Saturday
SELF_SERVICE = ["ATTENDANCE_AUDIT", "POLICY_QA", "GENERAL_HELP"]
SELF_TOOLS = ["my_attendance_today", "my_attendance_month", "my_leave_balances", "my_leave_requests", "knowledge_scope"]
SEARCH = SearchSettings(top_k=5, min_relevance=0.5, excerpt_chars=300)
BALANCES = {
    "leave_year": {"from": "2026-04-01", "to": "2027-03-31"},
    "balances": [{"code": "CL", "name": "Casual Leave", "available_days": 6, "held_for_pending_requests_days": 0}],
}


def classification(intent: str, sentiment: str = "NEUTRAL", confidence: float = 0.9, **extra: Any) -> Any:
    return json_reply({"intent": intent, "confidence": confidence, "sentiment": sentiment, "topic": None, **extra})


def suggestions(*items: tuple[str, str]) -> Any:
    return json_reply({"suggestions": [{"text": text, "intent": intent} for text, intent in items]})


def turn_input(message: str, **overrides: Any) -> NskTurnInput:
    return NskTurnInput.model_validate(
        {
            "actor_token": ACTOR_TOKEN,
            "user": {"name": "Asha", "role_label": "Employee"},
            "today": TODAY.isoformat(),
            "time_zone": "Asia/Kolkata",
            "message": message,
            "history": [],
            "memory": [],
            "allowed_intents": SELF_SERVICE,
            "allowed_tools": SELF_TOOLS,
            **overrides,
        }
    )


class FakeNskSystems:
    """The backend's tool endpoint in memory: answers by tool name and records every call."""

    def __init__(self, answers: dict[str, Any] | None = None, refuse: set[str] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any], str]] = []
        self._answers = answers or {}
        self._refuse = refuse or set()

    async def call_tool(self, name: str, arguments: dict[str, Any], actor_token: str) -> dict[str, Any]:
        self.calls.append((name, arguments, actor_token))
        if name in self._refuse:
            raise NskToolRefusedError("TOOL_FORBIDDEN", "This needs access the person does not have")
        return self._answers[name]


class FakeSearch:
    def __init__(self, passages: list[RetrievedPassage], external: list[ExternalPassage] | None = None) -> None:
        self.passages = passages
        self.external = external or []
        self.searches: list[dict[str, Any]] = []
        self.external_searches: list[dict[str, Any]] = []

    async def search_external_passages(self, *, question: str, include_unapproved: bool, limit: int):
        self.external_searches.append({"question": question, "include_unapproved": include_unapproved, "limit": limit})
        return self.external

    async def search_department_passages(self, *, department_ids: list[str], question: str, limit: int):
        self.searches.append({"department_ids": department_ids, "question": question, "limit": limit})
        return self.passages


def assistant(
    answer_replies: list[Any],
    json_replies: list[Any],
    systems: FakeNskSystems | None = None,
    search: FakeSearch | None = None,
) -> tuple[NskAssistant, ScriptedChatModel, ScriptedChatModel]:
    answer_model = ScriptedChatModel(replies=answer_replies)
    json_model = ScriptedChatModel(replies=json_replies)
    return (
        NskAssistant(answer_model, json_model, systems or FakeNskSystems(), search, SEARCH),
        answer_model,
        json_model,
    )


# =================================================================================================
# Classification
# =================================================================================================


def test_classification_reads_the_model_and_keeps_known_entities_once():
    parsed = parse_classification(
        json.dumps(
            {
                "intent": "ATTENDANCE_AUDIT",
                "confidence": 1.7,
                "sentiment": "NEUTRAL",
                "topic": "  attendance   in October ",
                "entities": [
                    {"kind": "date", "value": "October"},
                    {"kind": "date", "value": "october"},
                    {"kind": "salary", "value": "a lot"},
                    {"kind": "employeeName", "value": "  "},
                ],
            }
        ),
        "How was my attendance in October?",
    )
    assert parsed.intent is Intent.ATTENDANCE_AUDIT
    assert parsed.confidence == 1.0
    assert parsed.topic == "attendance in October"
    assert [(entity.kind.value, entity.value) for entity in parsed.entities] == [("date", "October")]


def test_tone_rules_only_raise_the_sentiment():
    assert apply_tone_rules(Sentiment.NEUTRAL, "I need my payslip urgently") is Sentiment.URGENT
    assert apply_tone_rules(Sentiment.POSITIVE, "the punch button is still not working") is Sentiment.FRUSTRATED
    assert apply_tone_rules(Sentiment.URGENT, "my manager keeps harassing me") is Sentiment.SENSITIVE_HR
    assert apply_tone_rules(Sentiment.SENSITIVE_HR, "please answer asap!!") is Sentiment.SENSITIVE_HR
    assert apply_tone_rules(Sentiment.NEUTRAL, "What is my leave balance?") is Sentiment.NEUTRAL


def test_an_unusable_classification_falls_back_to_general_help_with_the_rules():
    with pytest.raises(ValueError):
        parse_classification("I think it is about leave", "where is my leave?")
    fallback = fallback_classification("this is urgent")
    assert (fallback.intent, fallback.sentiment, fallback.confidence) == (Intent.GENERAL_HELP, Sentiment.URGENT, 0.0)


# =================================================================================================
# The number check
# =================================================================================================


def test_numbers_are_compared_without_formatting():
    assert numbers_in("₹1,20,000 on 03 Nov, 1.50 days at 09:05 [2]\n1. first") == {"120000", "3", "1.5", "9", "5"}


def test_sentences_with_numbers_not_in_the_evidence_are_removed():
    checked = check_numbers(
        "You have 6 casual leave days [1]. You also earned 4 bonus days. Enjoy your break.",
        ['{"available_days": 6}'],
    )
    assert checked.text == "You have 6 casual leave days [1]. Enjoy your break."
    assert checked.unverified == ("4",)
    assert checked.is_usable


def test_a_reply_that_loses_most_of_its_facts_is_not_usable():
    checked = check_numbers("You worked 9 days. You were late 3 times. Fine.", ['{"days_present": 8}'])
    assert not checked.is_usable


def test_list_numbering_is_not_a_fact():
    checked = check_numbers("1. Casual: 6 days [1]\n2. Sick: 4 days [1]", ['{"CL": 6, "SL": 4}'])
    assert checked.text == "1. Casual: 6 days [1]\n2. Sick: 4 days [1]"


# =================================================================================================
# A turn
# =================================================================================================


async def test_an_attendance_answer_cites_the_tool_it_read_with_the_actor_token():
    systems = FakeNskSystems({"my_leave_balances": {"result": BALANCES, "source": "Your leave balances"}})
    nsk, answer_model, _ = assistant(
        [tool_call_reply("get_my_leave_balances", {}), text_reply("You have 6 casual leave days left [1].")],
        [
            classification("ATTENDANCE_AUDIT", topic="leave balance"),
            suggestions(("Show my leave requests", "ATTENDANCE_AUDIT")),
        ],
        systems,
    )
    result = await nsk.answer(turn_input("How many casual leaves do I have?"))

    assert result.outcome is TurnOutcome.ANSWERED
    assert result.reply == "You have 6 casual leave days left [1]."
    assert [(source.kind, source.tool, source.label) for source in result.sources] == [
        ("tool", "my_leave_balances", "Your leave balances")
    ]
    assert systems.calls == [("my_leave_balances", {}, ACTOR_TOKEN)]
    assert result.tools_used == ["my_leave_balances"]
    assert result.suggestions[0].text == "Show my leave requests"
    assert len(result.suggestions) == 3
    assert "search_company_docs" in answer_model.bound_tool_names


async def test_only_the_tools_the_backend_listed_are_offered():
    nsk, answer_model, _ = assistant(
        [text_reply("Hello! Ask me about your attendance or leave.")],
        [classification("GENERAL_HELP"), suggestions()],
    )
    await nsk.answer(turn_input("hi", allowed_tools=["my_leave_balances"]))
    assert answer_model.bound_tool_names == ["get_my_leave_balances"]


async def test_an_intent_the_person_may_not_use_is_not_answered_and_no_tool_runs():
    systems = FakeNskSystems()
    nsk, answer_model, _ = assistant(
        [],
        [classification("PROFILE_LOOKUP", entities=[{"kind": "employeeName", "value": "Rahul"}]), suggestions()],
        systems,
    )
    result = await nsk.answer(turn_input("Show me Rahul's profile"))

    assert result.outcome is TurnOutcome.NOT_ALLOWED
    assert "can't help with that" in result.reply
    assert answer_model.received_inputs == []
    assert systems.calls == []
    assert result.classification.entities[0].value == "Rahul"


async def test_an_invented_number_gets_the_reply_refused():
    systems = FakeNskSystems({"my_leave_balances": {"result": BALANCES, "source": "Your leave balances"}})
    nsk, _, _ = assistant(
        [tool_call_reply("get_my_leave_balances", {}), text_reply("You have 9 casual leave days left [1].")],
        [classification("ATTENDANCE_AUDIT"), suggestions()],
        systems,
    )
    result = await nsk.answer(turn_input("How many casual leaves do I have?"))
    assert (result.outcome, result.reply, result.sources) == (TurnOutcome.REFUSED, REFUSED_REPLY, [])


async def test_a_tool_answer_without_marks_is_given_its_tool_sources():
    systems = FakeNskSystems({"my_leave_balances": {"result": BALANCES, "source": "Your leave balances"}})
    nsk, _, _ = assistant(
        [tool_call_reply("get_my_leave_balances", {}), text_reply("You have 6 casual leave days left.")],
        [classification("ATTENDANCE_AUDIT"), suggestions()],
        systems,
    )
    result = await nsk.answer(turn_input("How many casual leaves do I have?"))
    assert result.outcome is TurnOutcome.ANSWERED
    assert [source.label for source in result.sources] == ["Your leave balances"]


def passage(score: float = 0.8) -> RetrievedPassage:
    return RetrievedPassage(
        document_id=DOCUMENT_ID,
        chunk_index=2,
        text="The notice period is 60 days for permanent employees.",
        heading_path=["Exit policy"],
        page=4,
        score=score,
        department_id=DEPARTMENT_ID,
    )


async def test_a_policy_answer_cites_its_document_found_in_readable_departments_only():
    systems = FakeNskSystems(
        {"knowledge_scope": {"result": {"departments": [{"id": DEPARTMENT_ID, "name": "People"}]}}}
    )
    search = FakeSearch([passage(), passage(score=0.2)])
    nsk, answer_model, _ = assistant(
        [tool_call_reply("search_company_docs", {"query": "notice period"}), text_reply("It is 60 days [1].")],
        [classification("POLICY_QA"), suggestions()],
        systems,
        search,
    )
    result = await nsk.answer(turn_input("What is the notice period?"))

    assert result.outcome is TurnOutcome.ANSWERED
    assert search.searches == [{"department_ids": [DEPARTMENT_ID], "question": "notice period", "limit": 5}]
    [source] = result.sources
    assert (source.kind, source.document_id, source.department_id, source.page) == (
        "document",
        DOCUMENT_ID,
        DEPARTMENT_ID,
        4,
    )
    assert result.tools_used == ["knowledge_scope"]
    # The passage below KNOWLEDGE_MIN_RELEVANCE is never shown to the model.
    assert json.loads(answer_model.received_inputs[1][-1].content)["passages"][0]["source"] == 1
    assert len(json.loads(answer_model.received_inputs[1][-1].content)["passages"]) == 1


async def test_a_policy_answer_that_cites_nothing_is_refused():
    systems = FakeNskSystems(
        {"knowledge_scope": {"result": {"departments": [{"id": DEPARTMENT_ID, "name": "People"}]}}}
    )
    nsk, _, _ = assistant(
        [tool_call_reply("search_company_docs", {"query": "notice period"}), text_reply("It is 60 days.")],
        [classification("POLICY_QA"), suggestions()],
        systems,
        FakeSearch([passage()]),
    )
    result = await nsk.answer(turn_input("What is the notice period?"))
    assert result.outcome is TurnOutcome.REFUSED


async def test_nothing_found_says_what_is_missing():
    systems = FakeNskSystems({"knowledge_scope": {"result": {"departments": []}}})
    nsk, _, _ = assistant(
        [
            tool_call_reply("search_company_docs", {"query": "sabbatical"}),
            text_reply("NOT_FOUND: The documents you can read have no sabbatical policy."),
        ],
        [classification("POLICY_QA"), suggestions()],
        systems,
        FakeSearch([]),
    )
    result = await nsk.answer(turn_input("Can I take a sabbatical?"))
    assert (result.outcome, result.reply) == (
        TurnOutcome.NOT_FOUND,
        "The documents you can read have no sabbatical policy.",
    )


def test_markers_set_the_outcome():
    assert split_marker("**CLARIFY:** Which month?") == (TurnOutcome.CLARIFY, "Which month?")
    assert split_marker("not_found: nothing") == (TurnOutcome.NOT_FOUND, "nothing")
    assert split_marker("You have 6 days.") == (TurnOutcome.ANSWERED, "You have 6 days.")
    assert NOT_FOUND_REPLY


async def test_earlier_sessions_are_numbered_sources_for_questions_about_the_past():
    memory = [
        {
            "session_id": SESSION_ID,
            "title": "How many casual leaves do I have?",
            "date": "2026-11-13",
            "topics": ["leave balance"],
            "entities": [],
        }
    ]
    nsk, answer_model, _ = assistant(
        [text_reply("Yesterday you checked your leave balance [1].")],
        [classification("GENERAL_HELP"), suggestions()],
    )
    result = await nsk.answer(turn_input("What did we check yesterday?", memory=memory))

    assert result.outcome is TurnOutcome.ANSWERED
    assert [(source.kind, source.session_id) for source in result.sources] == [("conversation", SESSION_ID)]
    system_prompt = answer_model.received_inputs[0][0]
    assert isinstance(system_prompt, SystemMessage)
    assert '[1] 2026-11-13: "How many casual leaves do I have?"' in system_prompt.content


async def test_a_refused_tool_call_is_explained_to_the_model():
    systems = FakeNskSystems(refuse={"my_leave_balances"})
    nsk, answer_model, _ = assistant(
        [tool_call_reply("get_my_leave_balances", {}), text_reply("NOT_FOUND: I can't read your leave balances.")],
        [classification("ATTENDANCE_AUDIT"), suggestions()],
        systems,
    )
    result = await nsk.answer(turn_input("How many casual leaves do I have?"))
    tool_message = answer_model.received_inputs[1][-1]
    assert "TOOL_FORBIDDEN" in tool_message.content
    assert result.outcome is TurnOutcome.NOT_FOUND


async def test_an_urgent_message_gets_the_urgent_tone():
    nsk, answer_model, _ = assistant(
        [text_reply("Open Attendance and punch in now.")], [classification("GENERAL_HELP"), suggestions()]
    )
    result = await nsk.answer(turn_input("I need to punch in right now!!"))
    assert result.classification.sentiment is Sentiment.URGENT
    assert "in a hurry" in answer_model.received_inputs[0][0].content


async def test_a_failed_classifier_and_suggester_still_give_an_answer_and_suggestions():
    nsk, _, _ = assistant(
        [text_reply("I can help with your attendance and leave.")], [text_reply("not json"), RuntimeError("down")]
    )
    result = await nsk.answer(turn_input("hello"))
    assert result.classification.intent is Intent.GENERAL_HELP
    assert result.outcome is TurnOutcome.ANSWERED
    assert [suggestion.intent for suggestion in result.suggestions] == [
        Intent.GENERAL_HELP,
        Intent.ATTENDANCE_AUDIT,
        Intent.ATTENDANCE_AUDIT,
    ]


# =================================================================================================
# Suggestions
# =================================================================================================


def test_suggestions_keep_allowed_intents_once():
    parsed = parse_suggestions(
        json.dumps(
            {
                "suggestions": [
                    {"text": "Show my attendance", "intent": "ATTENDANCE_AUDIT"},
                    {"text": "show my attendance", "intent": "ATTENDANCE_AUDIT"},
                    {"text": "Look up Rahul", "intent": "PROFILE_LOOKUP"},
                    {"text": "What is the leave policy?", "intent": "POLICY_QA"},
                ]
            }
        ),
        [Intent.ATTENDANCE_AUDIT, Intent.POLICY_QA],
    )
    assert [suggestion.text for suggestion in parsed] == ["Show my attendance", "What is the leave policy?"]


def test_fallback_suggestions_start_with_the_current_intent():
    fallback = fallback_suggestions([Intent.ATTENDANCE_AUDIT, Intent.POLICY_QA], Intent.POLICY_QA)
    assert [suggestion.intent for suggestion in fallback] == [
        Intent.POLICY_QA,
        Intent.POLICY_QA,
        Intent.ATTENDANCE_AUDIT,
    ]


# =================================================================================================
# The endpoint
# =================================================================================================

AUTHORISED = {"X-Internal-Api-Key": TEST_INTERNAL_API_KEY}
VALID_TURN = turn_input("How many casual leaves do I have?").model_dump(mode="json")


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_the_endpoint_requires_the_key_and_a_valid_turn(client):
    assert client.post("/ai/nsk/turn", json=VALID_TURN).status_code == 401
    assert (
        client.post("/ai/nsk/turn", json={**VALID_TURN, "allowed_intents": []}, headers=AUTHORISED).status_code == 422
    )
    assert client.post("/ai/nsk/turn", json={**VALID_TURN, "role": "admin"}, headers=AUTHORISED).status_code == 422


def test_without_a_groq_key_the_endpoint_says_unavailable(client):
    assert client.post("/ai/nsk/turn", json=VALID_TURN, headers=AUTHORISED).status_code == 503


def test_the_endpoint_returns_the_checked_turn(client, monkeypatch):
    async def answered(received):
        assert received.actor_token == ACTOR_TOKEN
        return NskTurnResult(
            outcome=TurnOutcome.ANSWERED,
            reply="You have 6 casual leave days left [1].",
            classification=Classification(intent=Intent.ATTENDANCE_AUDIT, sentiment=Sentiment.NEUTRAL, confidence=0.9),
            sources=[],
            suggestions=[],
            tools_used=["my_leave_balances"],
            usage=None,
        )

    monkeypatch.setattr(app.state.agent_runtime, "process_nsk_turn", answered)
    response = client.post("/ai/nsk/turn", json=VALID_TURN, headers=AUTHORISED)
    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "answered"
    assert body["classification"]["intent"] == "ATTENDANCE_AUDIT"
    assert body["tools_used"] == ["my_leave_balances"]


def test_a_timed_out_turn_returns_504(client, monkeypatch):
    async def timing_out(received):
        raise AgentTimeoutError("turn_timeout", "too slow")

    monkeypatch.setattr(app.state.agent_runtime, "process_nsk_turn", timing_out)
    assert client.post("/ai/nsk/turn", json=VALID_TURN, headers=AUTHORISED).status_code == 504


# =================================================================================================
# People tools
# =================================================================================================

PEOPLE_INTENTS = ["PROFILE_LOOKUP", *SELF_SERVICE]
PEOPLE_TOOLS = [*SELF_TOOLS, "lookup_employee_profile", "get_department_metrics"]
CANDIDATES = [
    {"employee_code": "NSK0104", "name": "Rahul Sharma", "designation": "Data Engineer", "department": "Data"},
    {"employee_code": "NSK0233", "name": "Rahul Verma", "designation": "Analyst", "department": "Finance"},
]


async def test_an_ambiguous_name_asks_which_person_and_offers_each_as_a_card():
    systems = FakeNskSystems(
        {
            "lookup_employee_profile": {
                "result": {"matches": 2, "candidates": CANDIDATES, "more_not_shown": 0},
                "source": 'People matching "Rahul"',
            }
        }
    )
    nsk, answer_model, _ = assistant(
        [
            tool_call_reply("lookup_employee_profile", {"query": "Rahul"}),
            text_reply("CLARIFY: I found Rahul Sharma and Rahul Verma [1]. Which one do you mean?"),
        ],
        [classification("PROFILE_LOOKUP"), suggestions(("Show Rahul's leave", "PROFILE_LOOKUP"))],
        systems,
    )
    result = await nsk.answer(
        turn_input("Show me Rahul's profile", allowed_intents=PEOPLE_INTENTS, allowed_tools=PEOPLE_TOOLS)
    )

    assert result.outcome is TurnOutcome.CLARIFY
    assert systems.calls == [("lookup_employee_profile", {"query": "Rahul"}, ACTOR_TOKEN)]
    assert [(suggestion.text, suggestion.intent) for suggestion in result.suggestions] == [
        ("Look up Rahul Sharma (NSK0104)", Intent.PROFILE_LOOKUP),
        ("Look up Rahul Verma (NSK0233)", Intent.PROFILE_LOOKUP),
    ]
    assert {"lookup_employee_profile", "get_department_metrics"} <= set(answer_model.bound_tool_names)
    assert "never try to complete them" in answer_model.received_inputs[0][0].content


async def test_a_profile_answer_may_give_the_masked_phone_but_not_invent_a_salary():
    profile = {
        "matches": 1,
        "profile": {
            "name": "Rahul Sharma",
            "employee_code": "NSK0104",
            "phone": "+••••••••••10",
            "salary": {"hidden": True, "note": "Salary is not shown to your role"},
        },
    }
    systems = FakeNskSystems(
        {"lookup_employee_profile": {"result": profile, "source": "Profile: Rahul Sharma (NSK0104)"}}
    )
    nsk, _, _ = assistant(
        [
            tool_call_reply("lookup_employee_profile", {"query": "NSK0104"}),
            text_reply("Rahul Sharma (NSK0104) can be reached on +••••••••••10 [1]."),
        ],
        [classification("PROFILE_LOOKUP"), suggestions()],
        systems,
    )
    answered = await nsk.answer(
        turn_input("Rahul Sharma's phone?", allowed_intents=PEOPLE_INTENTS, allowed_tools=PEOPLE_TOOLS)
    )
    assert answered.outcome is TurnOutcome.ANSWERED
    assert answered.reply == "Rahul Sharma (NSK0104) can be reached on +••••••••••10 [1]."

    systems = FakeNskSystems(
        {"lookup_employee_profile": {"result": profile, "source": "Profile: Rahul Sharma (NSK0104)"}}
    )
    nsk, _, _ = assistant(
        [
            tool_call_reply("lookup_employee_profile", {"query": "NSK0104"}),
            text_reply("Rahul earns 95,000 a month [1]."),
        ],
        [classification("PROFILE_LOOKUP"), suggestions()],
        systems,
    )
    invented = await nsk.answer(
        turn_input("What does Rahul earn?", allowed_intents=PEOPLE_INTENTS, allowed_tools=PEOPLE_TOOLS)
    )
    assert invented.outcome is TurnOutcome.REFUSED


async def test_people_tools_are_not_offered_to_self_service():
    nsk, answer_model, _ = assistant([text_reply("Hello!")], [classification("GENERAL_HELP"), suggestions()])
    await nsk.answer(turn_input("hi"))
    assert "lookup_employee_profile" not in answer_model.bound_tool_names
    assert "get_department_metrics" not in answer_model.bound_tool_names


# =================================================================================================
# Offboarding: "Rahul is leaving"
# =================================================================================================

HR_INTENTS = ["OFFBOARDING_WORKFLOW", *PEOPLE_INTENTS]
HR_TOOLS = [*PEOPLE_TOOLS, "find_offboarding_employee"]
RAHUL_ID = "0123456789abcdef01234567"
FOUND_RAHUL = {
    "result": {
        "matches": 1,
        "employee": {
            "employee_id": RAHUL_ID,
            "employee_code": "NSK0104",
            "name": "Rahul Sharma",
            "designation": "Data Engineer",
            "employment_status": "Active",
            "offboarding": None,
        },
        "actions": [
            {"kind": "START_OFFBOARDING", "employee_id": RAHUL_ID},
            {"kind": "VIEW_PROFILE", "employee_id": RAHUL_ID},
            {"kind": "VIEW_PROFILE", "employee_id": RAHUL_ID},
            {"kind": "UNKNOWN", "employee_id": RAHUL_ID},
        ],
    },
    "source": "Profile: Rahul Sharma (NSK0104)",
}


async def test_someone_leaving_is_found_and_the_cards_are_offered():
    systems = FakeNskSystems({"find_offboarding_employee": FOUND_RAHUL})
    nsk, answer_model, _ = assistant(
        [
            tool_call_reply("find_offboarding_employee", {"query": "Rahul Sharma"}),
            text_reply(
                "That is Rahul Sharma (NSK0104), Data Engineer [1]. Use the cards below to start the offboarding "
                "package or view the profile first."
            ),
        ],
        [classification("OFFBOARDING_WORKFLOW"), suggestions()],
        systems,
    )
    result = await nsk.answer(turn_input("Rahul Sharma is leaving", allowed_intents=HR_INTENTS, allowed_tools=HR_TOOLS))
    assert result.outcome is TurnOutcome.ANSWERED
    assert systems.calls == [("find_offboarding_employee", {"query": "Rahul Sharma"}, ACTOR_TOKEN)]
    assert [(action.kind.value, action.employee_id) for action in result.actions] == [
        ("START_OFFBOARDING", RAHUL_ID),
        ("VIEW_PROFILE", RAHUL_ID),
    ]
    assert [source.tool for source in result.sources] == ["find_offboarding_employee"]
    assert "find_offboarding_employee" in answer_model.bound_tool_names
    assert "Never say\n  offboarding has started" in answer_model.received_inputs[0][0].content


async def test_an_ambiguous_leaver_is_offered_as_offboarding_cards():
    systems = FakeNskSystems(
        {
            "find_offboarding_employee": {
                "result": {"matches": 2, "candidates": CANDIDATES, "more_not_shown": 0},
                "source": 'People matching "Rahul"',
            }
        }
    )
    nsk, _, _ = assistant(
        [
            tool_call_reply("find_offboarding_employee", {"query": "Rahul"}),
            text_reply("CLARIFY: I found Rahul Sharma and Rahul Verma [1]. Which one is leaving?"),
        ],
        [classification("OFFBOARDING_WORKFLOW"), suggestions()],
        systems,
    )
    result = await nsk.answer(turn_input("Rahul is leaving", allowed_intents=HR_INTENTS, allowed_tools=HR_TOOLS))
    assert result.outcome is TurnOutcome.CLARIFY
    assert [(suggestion.text, suggestion.intent) for suggestion in result.suggestions] == [
        ("Offboard Rahul Sharma (NSK0104)", Intent.OFFBOARDING_WORKFLOW),
        ("Offboard Rahul Verma (NSK0233)", Intent.OFFBOARDING_WORKFLOW),
    ]
    assert result.actions == []


async def test_a_refused_reply_offers_no_cards_and_the_endpoint_returns_them():
    systems = FakeNskSystems({"find_offboarding_employee": FOUND_RAHUL})
    nsk, _, _ = assistant(
        [
            tool_call_reply("find_offboarding_employee", {"query": "Rahul Sharma"}),
            text_reply("Rahul's last working day is 31 December 2026 [1]."),
        ],
        [classification("OFFBOARDING_WORKFLOW"), suggestions()],
        systems,
    )
    refused = await nsk.answer(
        turn_input("Rahul Sharma is leaving", allowed_intents=HR_INTENTS, allowed_tools=HR_TOOLS)
    )
    assert refused.outcome is TurnOutcome.REFUSED
    assert refused.actions == []


def test_the_endpoint_returns_the_action_cards(client, monkeypatch):
    async def answered(received):
        return NskTurnResult(
            outcome=TurnOutcome.ANSWERED,
            reply="That is Rahul Sharma [1].",
            classification=Classification(
                intent=Intent.OFFBOARDING_WORKFLOW, sentiment=Sentiment.NEUTRAL, confidence=0.9
            ),
            sources=[],
            suggestions=[],
            tools_used=["find_offboarding_employee"],
            usage=None,
            actions=[Action(kind=ActionKind.START_OFFBOARDING, employee_id=RAHUL_ID)],
        )

    monkeypatch.setattr(app.state.agent_runtime, "process_nsk_turn", answered)
    body = client.post("/ai/nsk/turn", json=VALID_TURN, headers=AUTHORISED).json()
    assert body["actions"] == [{"kind": "START_OFFBOARDING", "employee_id": RAHUL_ID}]


async def test_the_offboarding_tool_is_not_offered_without_it():
    nsk, answer_model, _ = assistant([text_reply("Hello!")], [classification("GENERAL_HELP"), suggestions()])
    await nsk.answer(turn_input("hi", allowed_intents=PEOPLE_INTENTS, allowed_tools=PEOPLE_TOOLS))
    assert "find_offboarding_employee" not in answer_model.bound_tool_names


# =================================================================================================
# Web research
# =================================================================================================

WEB_SOURCE_ID = "64b0000000000000000000a9"
FETCHED_AT = "2026-11-14T09:30:00+00:00"
RESEARCH_TOOLS = [*SELF_TOOLS, "external_knowledge_scope", "web_search", "fetch_web_page", "get_stock_quote"]
WEB_INTENTS = ["WEB_MARKET_RESEARCH", *SELF_SERVICE]


def external_passage(score: float = 0.8) -> ExternalPassage:
    return ExternalPassage(
        source_id=WEB_SOURCE_ID,
        source_url="https://www.rbi.org.in/press/rates",
        domain="www.rbi.org.in",
        title="RBI policy rates",
        fetched_at=FETCHED_AT,
        chunk_index=0,
        text="The Reserve Bank of India kept the repo rate unchanged at 5.25 percent.",
        heading_path=[],
        score=score,
    )


async def test_a_read_page_is_cited_as_a_web_source_with_its_address_and_fetch_date():
    systems = FakeNskSystems(
        {
            "fetch_web_page": {
                "result": {
                    "source_id": WEB_SOURCE_ID,
                    "url": "https://www.rbi.org.in/press/rates",
                    "final_url": "https://www.rbi.org.in/press/rates",
                    "title": "RBI policy rates",
                    "domain": "www.rbi.org.in",
                    "fetched_at": FETCHED_AT,
                    "approved": True,
                    "cached": False,
                    "text": "The Reserve Bank of India kept the repo rate unchanged at 5.25 percent.",
                },
                "source": "RBI policy rates (www.rbi.org.in), fetched 2026-11-14",
            }
        }
    )
    nsk, answer_model, _ = assistant(
        [
            tool_call_reply("read_web_page", {"url": "https://www.rbi.org.in/press/rates"}),
            text_reply("The repo rate is 5.25 percent [1], from the RBI page fetched on 14 November."),
        ],
        [classification("WEB_MARKET_RESEARCH"), suggestions()],
        systems,
    )
    result = await nsk.answer(
        turn_input("What is the repo rate?", allowed_intents=WEB_INTENTS, allowed_tools=RESEARCH_TOOLS)
    )
    assert result.outcome is TurnOutcome.ANSWERED
    [source] = result.sources
    assert (source.kind, source.source_id, source.url, source.fetched_at) == (
        "web",
        WEB_SOURCE_ID,
        "https://www.rbi.org.in/press/rates",
        FETCHED_AT,
    )
    assert systems.calls[0] == ("fetch_web_page", {"url": "https://www.rbi.org.in/press/rates"}, ACTOR_TOKEN)
    assert {"search_the_web", "read_web_page", "get_stock_quote", "search_external_knowledge"} <= set(
        answer_model.bound_tool_names
    )
    assert "not a live price" in answer_model.received_inputs[0][0].content


async def test_saved_pages_are_searched_within_the_backend_scope_and_cited():
    for include_unapproved in (False, True):
        systems = FakeNskSystems({"external_knowledge_scope": {"result": {"include_unapproved": include_unapproved}}})
        search = FakeSearch([], [external_passage(), external_passage(score=0.1)])
        nsk, answer_model, _ = assistant(
            [
                tool_call_reply("search_external_knowledge", {"query": "repo rate"}),
                text_reply("The repo rate is 5.25 percent [1]."),
            ],
            [classification("WEB_MARKET_RESEARCH"), suggestions()],
            systems,
            search,
        )
        allowed = [*SELF_TOOLS, "external_knowledge_scope"]
        result = await nsk.answer(turn_input("Repo rate?", allowed_intents=WEB_INTENTS, allowed_tools=allowed))
        assert result.outcome is TurnOutcome.ANSWERED
        assert search.external_searches == [
            {"question": "repo rate", "include_unapproved": include_unapproved, "limit": 5}
        ]
        [source] = result.sources
        assert (source.kind, source.source_id) == ("web", WEB_SOURCE_ID)
        # The passage below the relevance threshold is never shown.
        assert len(json.loads(answer_model.received_inputs[1][-1].content)["passages"]) == 1
        assert "web_search" not in answer_model.bound_tool_names


async def test_an_answer_from_saved_pages_that_cites_nothing_is_refused():
    systems = FakeNskSystems({"external_knowledge_scope": {"result": {"include_unapproved": False}}})
    nsk, _, _ = assistant(
        [tool_call_reply("search_external_knowledge", {"query": "repo rate"}), text_reply("It is 5.25 percent.")],
        [classification("WEB_MARKET_RESEARCH"), suggestions()],
        systems,
        FakeSearch([], [external_passage()]),
    )
    allowed = [*SELF_TOOLS, "external_knowledge_scope"]
    result = await nsk.answer(turn_input("Repo rate?", allowed_intents=WEB_INTENTS, allowed_tools=allowed))
    assert result.outcome is TurnOutcome.REFUSED


async def test_web_tools_are_not_offered_without_them():
    nsk, answer_model, _ = assistant([text_reply("Hello!")], [classification("GENERAL_HELP"), suggestions()])
    await nsk.answer(turn_input("hi"))
    for name in ("search_the_web", "read_web_page", "get_stock_quote", "search_external_knowledge"):
        assert name not in answer_model.bound_tool_names


async def test_nsk_tool_calls_wait_long_enough_for_the_web_tools():
    from app.nodes.nsk_assistant.systems import NSK_TOOL_TIMEOUT_SECONDS, BackendNskSystems

    class RecordingClient:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        async def post_json(self, path: str, payload: dict[str, Any], **options: Any) -> dict[str, Any]:
            self.calls.append({"path": path, "payload": payload, **options})
            return {"result": {}, "source": None}

    client = RecordingClient()
    await BackendNskSystems(client).call_tool("fetch_web_page", {"url": "https://example.com"}, ACTOR_TOKEN)
    assert client.calls[0]["path"] == "/api/internal/nsk/tools/fetch_web_page"
    assert client.calls[0]["timeout_seconds"] == NSK_TOOL_TIMEOUT_SECONDS
    # Longer than the backend's slowest web tool: a quote that falls back to search (8 s + 8 s).
    assert NSK_TOOL_TIMEOUT_SECONDS > 16


async def test_the_backend_client_applies_a_per_call_timeout():
    import httpx

    from app.services.backend_client import REQUEST_TIMEOUT_SECONDS, BackendInternalClient

    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions["timeout"])
        return httpx.Response(200, json={"data": {"ok": True}})

    client = BackendInternalClient("http://backend.test", "k" * 32)
    await client._http_client.aclose()
    client._http_client = httpx.AsyncClient(
        base_url="http://backend.test", transport=httpx.MockTransport(handler), timeout=REQUEST_TIMEOUT_SECONDS
    )
    try:
        await client.post_json("/api/internal/nsk/tools/web_search", {}, timeout_seconds=30.0)
        await client.post_json("/api/internal/leave/balances", {})
    finally:
        await client.aclose()
    assert seen[0]["read"] == 30.0
    assert seen[1]["read"] == REQUEST_TIMEOUT_SECONDS
