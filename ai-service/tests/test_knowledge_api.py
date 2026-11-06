"""
The knowledge index endpoints (app/knowledge/router.py) at the HTTP layer: the internal key, what a
request may contain, and the 503 the backend retries on. The index itself is replaced by a fake;
tests/test_knowledge_index.py runs the real one against Qdrant.
"""

import pytest
from fastapi.testclient import TestClient

from app.knowledge.constants import MAX_CHUNK_TEXT_CHARS, MAX_CHUNKS_PER_REQUEST, MAX_HEADING_LEVELS
from app.knowledge.schemas import IndexChunksInput
from app.knowledge.service import KnowledgeUnavailableError
from app.main import app
from tests.conftest import TEST_INTERNAL_API_KEY

AUTHORISED = {"X-Internal-Api-Key": TEST_INTERNAL_API_KEY}
DOCUMENT_ID = "65f1a2b3c4d5e6f708192a3b"
VALID_BATCH = {
    "company_id": "65f1a2b3c4d5e6f708192a00",
    "department_id": "65f1a2b3c4d5e6f708192a01",
    "agent_id": "65f1a2b3c4d5e6f708192a02",
    "document_id": DOCUMENT_ID,
    "access_level": "DEPARTMENT",
    "chunks": [
        {"chunk_index": 0, "text": "Welcome to the team.", "heading_path": ["Handbook"], "page": None},
        {"chunk_index": 1, "text": "Everyone gets 24 days.", "heading_path": ["Handbook", "Leave"], "page": 2},
    ],
}


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def with_chunks(chunks):
    return {**VALID_BATCH, "chunks": chunks}


@pytest.mark.parametrize("path", ["/ai/knowledge/chunks", "/ai/knowledge/documents/remove"])
@pytest.mark.parametrize("headers", [{}, {"X-Internal-Api-Key": "wrong-key-of-the-same-length-0123456789"}])
def test_knowledge_endpoints_require_the_internal_api_key(client, path, headers):
    response = client.post(path, json=VALID_BATCH, headers=headers)
    assert response.status_code == 401


def test_without_qdrant_the_endpoints_answer_503_and_health_says_so(client):
    assert client.post("/ai/knowledge/chunks", json=VALID_BATCH, headers=AUTHORISED).status_code == 503
    response = client.post("/ai/knowledge/documents/remove", json={"document_id": DOCUMENT_ID}, headers=AUTHORISED)
    assert response.status_code == 503
    assert response.json()["error"]["message"] == "Knowledge index unavailable"
    assert client.get("/health").json()["knowledgeIndex"] == "not_configured"


@pytest.mark.parametrize(
    "body",
    [
        {**VALID_BATCH, "department_id": "engineering"},
        {**VALID_BATCH, "document_id": {"$ne": None}},
        {**VALID_BATCH, "company_id": "65F1A2B3C4D5E6F708192A00"},
        {**VALID_BATCH, "access_level": "COMPANY"},
        {**VALID_BATCH, "unexpected": True},
        with_chunks([]),
        with_chunks([{"chunk_index": i, "text": "x"} for i in range(MAX_CHUNKS_PER_REQUEST + 1)]),
        with_chunks([{"chunk_index": 0, "text": ""}]),
        with_chunks([{"chunk_index": 0, "text": "   "}]),
        with_chunks([{"chunk_index": 0, "text": "x" * (MAX_CHUNK_TEXT_CHARS + 1)}]),
        with_chunks([{"chunk_index": -1, "text": "x"}]),
        with_chunks([{"chunk_index": 0, "text": "x", "page": 0}]),
        with_chunks([{"chunk_index": 0, "text": "x", "heading_path": ["h"] * (MAX_HEADING_LEVELS + 1)}]),
        with_chunks([{"chunk_index": 0, "text": "x", "secret": "y"}]),
        with_chunks([{"chunk_index": 3, "text": "a"}, {"chunk_index": 3, "text": "b"}]),
    ],
)
def test_malformed_batches_are_refused_before_anything_is_embedded(client, monkeypatch, body):
    calls = []

    async def record(chunk_input):
        calls.append(chunk_input)
        return 0

    monkeypatch.setattr(app.state.knowledge_service, "index_chunks", record)
    response = client.post("/ai/knowledge/chunks", json=body, headers=AUTHORISED)
    assert response.status_code == 422
    assert calls == []


def test_a_valid_batch_is_indexed_and_counted(client, monkeypatch):
    received: list[IndexChunksInput] = []

    async def fake_index(chunk_input):
        received.append(chunk_input)
        return len(chunk_input.chunks)

    monkeypatch.setattr(app.state.knowledge_service, "index_chunks", fake_index)
    response = client.post("/ai/knowledge/chunks", json=VALID_BATCH, headers=AUTHORISED)
    assert response.status_code == 200
    assert response.json() == {"indexed": 2}
    assert received[0].document_id == DOCUMENT_ID
    assert received[0].chunks[1].heading_path == ["Handbook", "Leave"]
    assert received[0].chunks[1].page == 2


def test_a_document_is_removed_and_counted(client, monkeypatch):
    async def fake_remove(document_id):
        assert document_id == DOCUMENT_ID
        return 7

    monkeypatch.setattr(app.state.knowledge_service, "remove_document", fake_remove)
    response = client.post("/ai/knowledge/documents/remove", json={"document_id": DOCUMENT_ID}, headers=AUTHORISED)
    assert response.status_code == 200
    assert response.json() == {"removed": 7}


def test_an_unreachable_index_is_a_503_without_its_reason(client, monkeypatch):
    async def unreachable(_chunk_input):
        raise KnowledgeUnavailableError("ConnectError to http://qdrant:6333")

    monkeypatch.setattr(app.state.knowledge_service, "index_chunks", unreachable)
    response = client.post("/ai/knowledge/chunks", json=VALID_BATCH, headers=AUTHORISED)
    assert response.status_code == 503
    assert "qdrant" not in response.text.lower()
