"""
The external knowledge collection in Qdrant: web pages NSK read, one point per chunk.

    ensure_collection()             creates the collection (the same 384-dimension cosine vectors as the
                                    department knowledge) and its payload indexes, once
    upsert_chunks(input, vectors)   id = UUIDv5(source id, chunk number), so indexing again overwrites
    remove_sources(ids)             every chunk of these sources; returns how many there were
    set_approval(ids, approved)     marks these sources' chunks approved for everyone, or not
    remove_expired(before_ts)       every chunk that expired before a time (seconds since the epoch)
    search(vector, now_ts, include_unapproved, limit)
                                    the closest chunks that have not expired; approved ones only unless
                                    `include_unapproved` (the person has live research)

Every write waits for Qdrant to apply it (wait=True).
"""

from __future__ import annotations

import asyncio
import uuid

from qdrant_client import AsyncQdrantClient, models
from qdrant_client.http.exceptions import UnexpectedResponse

from app.knowledge.constants import (
    COLLECTION_READY_ATTEMPTS,
    COLLECTION_READY_DELAY_SECONDS,
    EMBEDDING_DIMENSIONS,
    EXTERNAL_BOOL_FIELDS,
    EXTERNAL_COLLECTION_NAME,
    EXTERNAL_FLOAT_FIELDS,
    EXTERNAL_KEYWORD_FIELDS,
    EXTERNAL_POINT_ID_NAMESPACE,
)
from app.knowledge.external_schemas import IndexExternalChunksInput

INDEX_SCHEMAS = {
    **{field: models.PayloadSchemaType.KEYWORD for field in EXTERNAL_KEYWORD_FIELDS},
    **{field: models.PayloadSchemaType.BOOL for field in EXTERNAL_BOOL_FIELDS},
    **{field: models.PayloadSchemaType.FLOAT for field in EXTERNAL_FLOAT_FIELDS},
}


def external_point_id(source_id: str, chunk_index: int) -> str:
    return str(uuid.uuid5(EXTERNAL_POINT_ID_NAMESPACE, f"{source_id}:{chunk_index}"))


def _sources(source_ids: list[str]) -> models.Filter:
    return models.Filter(must=[models.FieldCondition(key="source_id", match=models.MatchAny(any=list(source_ids)))])


class ExternalKnowledgeStore:
    def __init__(self, client: AsyncQdrantClient, collection_name: str = EXTERNAL_COLLECTION_NAME) -> None:
        self._client = client
        self._collection_name = collection_name

    @property
    def collection_name(self) -> str:
        return self._collection_name

    async def ensure_collection(self) -> None:
        if not await self._client.collection_exists(self._collection_name):
            try:
                await self._client.create_collection(
                    self._collection_name,
                    vectors_config=models.VectorParams(size=EMBEDDING_DIMENSIONS, distance=models.Distance.COSINE),
                )
            except UnexpectedResponse:
                if not await self._client.collection_exists(self._collection_name):
                    raise
        existing = (await self._ready_collection()).payload_schema
        for field, schema in INDEX_SCHEMAS.items():
            if field not in existing:
                await self._client.create_payload_index(
                    self._collection_name, field_name=field, field_schema=schema, wait=True
                )

    async def _ready_collection(self) -> models.CollectionInfo:
        for attempt in range(1, COLLECTION_READY_ATTEMPTS + 1):
            try:
                return await self._client.get_collection(self._collection_name)
            except UnexpectedResponse:
                if attempt == COLLECTION_READY_ATTEMPTS:
                    raise
                await asyncio.sleep(COLLECTION_READY_DELAY_SECONDS)
        raise AssertionError("unreachable")

    async def upsert_chunks(self, chunk_input: IndexExternalChunksInput, vectors: list[list[float]]) -> int:
        if len(vectors) != len(chunk_input.chunks):
            raise ValueError("one vector is needed per chunk")
        metadata = {
            "source_id": chunk_input.source_id,
            "source_url": chunk_input.source_url,
            "domain": chunk_input.domain,
            "title": chunk_input.title,
            "fetched_at": chunk_input.fetched_at.isoformat(),
            "expires_at_ts": chunk_input.expires_at.timestamp(),
            "approved": chunk_input.approved,
        }
        points = [
            models.PointStruct(
                id=external_point_id(chunk_input.source_id, chunk.chunk_index),
                vector=vector,
                payload={
                    **metadata,
                    "chunk_index": chunk.chunk_index,
                    "text": chunk.text,
                    "heading_path": chunk.heading_path,
                },
            )
            for chunk, vector in zip(chunk_input.chunks, vectors, strict=True)
        ]
        await self._client.upsert(self._collection_name, points=points, wait=True)
        return len(points)

    async def _remove(self, point_filter: models.Filter) -> int:
        existing = await self._client.count(self._collection_name, count_filter=point_filter, exact=True)
        await self._client.delete(
            self._collection_name, points_selector=models.FilterSelector(filter=point_filter), wait=True
        )
        return existing.count

    async def remove_sources(self, source_ids: list[str]) -> int:
        return await self._remove(_sources(source_ids))

    async def remove_expired(self, before_ts: float) -> int:
        return await self._remove(
            models.Filter(must=[models.FieldCondition(key="expires_at_ts", range=models.Range(lt=before_ts))])
        )

    async def set_approval(self, source_ids: list[str], approved: bool) -> int:
        point_filter = _sources(source_ids)
        existing = await self._client.count(self._collection_name, count_filter=point_filter, exact=True)
        await self._client.set_payload(
            self._collection_name, payload={"approved": approved}, points=point_filter, wait=True
        )
        return existing.count

    async def search(
        self, vector: list[float], *, now_ts: float, include_unapproved: bool, limit: int
    ) -> list[models.ScoredPoint]:
        conditions = [models.FieldCondition(key="expires_at_ts", range=models.Range(gt=now_ts))]
        if not include_unapproved:
            conditions.append(models.FieldCondition(key="approved", match=models.MatchValue(value=True)))
        result = await self._client.query_points(
            self._collection_name,
            query=vector,
            query_filter=models.Filter(must=conditions),
            limit=limit,
            with_payload=True,
        )
        return result.points
