"""
Request and response bodies of POST /ai/knowledge/answer (app/main.py). Unknown fields are refused,
so a typo in the backend's request fails loudly instead of being ignored. The limits mirror the
backend's (KNOWLEDGE_BASE_SETTINGS, backend/constants/validation.js) with a little headroom.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.knowledge.constants import OBJECT_ID_PATTERN

MAX_NAME_CHARS = 200
MAX_INSTRUCTIONS_CHARS = 5_000
MAX_QUESTION_CHARS = 2_000
MAX_HISTORY_MESSAGE_CHARS = 8_000
MAX_HISTORY_MESSAGES = 40

ObjectId = Annotated[str, StringConstraints(pattern=OBJECT_ID_PATTERN)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class HistoryMessage(StrictModel):
    """An earlier message of the conversation: the employee's question or the agent's answer."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_HISTORY_MESSAGE_CHARS)


class KnowledgeAnswerInput(StrictModel):
    """
    One employee question to a department's agent. The backend has already decided that this person
    may ask this agent; this service only answers from that department's passages.
    """

    department_id: ObjectId
    department_name: str = Field(min_length=1, max_length=MAX_NAME_CHARS)
    agent_name: str = Field(min_length=1, max_length=MAX_NAME_CHARS)
    # The department's guidance for its agent (DepartmentAgent.systemPrompt), set by its lead.
    agent_instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS_CHARS)
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    # Oldest first. Only the most recent KNOWLEDGE_ANSWER_HISTORY_MESSAGES are used.
    history: list[HistoryMessage] = Field(default_factory=list, max_length=MAX_HISTORY_MESSAGES)
    # true: the answer is sent as it is written, as newline-delimited JSON events (see app/main.py).
    stream: bool = False


class AnswerOutcome(str, Enum):
    # Answered from the department's passages, with at least one citation.
    ANSWERED = "answered"
    # No passage was relevant enough, or the model found the answer was not in them.
    NOT_FOUND = "not_found"
    # The model's answer could not be verified against the passages (no valid citation) or failed
    # the output guard, so a fixed reply was sent instead.
    REFUSED = "refused"


class Citation(BaseModel):
    """A passage the answer cites as [number]; the number is the passage's position in the prompt."""

    number: int
    document_id: str
    chunk_index: int
    heading_path: list[str]
    page: int | None
    # The start of the passage, at most KNOWLEDGE_EXCERPT_CHARS long: what the employee may read.
    excerpt: str
    score: float


class TokenUsage(BaseModel):
    input_tokens: int
    output_tokens: int


class KnowledgeAnswerResponse(BaseModel):
    outcome: AnswerOutcome
    answer: str
    # Only the passages the answer cites, in the order of their numbers.
    citations: list[Citation]
    # How many passages were relevant enough to reach the model (0 when it was not called).
    passages_considered: int
    # The model's token use, when it was called and reported it (for the backend's quotas).
    usage: TokenUsage | None = None
