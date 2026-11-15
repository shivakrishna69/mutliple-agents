"""
The external knowledge index (web pages NSK read) against a real Qdrant and the real embedding model:
its collection and indexes, indexing with the page's metadata, searches that skip expired pages and,
unless asked, unapproved ones, approval changes, removing sources and expired chunks, and the
endpoints' request checks. Each run uses a collection of its own. Skipped without TEST_QDRANT_URL; CI
runs it with a Qdrant service container.
"""

from __future__ import annotations

import dataclasses
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError
from qdrant_client import AsyncQdrantClient

from app.config import Settings
from app.knowledge.external_schemas import IndexExternalChunksInput
from app.knowledge.service import KnowledgeService

QDRANT_URL = os.getenv("TEST_QDRANT_URL", "").strip()
QDRANT_API_KEY = os.getenv("TEST_QDRANT_API_KEY", "").strip()
if os.getenv("CI") == "true" and not QDRANT_URL:
    raise RuntimeError("The external knowledge tests cannot run in CI: TEST_QDRANT_URL is not set")
pytestmark = pytest.mark.skipif(not QDRANT_URL, reason="TEST_QDRANT_URL is not set")

NOW = datetime(2026, 11, 14, 10, 0, tzinfo=UTC)


def object_id() -> str:
    return uuid.uuid4().hex[:24]


def page(source_id: str, texts: list[str], *, approved: bool, expires_in_days: float = 7, title: str = "RBI rates"):
    return IndexExternalChunksInput(
        source_id=source_id,
        source_url=f"https://www.rbi.org.in/{source_id}",
        domain="www.rbi.org.in",
        title=title,
        fetched_at=NOW,
        expires_at=NOW + timedelta(days=expires_in_days),
        approved=approved,
        chunks=[{"chunk_index": index, "text": text, "heading_path": []} for index, text in enumerate(texts)],
    )


@pytest.fixture
async def external():
    department_collection = f"test_knowledge_{uuid.uuid4().hex[:12]}"
    external_collection = f"test_external_{uuid.uuid4().hex[:12]}"
    settings = dataclasses.replace(
        Settings.from_environment(),
        qdrant_url=QDRANT_URL,
        qdrant_api_key=QDRANT_API_KEY or None,
        embedding_cache_dir=os.getenv("TEST_EMBEDDING_CACHE_DIR") or None,
    )
    service = KnowledgeService(
        settings, collection_name=department_collection, external_collection_name=external_collection
    )
    service.start()
    client = AsyncQdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY or None, check_compatibility=False)
    try:
        yield service, client, external_collection
    finally:
        for collection in (department_collection, external_collection):
            if await client.collection_exists(collection):
                await client.delete_collection(collection)
        await client.close()
        await service.aclose()


async def test_pages_are_indexed_with_their_metadata_and_filter_indexes(external):
    service, client, collection = external
    source = object_id()
    assert await service.index_external_chunks(page(source, ["The repo rate is unchanged."], approved=True)) == 1
    info = await client.get_collection(collection)
    assert {"source_id", "domain", "approved", "expires_at_ts"} <= set(info.payload_schema)
    points, _ = await client.scroll(collection, with_payload=True)
    payload = points[0].payload
    assert payload["source_id"] == source
    assert payload["source_url"] == f"https://www.rbi.org.in/{source}"
    assert payload["approved"] is True
    assert payload["fetched_at"] == NOW.isoformat()
    assert payload["expires_at_ts"] == (NOW + timedelta(days=7)).timestamp()
    # Indexing again overwrites.
    await service.index_external_chunks(page(source, ["The repo rate is unchanged."], approved=True))
    assert (await client.count(collection, exact=True)).count == 1


async def test_searches_skip_expired_pages_and_unapproved_ones_unless_asked(external):
    service, _client, _collection = external
    approved, unapproved, expired = object_id(), object_id(), object_id()
    await service.index_external_chunks(page(approved, ["RBI kept the repo rate unchanged."], approved=True))
    await service.index_external_chunks(page(unapproved, ["The repo rate decision surprised nobody."], approved=False))
    await service.index_external_chunks(
        page(expired, ["Old news about the repo rate."], approved=True, expires_in_days=1)
    )
    later = NOW + timedelta(days=2)
    for_everyone = await service.search_external_passages(
        question="repo rate", include_unapproved=False, limit=5, now=later
    )
    assert {passage.source_id for passage in for_everyone} == {approved}
    for_research = await service.search_external_passages(
        question="repo rate", include_unapproved=True, limit=5, now=later
    )
    assert {passage.source_id for passage in for_research} == {approved, unapproved}
    passage = for_everyone[0]
    assert passage.title == "RBI rates"
    assert passage.fetched_at == NOW.isoformat()
    assert passage.source_url.startswith("https://www.rbi.org.in/")


async def test_approval_changes_and_removals(external):
    service, client, collection = external
    first, second = object_id(), object_id()
    await service.index_external_chunks(page(first, ["One.", "Two."], approved=False))
    await service.index_external_chunks(page(second, ["Three."], approved=False, expires_in_days=1))
    assert await service.set_external_approval([first], True) == 2
    found = await service.search_external_passages(question="One", include_unapproved=False, limit=5, now=NOW)
    assert {passage.source_id for passage in found} == {first}
    # Taken off the allowlist again: no longer found for everyone.
    assert await service.set_external_approval([first], False) == 2
    assert await service.search_external_passages(question="One", include_unapproved=False, limit=5, now=NOW) == []
    assert await service.remove_expired_external(NOW + timedelta(days=2)) == 1
    assert await service.remove_external_sources([first]) == 2
    assert await service.remove_external_sources([first]) == 0
    assert (await client.count(collection, exact=True)).count == 0


def test_requests_are_checked():
    with pytest.raises(ValidationError):
        page(object_id(), ["x"], approved=True, expires_in_days=-1)
    with pytest.raises(ValidationError):
        IndexExternalChunksInput.model_validate(
            {**page(object_id(), ["x"], approved=True).model_dump(), "source_url": "ftp://x.example/a"}
        )
    with pytest.raises(ValidationError):
        IndexExternalChunksInput.model_validate({**page(object_id(), ["x"], approved=True).model_dump(), "extra": 1})
