"""
The knowledge index against a real Qdrant (TEST_QDRANT_URL, TEST_QDRANT_API_KEY) and the real
embedding model (cached in TEST_EMBEDDING_CACHE_DIR when set): the collection and its indexes,
indexing, overwriting, removing, and that a department's search never sees another department's
chunks. Each run uses a collection of its own, deleted at the end. Skipped without TEST_QDRANT_URL;
CI runs it with a Qdrant service container.
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import uuid

import pytest
from qdrant_client import AsyncQdrantClient

from app.config import Settings
from app.knowledge.constants import EMBEDDING_DIMENSIONS, FILTERED_PAYLOAD_FIELDS
from app.knowledge.schemas import IndexChunksInput
from app.knowledge.service import KnowledgeService, KnowledgeUnavailableError
from app.knowledge.store import KnowledgeStore

QDRANT_URL = os.getenv("TEST_QDRANT_URL", "").strip()
QDRANT_API_KEY = os.getenv("TEST_QDRANT_API_KEY", "").strip()
if os.getenv("CI") == "true" and not QDRANT_URL:
    raise RuntimeError("The knowledge index tests cannot run in CI: TEST_QDRANT_URL is not set")
pytestmark = pytest.mark.skipif(not QDRANT_URL, reason="TEST_QDRANT_URL is not set")

COMPANY = "65f1a2b3c4d5e6f708192a00"
DEPARTMENT_A = "65f1a2b3c4d5e6f708192aa1"
DEPARTMENT_B = "65f1a2b3c4d5e6f708192bb1"
AGENT = "65f1a2b3c4d5e6f708192a02"


def object_id() -> str:
    return uuid.uuid4().hex[:24]


def batch(
    document_id: str, department_id: str, texts: list[str], headings: list[str] | None = None
) -> IndexChunksInput:
    return IndexChunksInput(
        company_id=COMPANY,
        department_id=department_id,
        agent_id=AGENT,
        document_id=document_id,
        chunks=[
            {"chunk_index": index, "text": text, "heading_path": headings or [], "page": None}
            for index, text in enumerate(texts)
        ],
    )


@pytest.fixture
async def knowledge():
    collection = f"test_knowledge_{uuid.uuid4().hex[:12]}"
    settings = dataclasses.replace(
        Settings.from_environment(),
        qdrant_url=QDRANT_URL,
        qdrant_api_key=QDRANT_API_KEY or None,
        embedding_cache_dir=os.getenv("TEST_EMBEDDING_CACHE_DIR") or None,
    )
    service = KnowledgeService(settings, collection_name=collection)
    service.start()
    client = AsyncQdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY or None, check_compatibility=False)
    try:
        yield service, KnowledgeStore(client, collection), client
    finally:
        if await client.collection_exists(collection):
            await client.delete_collection(collection)
        await client.close()
        await service.aclose()


async def test_the_collection_is_created_once_with_cosine_vectors_and_filter_indexes(knowledge):
    _service, store, client = knowledge
    await asyncio.gather(store.ensure_collection(), store.ensure_collection())
    await store.ensure_collection()
    info = await client.get_collection(store.collection_name)
    assert info.config.params.vectors.size == EMBEDDING_DIMENSIONS
    assert info.config.params.vectors.distance.value == "Cosine"
    assert set(FILTERED_PAYLOAD_FIELDS) <= set(info.payload_schema)
    assert info.payload_schema["department_id"].params.is_tenant is True


async def test_chunks_are_indexed_with_their_metadata_and_overwritten_when_indexed_again(knowledge):
    service, store, client = knowledge
    document_id = object_id()
    first = batch(document_id, DEPARTMENT_A, ["Everyone gets 24 days of leave.", "Carry forward 10 days."], ["Leave"])
    assert await service.index_chunks(first) == 2
    assert await service.index_chunks(first) == 2
    stored, _ = await client.scroll(store.collection_name, limit=10, with_payload=True)
    assert len(stored) == 2
    payload = next(point.payload for point in stored if point.payload["chunk_index"] == 0)
    assert payload == {
        "company_id": COMPANY,
        "department_id": DEPARTMENT_A,
        "agent_id": AGENT,
        "document_id": document_id,
        "access_level": "DEPARTMENT",
        "chunk_index": 0,
        "text": "Everyone gets 24 days of leave.",
        "heading_path": ["Leave"],
        "page": None,
    }


async def test_removing_a_document_evicts_only_its_chunks_and_is_safe_to_repeat(knowledge):
    service, store, client = knowledge
    removed_id, kept_id = object_id(), object_id()
    await service.index_chunks(batch(removed_id, DEPARTMENT_A, ["One.", "Two.", "Three."]))
    await service.index_chunks(batch(kept_id, DEPARTMENT_A, ["Kept."]))
    assert await service.remove_document(removed_id) == 3
    assert await service.remove_document(removed_id) == 0
    remaining, _ = await client.scroll(store.collection_name, limit=10, with_payload=True)
    assert [point.payload["document_id"] for point in remaining] == [kept_id]


async def test_a_department_never_finds_another_departments_chunks(knowledge):
    service, store, _client = knowledge
    await service.index_chunks(batch(object_id(), DEPARTMENT_A, ["Engineering on-call rota is weekly."]))
    await service.index_chunks(
        batch(object_id(), DEPARTMENT_B, ["Finance salary bands are confidential.", "Engineering on-call rota."])
    )
    query = (await service._embedder.embed_passages(["engineering on-call rota"]))[0]
    hits = await store.search(query, department_id=DEPARTMENT_A, limit=10)
    assert hits
    assert {hit.payload["department_id"] for hit in hits} == {DEPARTMENT_A}
    with pytest.raises(ValueError, match="department"):
        await store.search(query, department_id="", limit=10)


async def test_a_search_across_departments_stays_within_them_and_names_each_passages_department(knowledge):
    service, store, _client = knowledge
    department_c = object_id()
    await service.index_chunks(batch(object_id(), DEPARTMENT_A, ["The notice period is 60 days."]))
    await service.index_chunks(batch(object_id(), DEPARTMENT_B, ["Notice period for interns is 15 days."]))
    await service.index_chunks(batch(object_id(), department_c, ["Notice period for executives is 90 days."]))

    passages = await service.search_department_passages(
        department_ids=[DEPARTMENT_A, DEPARTMENT_B], question="What is the notice period?", limit=10
    )
    assert {passage.department_id for passage in passages} == {DEPARTMENT_A, DEPARTMENT_B}
    assert all("executives" not in passage.text for passage in passages)
    assert await service.search_department_passages(department_ids=[], question="notice", limit=10) == []
    query = (await service._embedder.embed_passages(["notice"]))[0]
    with pytest.raises(ValueError, match="department"):
        await store.search_departments(query, department_ids=[], limit=10)


async def test_the_closest_chunk_answers_the_question(knowledge):
    service, store, _client = knowledge
    await service.index_chunks(
        batch(
            object_id(),
            DEPARTMENT_A,
            [
                "Employees receive 24 days of paid annual leave each year.",
                "Laptops are refreshed every three years.",
                "Expense claims must be filed within 30 days.",
            ],
        )
    )
    query = (await service._embedder.embed_passages(["How many vacation days do I get?"]))[0]
    hits = await store.search(query, department_id=DEPARTMENT_A, limit=3)
    assert hits[0].payload["text"].startswith("Employees receive 24 days")


async def test_an_unreachable_qdrant_is_reported_as_unavailable():
    settings = dataclasses.replace(
        Settings.from_environment(), qdrant_url="http://127.0.0.1:9", qdrant_api_key="k" * 40
    )
    service = KnowledgeService(settings, collection_name="never_created")
    service.start()
    try:
        with pytest.raises(KnowledgeUnavailableError):
            await service.remove_document(object_id())
    finally:
        await service.aclose()
