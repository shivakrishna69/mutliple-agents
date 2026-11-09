"""
Checks the model's citations against the passages it was given.

    [n] marks are found in any of the forms "[1]", "[1][2]", "[1, 2]"; "[1, 2]" is rewritten as
    "[1][2]". A number outside 1..len(passages) cites nothing the model was shown, so that mark is
    removed. The numbers that remain keep the passage's position in the prompt (they are not
    renumbered), so text streamed while the model wrote it matches the final answer.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from app.knowledge.schemas import RetrievedPassage
from app.nodes.knowledge_agent.schemas import Citation

CITATION_GROUP_PATTERN = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
NUMBER_SEPARATOR_PATTERN = re.compile(r"\s*,\s*")
# A space left before punctuation where a mark was removed ("in March [9].").
SPACE_BEFORE_PUNCTUATION_PATTERN = re.compile(r"[ \t]+([.,;:!?])")
EXCERPT_ELLIPSIS = "…"


@dataclass(frozen=True)
class CheckedCitations:
    text: str
    # Passage numbers the text cites, ascending.
    cited_numbers: tuple[int, ...]
    removed_marks: int


def check_citations(text: str, passage_count: int) -> CheckedCitations:
    cited: set[int] = set()
    removed = 0

    def rewrite(group: re.Match[str]) -> str:
        nonlocal removed
        kept = []
        for number_text in NUMBER_SEPARATOR_PATTERN.split(group.group(1)):
            number = int(number_text)
            if 1 <= number <= passage_count:
                kept.append(number)
                cited.add(number)
            else:
                removed += 1
        return "".join(f"[{number}]" for number in kept)

    rewritten = CITATION_GROUP_PATTERN.sub(rewrite, text)
    if removed:
        rewritten = SPACE_BEFORE_PUNCTUATION_PATTERN.sub(r"\1", rewritten)
    return CheckedCitations(text=rewritten.strip(), cited_numbers=tuple(sorted(cited)), removed_marks=removed)


def excerpt_of(text: str, max_chars: int) -> str:
    """The start of `text`, cut at a word boundary when it is longer than `max_chars`."""
    if len(text) <= max_chars:
        return text
    cut = text[: max_chars - len(EXCERPT_ELLIPSIS)]
    last_space = cut.rfind(" ")
    if last_space > max_chars // 2:
        cut = cut[:last_space]
    return cut.rstrip() + EXCERPT_ELLIPSIS


def citations_for(
    cited_numbers: Sequence[int], passages: Sequence[RetrievedPassage], *, excerpt_chars: int
) -> list[Citation]:
    return [
        Citation(
            number=number,
            document_id=passages[number - 1].document_id,
            chunk_index=passages[number - 1].chunk_index,
            heading_path=passages[number - 1].heading_path,
            page=passages[number - 1].page,
            excerpt=excerpt_of(passages[number - 1].text, excerpt_chars),
            score=round(passages[number - 1].score, 4),
        )
        for number in cited_numbers
    ]
