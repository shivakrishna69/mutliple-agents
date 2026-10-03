"""
Request and response contracts between the Node.js backend and this service.

POST /ai/process
  request   ConversationInput
  response  AIProcessResponse (200) or ErrorResponse (4xx/5xx)

Validation is strict on purpose: unknown fields are rejected (`extra="forbid"`), every string has
a length bound, and roles are limited to the two the backend produces. A malformed request is
answered with 422 before any LLM call is made, so bad input can never cost tokens.

Why `message_id` is required on every message
---------------------------------------------
The backend sends the recent transcript on every turn. LangGraph's `add_messages` reducer merges
messages by id: a message whose id is already in the thread's state replaces the stored copy
instead of being appended. Stable ids (the backend's MongoDB message ids) are what make
re-sending history idempotent rather than duplicating the conversation on each turn.

Why there is no "system" role
-----------------------------
System prompts are owned by this service (see agent.py) and injected per LLM call. Accepting
system messages from the caller would let content that ultimately comes from customers reach
the model with system-level authority.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

# Limits shared with the backend (backend/constants/validation.js MESSAGE_FIELD_LIMITS).
MESSAGE_CONTENT_MAX_LENGTH = 20_000
MAX_MESSAGES_PER_REQUEST = 100
MAX_INTERNAL_LOG_ENTRIES = 200

# Printable ASCII without whitespace, 1–200 characters: ids from MongoDB, UUIDs, provider ids.
IdentifierString = Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^[\x21-\x7E]+$")]


class ChatRole(str, Enum):
    """Who wrote a message, from the model's point of view."""

    USER = "user"  # the customer
    ASSISTANT = "assistant"  # anyone answering on the company's behalf: AI workers or human agents


class WorkerName(str, Enum):
    """
    Which part of the system owns the conversation after this turn. Values match the backend's
    Conversation.currentActiveWorker enum; `human` means "escalate to a human agent".
    """

    SUPERVISOR = "supervisor"
    BILLING_AGENT = "billing_agent"
    TECH_AGENT = "tech_agent"
    HUMAN = "human"


class ConversationMessage(BaseModel):
    """One transcript entry, oldest first in ConversationInput.messages."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message_id: IdentifierString = Field(description="Stable id of the stored message; used to merge, not duplicate, history.")
    role: ChatRole
    content: Annotated[str, StringConstraints(min_length=1, max_length=MESSAGE_CONTENT_MAX_LENGTH)]


class ConversationInput(BaseModel):
    """Body of POST /ai/process, sent by the backend for every customer message the AI handles."""

    model_config = ConfigDict(extra="forbid")

    conversation_id: IdentifierString
    customer_id: IdentifierString | None = Field(
        default=None,
        description="The authenticated customer who owns the conversation. Tools that read customer records are "
        "scoped to this id; without it, those tools are unavailable and the worker hands off to a human.",
    )
    thread_id: IdentifierString | None = Field(
        default=None,
        description="Checkpointer thread key. Defaults to conversation_id; set it to keep separate memory per channel.",
    )
    messages: Annotated[list[ConversationMessage], Field(min_length=1, max_length=MAX_MESSAGES_PER_REQUEST)]

    @model_validator(mode="after")
    def validate_transcript(self) -> "ConversationInput":
        message_ids = [conversation_message.message_id for conversation_message in self.messages]
        if len(message_ids) != len(set(message_ids)):
            raise ValueError("message_id values must be unique within a request")
        if self.messages[-1].role is not ChatRole.USER:
            raise ValueError("the last message must have role 'user': the AI only replies to customer messages")
        return self

    @property
    def resolved_thread_id(self) -> str:
        """The checkpointer thread this conversation's state is stored under."""
        return self.thread_id or self.conversation_id


class AIProcessResponse(BaseModel):
    """Successful result of POST /ai/process."""

    model_config = ConfigDict(extra="forbid")

    conversation_id: IdentifierString
    response_content: Annotated[str, StringConstraints(min_length=1, max_length=MESSAGE_CONTENT_MAX_LENGTH)]
    next_worker: WorkerName
    internal_logs: Annotated[list[str], Field(max_length=MAX_INTERNAL_LOG_ENTRIES)] = Field(
        description='Audit trail for this turn only, each entry formatted "<node>: <event>".'
    )


class ErrorDetail(BaseModel):
    message: str
    requestId: str | None = None
    details: list[dict] | None = None


class ErrorResponse(BaseModel):
    """Error body, identical in shape to the backend's: { "error": { message, requestId, details? } }."""

    error: ErrorDetail
