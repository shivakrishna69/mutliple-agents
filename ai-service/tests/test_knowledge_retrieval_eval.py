"""
A fixed set of questions against a small handbook, with the real embedding model and a real Qdrant
(TEST_QDRANT_URL, like tests/test_knowledge_index.py; skipped without it, required in CI). It keeps
the default KNOWLEDGE_MIN_RELEVANCE honest: changing the model, the passage text that is embedded,
or the threshold must still find the passage that answers each question, and must still keep
questions the handbook does not cover away from the model.

Questions close to a topic that the handbook does not answer (adoption leave, say) may pass the
threshold; there the model replies NOT_FOUND (tests/test_knowledge_agent.py covers that path).
"""

from __future__ import annotations

import dataclasses
import os
import uuid

import pytest
from qdrant_client import AsyncQdrantClient

from app.config import Settings
from app.knowledge.schemas import IndexChunksInput
from app.knowledge.service import KnowledgeService

QDRANT_URL = os.getenv("TEST_QDRANT_URL", "").strip()
QDRANT_API_KEY = os.getenv("TEST_QDRANT_API_KEY", "").strip()
if os.getenv("CI") == "true" and not QDRANT_URL:
    raise RuntimeError("The retrieval evaluation cannot run in CI: TEST_QDRANT_URL is not set")
pytestmark = pytest.mark.skipif(not QDRANT_URL, reason="TEST_QDRANT_URL is not set")

COMPANY = "65f1a2b3c4d5e6f708192a00"
DEPARTMENT = "65f1a2b3c4d5e6f708192ee1"
OTHER_DEPARTMENT = "65f1a2b3c4d5e6f708192ee2"
AGENT = "65f1a2b3c4d5e6f708192a02"
# The default threshold, read the way the service reads it.
MIN_RELEVANCE = Settings.from_environment().knowledge_min_relevance
TOP_K = 3

HANDBOOK = [
    (
        ["Handbook", "Leave"],
        "Every full-time employee gets 24 days of earned leave a year, credited monthly. "
        "Unused earned leave up to 30 days carries over to the next year.",
    ),
    (
        ["Handbook", "Leave", "Sick leave"],
        "You may take up to 12 days of sick leave a year. A doctor's certificate "
        "is needed for more than 2 consecutive days.",
    ),
    (
        ["IT", "Laptops"],
        "New joiners receive a laptop on their first day. Report a lost or stolen laptop to the "
        "IT helpdesk within 24 hours.",
    ),
    (
        ["IT", "VPN"],
        "Install the company VPN client from the self-service portal. Use your company email and "
        "password to sign in; multi-factor authentication is required.",
    ),
    (
        ["Finance", "Expenses"],
        "Submit travel expense claims within 30 days with receipts. Claims above 10,000 "
        "rupees need your manager's approval.",
    ),
    (
        ["Handbook", "Working hours"],
        "Core hours are 10:00 to 16:00. Hybrid employees work from the office at least three days a week.",
    ),
    # A Data Engineering guide, written in the team's own voice (the questions that were refused).
    (
        ["Document Overview & Agent Guidelines"],
        "This document explains how the Data Engineering team works and how the department agent answers "
        "questions about it. The agent answers from this document only. Questions it does not cover go to "
        "the Data Engineering team, who reply within two working days.",
    ),
    (
        ["Data Engineering", "Pipeline Requests"],
        "To request a new data pipeline, raise a ticket in the DE board with the source system, the refresh "
        "frequency and the owner. We review new pipeline requests every Tuesday. Approved requests are "
        "scheduled into the next sprint, and we create the pipeline in Airflow with alerting on failure.",
    ),
    (
        ["Data Engineering", "Data Access"],
        "Access to production warehouses is granted by role. Analysts get read access to the curated layer. "
        "Raw layer access needs approval from the data owner. We update access lists every Monday.",
    ),
    (
        ["Data Engineering", "On-call"],
        "One engineer is on call each week. The on-call engineer will investigate failed jobs and will "
        "contact the pipeline owner if a fix needs their input.",
    ),
]

