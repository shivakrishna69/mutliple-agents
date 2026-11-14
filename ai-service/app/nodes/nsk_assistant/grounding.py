"""
The zero-invention check on an NSK reply: every number in it must come from the evidence the turn
had (tool results, document passages, earlier sessions, the person's own words, today's date).

A number is a run of digits with an optional decimal part. Digit-group commas ("1,20,000") are
ignored, leading zeros of a whole part ("03") and trailing zeros of a decimal part ("1.50") are not
significant, so "2026-11-03" supports "3 November 2026" and "09:05" supports "9:05". Citation marks
("[2]") and list numbering ("1. ") are not numbers of the answer.

check_numbers(reply, evidence) removes each sentence carrying a number the evidence does not have.
The result says what was removed; the caller refuses the reply when too little is left
(MIN_KEPT_FRACTION of the sentences, or nothing), because a reply that had to lose most of its facts
would mislead more than it helps.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

NUMBER_PATTERN = re.compile(r"\d+(?:\.\d+)?")
DIGIT_GROUP_COMMA = re.compile(r"(?<=\d),(?=\d)")
CITATION_MARK = re.compile(r"\[\d+(?:\s*,\s*\d+)*\]")
LIST_NUMBERING = re.compile(r"(?m)^(\s*)\d+[.)]\s+")
LIST_ITEM_MARKER = re.compile(r"^\s*(?:\d+[.)]|[-*•])\s+")
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=\S)")
MIN_KEPT_FRACTION = 0.5


@dataclass(frozen=True)
class NumberCheck:
    text: str
    removed_sentences: int
    kept_sentences: int
    unverified: tuple[str, ...]

    @property
    def is_usable(self) -> bool:
        total = self.removed_sentences + self.kept_sentences
        return bool(self.text.strip()) and (total == 0 or self.kept_sentences / total >= MIN_KEPT_FRACTION)


def normalize_number(number: str) -> str:
    whole, _, decimals = number.partition(".")
    whole = whole.lstrip("0") or "0"
    decimals = decimals.rstrip("0")
    return f"{whole}.{decimals}" if decimals else whole


def numbers_in(text: str) -> set[str]:
    without_marks = LIST_NUMBERING.sub(r"\1", CITATION_MARK.sub(" ", text))
    return {normalize_number(match) for match in NUMBER_PATTERN.findall(DIGIT_GROUP_COMMA.sub("", without_marks))}


def evidence_numbers(evidence: Iterable[str]) -> set[str]:
    found: set[str] = set()
    for text in evidence:
        found |= numbers_in(text)
    return found


def check_numbers(reply: str, evidence: Iterable[str]) -> NumberCheck:
    """The reply without the sentences whose numbers the evidence does not contain."""
    known = evidence_numbers(evidence)
    kept_lines: list[str] = []
    removed = kept = 0
    unverified: list[str] = []
    for line in reply.splitlines():
        if not line.strip():
            kept_lines.append(line)
            continue
        # A list item's number ("2. ") is kept with the item, not checked as a fact.
        marker = LIST_ITEM_MARKER.match(line)
        prefix = marker.group(0) if marker else ""
        kept_sentences = []
        for sentence in SENTENCE_BOUNDARY.split(line[len(prefix) :]):
            missing = sorted(numbers_in(sentence) - known)
            if missing:
                removed += 1
                unverified.extend(missing)
            else:
                kept += 1
                kept_sentences.append(sentence)
        if kept_sentences:
            kept_lines.append(prefix + " ".join(kept_sentences))
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(kept_lines)).strip()
    return NumberCheck(
        text=text, removed_sentences=removed, kept_sentences=kept, unverified=tuple(dict.fromkeys(unverified))
    )
