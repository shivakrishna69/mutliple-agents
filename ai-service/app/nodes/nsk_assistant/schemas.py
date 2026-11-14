"""
Contract of POST /ai/nsk/turn (called by the backend's services/nskBot/nskTurnClient.js).

  request   NskTurnInput: the turn's actor token (the tools send it back; this service never names a
            person), who is asking (name and role label only), their today and time zone, the
            session's recent messages (oldest first), the memory of earlier sessions, the new
            message, and the intents and tools this person may use.
  response  NskTurnResponse: the outcome, the reply, the message's classification, the sources the
            reply cites, three suggested next questions, the tools used and the token usage.

As elsewhere, unknown fields are rejected, every string is bounded, and there is no "system" role.
Enum values and limits mirror backend/constants/nskBot.js and NSK_BOT_SETTINGS.
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

MESSAGE_MAX_LENGTH = 2_000
HISTORY_MAX_MESSAGES = 20
HISTORY_MESSAGE_MAX_LENGTH = 8_000
MEMORY_MAX_SESSIONS = 10
TOPIC_MAX_LENGTH = 80
TOPICS_MAX = 8
ENTITY_VALUE_MAX_LENGTH = 80
ENTITIES_MAX = 12
SUGGESTIONS_MAX = 3
SUGGESTION_MAX_LENGTH = 160
REPLY_MAX_LENGTH = 8_000
SOURCES_MAX = 12
TOOLS_USED_MAX = 20
ACTOR_TOKEN_MAX_LENGTH = 700

ObjectIdString = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{24}$")]
ToolName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class Intent(str, Enum):
    PROFILE_LOOKUP = "PROFILE_LOOKUP"
    OFFBOARDING_WORKFLOW = "OFFBOARDING_WORKFLOW"
    ATTENDANCE_AUDIT = "ATTENDANCE_AUDIT"
    POLICY_QA = "POLICY_QA"
    WEB_MARKET_RESEARCH = "WEB_MARKET_RESEARCH"
    GENERAL_HELP = "GENERAL_HELP"


class Sentiment(str, Enum):
    POSITIVE = "POSITIVE"
    NEUTRAL = "NEUTRAL"
    URGENT = "URGENT"
    FRUSTRATED = "FRUSTRATED"
    SENSITIVE_HR = "SENSITIVE_HR"


class EntityKind(str, Enum):
    EMPLOYEE_NAME = "employeeName"
    DATE = "date"
    STOCK_TICKER = "stockTicker"
    DEPARTMENT = "department"


class TurnOutcome(str, Enum):
    ANSWERED = "answered"
    CLARIFY = "clarify"
    NOT_FOUND = "not_found"
    NOT_ALLOWED = "not_allowed"
    REFUSED = "refused"


class HistoryRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: HistoryRole
    content: str = Field(min_length=1, max_length=HISTORY_MESSAGE_MAX_LENGTH)


class Entity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: EntityKind
    value: str = Field(min_length=1, max_length=ENTITY_VALUE_MAX_LENGTH)


class MemorySession(BaseModel):
    """One earlier session: what it was about, for "what did we check yesterday?"."""

    model_config = ConfigDict(extra="forbid")

    session_id: ObjectIdString
    title: str = Field(min_length=1, max_length=120)
    date: date
    topics: list[Annotated[str, StringConstraints(min_length=1, max_length=TOPIC_MAX_LENGTH)]] = Field(
        default_factory=list, max_length=TOPICS_MAX
    )
    entities: list[Entity] = Field(default_factory=list, max_length=ENTITIES_MAX)


class Asker(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    role_label: str = Field(min_length=1, max_length=60)


class NskTurnInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actor_token: str = Field(min_length=1, max_length=ACTOR_TOKEN_MAX_LENGTH)
    user: Asker
    today: date
    time_zone: str = Field(min_length=1, max_length=64)
    message: str = Field(min_length=1, max_length=MESSAGE_MAX_LENGTH)
    history: list[HistoryMessage] = Field(default_factory=list, max_length=HISTORY_MAX_MESSAGES)
    memory: list[MemorySession] = Field(default_factory=list, max_length=MEMORY_MAX_SESSIONS)
    allowed_intents: list[Intent] = Field(min_length=1, max_length=len(Intent))
    allowed_tools: list[ToolName] = Field(default_factory=list, max_length=TOOLS_USED_MAX)


class Classification(BaseModel):
    intent: Intent
    sentiment: Sentiment
    confidence: float = Field(ge=0.0, le=1.0)
    topic: str | None = Field(default=None, max_length=TOPIC_MAX_LENGTH)
    entities: list[Entity] = Field(default_factory=list, max_length=ENTITIES_MAX)


class ToolSource(BaseModel):
    number: int = Field(ge=1)
    kind: Literal["tool"] = "tool"
    tool: ToolName
    label: str = Field(min_length=1, max_length=200)


class DocumentSource(BaseModel):
    number: int = Field(ge=1)
    kind: Literal["document"] = "document"
    document_id: ObjectIdString
    department_id: ObjectIdString
    chunk_index: int = Field(ge=0)
    heading_path: list[str] = Field(default_factory=list)
    page: int | None = None
    excerpt: str = Field(min_length=1)
    score: float


class ConversationSource(BaseModel):
    number: int = Field(ge=1)
    kind: Literal["conversation"] = "conversation"
    session_id: ObjectIdString


Source = Annotated[ToolSource | DocumentSource | ConversationSource, Field(discriminator="kind")]


class Suggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=SUGGESTION_MAX_LENGTH)
    intent: Intent


class TokenUsage(BaseModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)


class NskTurnResponse(BaseModel):
    outcome: TurnOutcome
    reply: str = Field(min_length=1, max_length=REPLY_MAX_LENGTH)
    classification: Classification
    sources: list[Source] = Field(default_factory=list, max_length=SOURCES_MAX)
    suggestions: list[Suggestion] = Field(default_factory=list, max_length=SUGGESTIONS_MAX)
    tools_used: list[ToolName] = Field(default_factory=list, max_length=TOOLS_USED_MAX)
    usage: TokenUsage | None = None