# (question, index of the passage that answers it)
ANSWERED_BY_THE_HANDBOOK = [
    ("How many days of earned leave do I get?", 0),
    ("Can I carry forward my unused leave?", 0),
    ("Do I need a medical certificate for sick leave?", 1),
    ("I lost my laptop, what should I do?", 2),
    ("How do I connect to the VPN from home?", 3),
    ("What is the deadline for submitting travel expenses?", 4),
    ("How many days a week must I come to the office?", 5),
    ("leave balance", 0),
    # The exact heading, and questions worded differently from the text.
    ("Document Overview & Agent Guidelines", 6),
    ("What are the agent guidelines?", 6),
    ("How do I request a new data pipeline?", 7),
    ("who decides on new pipelines and when?", 7),
    ("How can I get access to raw data?", 8),
    ("what happens when a job fails at night", 9),
]

NOT_IN_THE_HANDBOOK = [
    "What is the capital of France?",
    "Who won the cricket world cup?",
    "What is the company's stock price today?",
    "How do I bake a chocolate cake?",
]


@pytest.fixture
async def handbook():
    collection = f"test_retrieval_{uuid.uuid4().hex[:12]}"
    settings = dataclasses.replace(
        Settings.from_environment(),
        qdrant_url=QDRANT_URL,
        qdrant_api_key=QDRANT_API_KEY or None,
        embedding_cache_dir=os.getenv("TEST_EMBEDDING_CACHE_DIR") or None,
    )
    service = KnowledgeService(settings, collection_name=collection)
    service.start()
    document_ids = []
    try:
        for index, (heading_path, text) in enumerate(HANDBOOK):
            document_id = f"{index:024x}"
            document_ids.append(document_id)
            await service.index_chunks(
                IndexChunksInput(
                    company_id=COMPANY,
                    department_id=DEPARTMENT,
                    agent_id=AGENT,
                    document_id=document_id,
                    chunks=[{"chunk_index": 0, "text": text, "heading_path": heading_path, "page": None}],
                )
            )
        yield service, document_ids
    finally:
        client = AsyncQdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY or None, check_compatibility=False)
        if await client.collection_exists(collection):
            await client.delete_collection(collection)
        await client.close()
        await service.aclose()


@pytest.mark.parametrize(("question", "expected"), ANSWERED_BY_THE_HANDBOOK)
async def test_the_answering_passage_is_found_and_relevant_enough(handbook, question, expected):
    service, document_ids = handbook
    passages = await service.search_passages(department_id=DEPARTMENT, question=question, limit=TOP_K)
    relevant = [passage for passage in passages if passage.score >= MIN_RELEVANCE]
    assert document_ids[expected] in [passage.document_id for passage in relevant], [
        (passage.document_id, round(passage.score, 3)) for passage in passages
    ]
    assert passages == sorted(passages, key=lambda passage: passage.score, reverse=True)


@pytest.mark.parametrize("question", NOT_IN_THE_HANDBOOK)
async def test_questions_the_handbook_does_not_cover_stay_below_the_threshold(handbook, question):
    service, _ = handbook
    passages = await service.search_passages(department_id=DEPARTMENT, question=question, limit=TOP_K)
    assert all(passage.score < MIN_RELEVANCE for passage in passages), [round(p.score, 3) for p in passages]


async def test_another_department_finds_nothing_in_this_handbook(handbook):
    service, _ = handbook
    assert await service.search_passages(department_id=OTHER_DEPARTMENT, question="earned leave", limit=TOP_K) == []


async def test_a_found_passage_carries_its_text_and_headings(handbook):
    service, document_ids = handbook
    best = (await service.search_passages(department_id=DEPARTMENT, question="VPN sign in", limit=1))[0]
    assert best.document_id == document_ids[3]
    assert best.heading_path == ["IT", "VPN"]
    assert best.text.startswith("Install the company VPN client")
    assert best.chunk_index == 0
    assert best.page is None
