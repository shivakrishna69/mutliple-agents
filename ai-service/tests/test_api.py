"""The HTTP layer: internal API key, validation errors, and mapping agent failures to status codes."""

import pytest
from fastapi.testclient import TestClient

from app.agent import AgentTimeoutError, TurnResult
from app.main import app
from tests.conftest import TEST_INTERNAL_API_KEY

AUTHORISED = {"X-Internal-Api-Key": TEST_INTERNAL_API_KEY}
VALID_TURN = {
    "conversation_id": "conversation-1",
    "customer_id": "customer-1",
    "messages": [{"message_id": "message-1", "role": "user", "content": "Hello"}],
}


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health_reports_degraded_without_a_groq_key(client):
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json()["llm"] == "not_configured"


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Api-Key": "wrong-key-of-the-same-length-0123456789"}])
def test_agent_endpoints_require_the_internal_api_key(client, headers):
    response = client.post("/ai/process", json=VALID_TURN, headers=headers)
    assert response.status_code == 401
    assert "requestId" in response.json()["error"]


def test_invalid_bodies_get_a_structured_422(client):
    response = client.post("/ai/process", json={"conversation_id": "c", "messages": []}, headers=AUTHORISED)
    assert response.status_code == 422
    assert isinstance(response.json()["error"]["details"], list)


def test_without_a_groq_key_the_backend_is_told_to_hand_off(client):
    response = client.post("/ai/process", json=VALID_TURN, headers=AUTHORISED)
    assert response.status_code == 503


def test_a_successful_turn_returns_the_reply_and_routing(client, monkeypatch):
    async def fake_process_conversation(**_kwargs):
        return TurnResult(response_content="Hi! How can I help?", next_worker="supervisor", internal_logs=["test"])

    monkeypatch.setattr(app.state.agent_runtime, "process_conversation", fake_process_conversation)
    response = client.post("/ai/process", json=VALID_TURN, headers=AUTHORISED)

    assert response.status_code == 200
    assert response.json()["response_content"] == "Hi! How can I help?"
    assert response.json()["next_worker"] == "supervisor"


def test_a_timed_out_turn_returns_504(client, monkeypatch):
    async def timing_out(**_kwargs):
        raise AgentTimeoutError("turn_timeout", "too slow")

    monkeypatch.setattr(app.state.agent_runtime, "process_conversation", timing_out)
    assert client.post("/ai/process", json=VALID_TURN, headers=AUTHORISED).status_code == 504
