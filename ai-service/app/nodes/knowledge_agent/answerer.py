"""
KnowledgeAnswerer: answers one employee question from a department's knowledge. Nothing is stored
here; the backend keeps the conversation and sends its recent messages with each question.

Turn
----
  1. Retrieve   the department's KNOWLEDGE_ANSWER_TOP_K passages closest to the question
                (PassageRetriever, the knowledge service). Those below KNOWLEDGE_MIN_RELEVANCE are
                dropped. None left: NOT_FOUND, and the model is not called.
  2. Generate   the model answers from the numbered passages only (prompts.py), streamed: each piece
                goes to `on_delta` as it arrives, except that text which may still turn out to be the
                NOT_FOUND marker is held back until it cannot.
  3. Check      NOT_FOUND from the model -> NOT_FOUND. Otherwise citation marks that point at no
                passage are removed (citations.py) and the output guard
                (app/guards/output_guard.py) removes claims of actions the AI cannot take. A
                sentence that cites a passage restates the documents ("We review requests every
                Tuesday [2]"), so there only the assistant claiming something for itself counts.
                No valid citation left, or the guard escalates -> REFUSED with a fixed reply: an
                answer that cannot be traced to the documents is not sent.

The final answer is authoritative: when the checks changed what was streamed, the caller replaces
the streamed text with it.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk

from app.guards.output_guard import GuardOutcome, validate_and_sanitize_output
from app.knowledge.schemas import RetrievedPassage
from app.nodes.knowledge_agent.citations import CITATION_GROUP_PATTERN, check_citations, citations_for
from app.nodes.knowledge_agent.prompts import NOT_FOUND_MARKER, build_messages
from app.nodes.knowledge_agent.schemas import (
    AnswerOutcome,
    KnowledgeAnswerInput,
    KnowledgeAnswerResponse,
    TokenUsage,
)

logger = logging.getLogger("ai_service.knowledge_agent")

# Fixed replies; the backend may show its own text for each outcome instead.
NOT_FOUND_REPLY = (
    "I couldn't find this in the {department_name} knowledge base. You can send your question to the "
    "department, and they will get back to you."
)
REFUSED_REPLY = (
    "I couldn't find a reliable answer to this in the {department_name} knowledge base. You can send "
    "your question to the department, and they will get back to you."
)
# Characters around the marker the model may add ("NOT_FOUND." or "`NOT_FOUND`").
MARKER_DECORATION = " \t\r\n.`'\"*"

DeltaSink = Callable[[str], Awaitable[None]]


class PassageRetriever(Protocol):
    async def search_passages(self, *, department_id: str, question: str, limit: int) -> list[RetrievedPassage]: ...


@dataclass(frozen=True)
class AnswerSettings:
    top_k: int
    min_relevance: float
    history_messages: int
    excerpt_chars: int


def is_not_found(text: str) -> bool:
    return text.strip(MARKER_DECORATION).startswith(NOT_FOUND_MARKER)


def could_still_be_marker(text: str) -> bool:
    """True while `text` is empty or a beginning of the marker (so it must not be streamed yet)."""
    stripped = text.lstrip(MARKER_DECORATION)
    return len(stripped) < len(NOT_FOUND_MARKER) and NOT_FOUND_MARKER.startswith(stripped)


def usage_of(message: AIMessageChunk | None) -> TokenUsage | None:
    usage = getattr(message, "usage_metadata", None) if message is not None else None
    if not usage:
        return None
    return TokenUsage(input_tokens=usage.get("input_tokens", 0), output_tokens=usage.get("output_tokens", 0))


class KnowledgeAnswerer:
    def __init__(self, model: BaseChatModel, retriever: PassageRetriever, settings: AnswerSettings) -> None:
        self._model = model
        self._retriever = retriever
        self._settings = settings

    async def relevant_passages(self, answer_input: KnowledgeAnswerInput) -> list[RetrievedPassage]:
        """The department's closest passages that are relevant enough, most relevant first."""
        passages = await self._retriever.search_passages(
            department_id=answer_input.department_id, question=answer_input.question, limit=self._settings.top_k
        )
        return [passage for passage in passages if passage.score >= self._settings.min_relevance]

    async def answer(
        self, answer_input: KnowledgeAnswerInput, on_delta: DeltaSink | None = None
    ) -> KnowledgeAnswerResponse:
        passages = await self.relevant_passages(answer_input)
        if not passages:
            return self._fixed(AnswerOutcome.NOT_FOUND, answer_input, passages_considered=0, usage=None)

        text, usage = await self._generate(answer_input, passages, on_delta)
        if is_not_found(text):
            return self._fixed(AnswerOutcome.NOT_FOUND, answer_input, passages_considered=len(passages), usage=usage)

        checked = check_citations(text, len(passages))
        guarded = validate_and_sanitize_output(checked.text, cited_sentence=CITATION_GROUP_PATTERN, clarification=None)
        final_text = guarded.final_text if guarded.outcome is not GuardOutcome.ESCALATED else None
        # The guard may remove the sentences that held the citations; check what is left.
        rechecked = check_citations(final_text, len(passages)) if final_text else None
        if rechecked is None or not rechecked.cited_numbers:
            logger.warning(
                "Knowledge answer refused",
                extra={
                    "reason": "guard_escalated" if final_text is None else "no_valid_citation",
                    "removed_citation_marks": checked.removed_marks,
                    "passages": len(passages),
                },
            )
            return self._fixed(AnswerOutcome.REFUSED, answer_input, passages_considered=len(passages), usage=usage)

        return KnowledgeAnswerResponse(
            outcome=AnswerOutcome.ANSWERED,
            answer=rechecked.text,
            citations=citations_for(rechecked.cited_numbers, passages, excerpt_chars=self._settings.excerpt_chars),
            passages_considered=len(passages),
            usage=usage,
        )

    async def _generate(
        self, answer_input: KnowledgeAnswerInput, passages: Sequence[RetrievedPassage], on_delta: DeltaSink | None
    ) -> tuple[str, TokenUsage | None]:
        messages = build_messages(answer_input, passages, history_limit=self._settings.history_messages)
        written = ""
        streamed_length = 0
        aggregate: AIMessageChunk | None = None
        async for chunk in self._model.astream(messages):
            aggregate = chunk if aggregate is None else aggregate + chunk
            piece = chunk.content if isinstance(chunk.content, str) else ""
            if not piece:
                continue
            written += piece
            if on_delta is not None and not could_still_be_marker(written) and not is_not_found(written):
                await on_delta(written[streamed_length:])
                streamed_length = len(written)
        return written, usage_of(aggregate)

    def _fixed(
        self,
        outcome: AnswerOutcome,
        answer_input: KnowledgeAnswerInput,
        *,
        passages_considered: int,
        usage: TokenUsage | None,
    ) -> KnowledgeAnswerResponse:
        template = NOT_FOUND_REPLY if outcome is AnswerOutcome.NOT_FOUND else REFUSED_REPLY
        return KnowledgeAnswerResponse(
            outcome=outcome,
            answer=template.format(department_name=answer_input.department_name),
            citations=[],
            passages_considered=passages_considered,
            usage=usage,
        )
