"""
Post-generation output guardrail: stops worker replies from claiming actions the AI cannot take.

=================================================================================================
Why a deterministic guard
=================================================================================================

The workers are text-only: they cannot read or change accounts, issue refunds, open tickets, or
hand anything to staff. Their system prompts say so, but prompting is probabilistic, and models
still produce sentences such as "I'll pass the invoice date to our billing specialists" or "Your
refund has been processed". To a customer those are commitments, and they are false. This module
runs after generation and before the reply is stored or returned, and its behaviour depends only on
the text, so the same reply always gets the same outcome.

=================================================================================================
What is detected (the prohibited pattern matrix)
=================================================================================================

Each reply is split into sentences, and each sentence is checked against PROHIBITED_PATTERNS:

  first_person_action_claim   "I've forwarded…", "I'll pass … to…", "We have updated your account",
                              "I'm going to escalate…", "Let me open a ticket…": a first-person
                              subject (optionally with have/will/am going to/just/already…)
                              directly followed by an action verb the AI cannot perform.
  passive_completion_claim    "Your refund has been processed", "Your request will be forwarded",
                              "The ticket was created": an account/request noun with a
                              completed or promised passive action.
  staff_commitment            "Our billing team will review the charge", "They'll get back to you",
                              "The team has been notified": promises that staff will act, which
                              implies something was handed over.
  fabricated_reference        "Ticket #48213", "Case number: ABC-1234": reference ids the AI could
                              only have invented.

Deliberately not matched, because they are honest: modal possibility ("a specialist can review
it"), negation ("I can't process refunds"), the customer as subject ("you can update your card
under Billing"), and needs rather than actions ("the team will need the invoice date").
Apostrophes are matched in both straight (') and typographic (’) form, since models emit both.

=================================================================================================
Remediation
=================================================================================================

  PASSED     no violation: the reply is returned unchanged.
  SANITIZED  violating sentences are removed, and CLARIFICATION_SENTENCE is appended once, so the
             customer is told plainly what the assistant can and cannot do. Line structure
             (paragraphs, numbered lists) is preserved, lines left empty are dropped, and ordered
             lists are renumbered so a removed item leaves no gap.
  ESCALATED  removing the violations would leave too little of the reply to be useful (less than
             MIN_REMAINING_CHARACTERS, or more than MAX_REMOVED_FRACTION of the text removed). The
             caller replaces the reply with the human handoff message and routes the conversation to
             a human, who can actually take the action the customer needs.

Every non-PASSED result carries the violations found (pattern id, category, matched phrase) for
the audit trail. Matched phrases are bounded by the patterns (verbs and their immediate subject),
so they do not carry customer data such as card digits.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum

APOSTROPHE = r"['’]"

# Action verbs (all inflections) for things only staff or backend systems can do.
_ACTION_VERBS = (
    r"forward(?:ed|ing)?|pass(?:ed|ing)?|sen[dt](?:ing)?|escalat(?:e|ed|ing)|submit(?:ted|ting)?|"
    r"rais(?:e|ed|ing)|open(?:ed|ing)?|creat(?:e|ed|ing)|fil(?:e|ed|ing)|log(?:ged|ging)?|flag(?:ged|ging)?|"
    r"notif(?:y|ied|ying)|transferr?(?:ed|ing)?|refer(?:red|ring)?|updat(?:e|ed|ing)|chang(?:e|ed|ing)|"
    r"process(?:ed|ing)?|issu(?:e|ed|ing)|refund(?:ed|ing)?|cancel(?:led|ed|ling|ing)?|reset(?:ting)?|"
    r"credit(?:ed|ing)?|appl(?:y|ied|ying)|reactivat(?:e|ed|ing)|unlock(?:ed|ing)?|restor(?:e|ed|ing)|"
    r"adjust(?:ed|ing)?|waiv(?:e|ed|ing)|revers(?:e|ed|ing)|shar(?:e|ed|ing)|contact(?:ed|ing)?|"
    r"reach(?:ed|ing)?\s+out|look(?:ed|ing)?\s+into|fix(?:ed|ing)?|resolv(?:e|ed|ing)|correct(?:ed|ing)?|"
    r"verif(?:y|ied|ying)|investigat(?:e|ed|ing)|arrang(?:e|ed|ing)|schedul(?:e|ed|ing)|book(?:ed|ing)?"
)

# Past participles used in passive constructions ("has been processed", "will be forwarded").
_PASSIVE_PARTICIPLES = (
    r"forwarded|passed(?:\s+(?:on|along))?|sent|escalated|submitted|raised|opened|created|filed|logged|"
    r"flagged|processed|issued|refunded|credited|cancell?ed|updated|changed|reset|applied|reactivated|"
    r"unlocked|restored|adjusted|waived|reversed|resolved|fixed|noted|recorded|shared|reviewed|"
    r"investigated|corrected|scheduled|arranged"
)

# Nouns whose state the AI cannot change.
_ACCOUNT_NOUNS = (
    r"refund|account|request|ticket|case|charge|payment|subscription|plan|details|information|issue|"
    r"report|complaint|password|invoice|order|card|billing|query|concern|credit|cancellation"
)

# Staff commitments: what a team "will" do.
_STAFF_ACTIONS = (
    r"review|look\s+into|investigate|contact|reach\s+out|get\s+back|follow\s+up|process|handle|resolve|"
    r"fix|refund|update|call|email|be\s+in\s+touch|verify|confirm|correct|reverse|credit|sort\s+(?:it|this)\s+out"
)


class ViolationCategory(str, Enum):
    FIRST_PERSON_ACTION_CLAIM = "first_person_action_claim"
    PASSIVE_COMPLETION_CLAIM = "passive_completion_claim"
    STAFF_COMMITMENT = "staff_commitment"
    FABRICATED_REFERENCE = "fabricated_reference"


@dataclass(frozen=True)
class ProhibitedPattern:
    pattern_id: str
    category: ViolationCategory
    expression: re.Pattern[str]


PROHIBITED_PATTERNS: tuple[ProhibitedPattern, ...] = (
    ProhibitedPattern(
        "first_person_action",
        ViolationCategory.FIRST_PERSON_ACTION_CLAIM,
        # Subject "I"/"we", optional auxiliary (I've, I'll, I'm, we have, we will, I am, ...),
        # optional adverbs/phrases (just, already, now, going to, go ahead and, be ...),
        # then an action verb. Negations (can't, won't, haven't, will not) never match because
        # "not"/"n't" is not an allowed connector.
        re.compile(
            rf"\b(?:I|we)(?:\s*{APOSTROPHE}(?:ve|ll|m|re)|\s+(?:have|will|shall|am|are))?"
            rf"(?:\s+(?:just|already|now|also|personally|immediately|gone\s+ahead\s+and|go\s+ahead\s+and|going\s+to|be))*"
            rf"\s+(?:{_ACTION_VERBS})\b",
            re.IGNORECASE,
        ),
    ),
    ProhibitedPattern(
        "let_me_action",
        ViolationCategory.FIRST_PERSON_ACTION_CLAIM,
        re.compile(rf"\blet\s+me\s+(?:just\s+|quickly\s+|go\s+ahead\s+and\s+)?(?:{_ACTION_VERBS})\b", re.IGNORECASE),
    ),
    ProhibitedPattern(
        "passive_completion",
        ViolationCategory.PASSIVE_COMPLETION_CLAIM,
        # Completed ("has been / was processed"), in-progress ("is being forwarded"), or promised
        # ("will be refunded") actions on an account noun. Plain present tense ("refunds are
        # processed within 5 days") is not matched: it describes a general process, not an action.
        re.compile(
            rf"\b(?:{_ACCOUNT_NOUNS})s?\s+"
            rf"(?:(?:has|have|had)\s+(?:now\s+|already\s+|just\s+|also\s+)?been"
            rf"|(?:was|were)(?:\s+(?:now|already|just|also|successfully))?"
            rf"|(?:is|are)\s+(?:now\s+|already\s+)?being"
            rf"|will\s+(?:now\s+|also\s+|soon\s+)?be)"
            rf"\s+(?:{_PASSIVE_PARTICIPLES})\b",
            re.IGNORECASE,
        ),
    ),
    ProhibitedPattern(
        "staff_will_act",
        ViolationCategory.STAFF_COMMITMENT,
        re.compile(
            rf"\b(?:team|specialists?|department|engineers?|staff|colleagues?|agents?|they)"
            rf"(?:\s+(?:will|should|is\s+going\s+to|are\s+going\s+to)|\s*{APOSTROPHE}ll)"
            rf"\s+(?:(?:now|then|soon|shortly|promptly|quickly|be\s+able\s+to)\s+)?(?:{_STAFF_ACTIONS})\b",
            re.IGNORECASE,
        ),
    ),
    ProhibitedPattern(
        "staff_notified",
        ViolationCategory.STAFF_COMMITMENT,
        re.compile(
            r"\b(?:team|department|specialists?|staff|engineers?)\s+(?:has|have)\s+(?:now\s+|already\s+)?been\s+"
            r"(?:notified|informed|alerted|contacted|made\s+aware|looped\s+in)\b",
            re.IGNORECASE,
        ),
    ),
    ProhibitedPattern(
        "fabricated_reference",
        ViolationCategory.FABRICATED_REFERENCE,
        re.compile(
            r"\b(?:ticket|case|reference|confirmation|tracking)\s*(?:number|no\.?|id)?\s*(?:is\s*)?[:#]\s*[A-Z0-9][A-Z0-9-]{3,}\b",
            re.IGNORECASE,
        ),
    ),
)

# Appended once to a sanitized reply. Honest about capability, and points to the real path.
CLARIFICATION_SENTENCE = (
    "To be clear, I can't make changes to accounts or pass information to other teams myself, "
    "but I can guide you through the next steps, and a member of our support team can take any action needed."
)

# Escalate instead of sanitizing when the cleaned reply would be this short...
MIN_REMAINING_CHARACTERS = 40
# ...or when more than this fraction of the reply's characters had to be removed.
MAX_REMOVED_FRACTION = 0.5
# Bound on the matched phrase kept for the audit trail.
MAX_MATCHED_PHRASE_LENGTH = 80

# Sentence boundary: ., ! or ? followed by whitespace and an uppercase letter, quote, bracket, or
# markdown emphasis. A digit before the punctuation never ends a sentence, so numbered list markers
# ("1. Open Settings") stay attached to their item.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[A-Za-z\)\]\"'’*][.!?])\s+(?=[A-Z\"'“(*\[])")


class GuardOutcome(str, Enum):
    PASSED = "passed"
    SANITIZED = "sanitized"
    ESCALATED = "escalated"


@dataclass(frozen=True)
class GuardViolation:
    pattern_id: str
    category: ViolationCategory
    matched_phrase: str


@dataclass(frozen=True)
class GuardResult:
    outcome: GuardOutcome
    # The text to send: unchanged (PASSED), cleaned (SANITIZED), or None (ESCALATED: the caller
    # sends the human handoff message instead).
    final_text: str | None
    violations: tuple[GuardViolation, ...] = field(default_factory=tuple)
    removed_sentence_count: int = 0

    def describe(self) -> str:
        """One-line audit summary, e.g. 'sanitized: removed 1 sentence (first_person_action_claim: "I'll pass")'."""
        if self.outcome is GuardOutcome.PASSED:
            return "passed: no prohibited action claims"
        violation_summary = ", ".join(
            f'{violation.category.value}: "{violation.matched_phrase}"' for violation in self.violations
        )
        sentence_word = "sentence" if self.removed_sentence_count == 1 else "sentences"
        return f"{self.outcome.value}: {self.removed_sentence_count} {sentence_word} with violations ({violation_summary})"


def find_violations(sentence: str) -> list[GuardViolation]:
    """Every prohibited pattern that matches the sentence, in PROHIBITED_PATTERNS order."""
    violations: list[GuardViolation] = []
    for prohibited_pattern in PROHIBITED_PATTERNS:
        pattern_match = prohibited_pattern.expression.search(sentence)
        if pattern_match:
            matched_phrase = " ".join(pattern_match.group(0).split())[:MAX_MATCHED_PHRASE_LENGTH]
            violations.append(GuardViolation(prohibited_pattern.pattern_id, prohibited_pattern.category, matched_phrase))
    return violations


def _split_line_into_sentences(line: str) -> list[str]:
    return [sentence for sentence in _SENTENCE_BOUNDARY.split(line) if sentence.strip()]


# An ordered-list item: indentation, a number, "." or ")", then the item text.
_ORDERED_LIST_ITEM = re.compile(r"^(?P<indent>\s*)(?P<number>\d{1,3})(?P<delimiter>[.)])(?P<rest>\s+.*)$")


def _renumber_ordered_lists(lines: list[str]) -> list[str]:
    """
    Renumbers ordered lists so removing an item leaves no gap (1, 3 -> 1, 2).

    A list block is a run of consecutive item lines; any other line (text or blank) ends the block.
    Inside a block, each indentation level keeps its own counter, starting from the first number
    written at that level, so nested lists are numbered independently and an outer list resumes
    its own sequence after a nested one. Returning to a shallower level discards the counters of
    deeper levels, so the next nested list starts fresh.
    """
    renumbered_lines: list[str] = []
    next_number_by_indent_width: dict[int, int] = {}
    for line in lines:
        item_match = _ORDERED_LIST_ITEM.match(line)
        if item_match is None:
            next_number_by_indent_width.clear()
            renumbered_lines.append(line)
            continue
        indent_width = len(item_match.group("indent").expandtabs(4))
        for deeper_indent_width in [width for width in next_number_by_indent_width if width > indent_width]:
            del next_number_by_indent_width[deeper_indent_width]
        item_number = next_number_by_indent_width.get(indent_width, int(item_match.group("number")))
        next_number_by_indent_width[indent_width] = item_number + 1
        renumbered_lines.append(
            f"{item_match.group('indent')}{item_number}{item_match.group('delimiter')}{item_match.group('rest')}"
        )
    return renumbered_lines


def _is_structural_remnant(line: str) -> bool:
    """True for lines with no words left, e.g. a list marker "2." whose only sentence was removed."""
    return re.fullmatch(r"[\s\-*•>#\d.)\]:]*", line) is not None


def validate_and_sanitize_output(generated_text: str) -> GuardResult:
    """
    Checks a worker's reply for claims of actions the AI cannot take and remediates them.
    See the module docstring for the patterns and the PASSED / SANITIZED / ESCALATED rules.
    """
    all_violations: list[GuardViolation] = []
    removed_sentence_count = 0
    removed_character_count = 0
    kept_lines: list[str] = []

    # Lines are processed independently so paragraph breaks and list structure survive sanitizing.
    for original_line in generated_text.splitlines():
        if not original_line.strip():
            kept_lines.append(original_line)
            continue
        kept_sentences: list[str] = []
        for sentence in _split_line_into_sentences(original_line):
            sentence_violations = find_violations(sentence)
            if sentence_violations:
                all_violations.extend(sentence_violations)
                removed_sentence_count += 1
                removed_character_count += len(sentence)
            else:
                kept_sentences.append(sentence)
        rebuilt_line = " ".join(kept_sentences)
        if kept_sentences and not _is_structural_remnant(rebuilt_line):
            kept_lines.append(rebuilt_line)

    if not all_violations:
        return GuardResult(GuardOutcome.PASSED, generated_text)

    # Close numbering gaps left by removed list items, then collapse runs of blank lines left
    # behind by removed paragraphs. Only sanitized text is touched; PASSED text is returned as is.
    sanitized_body = re.sub(r"\n{3,}", "\n\n", "\n".join(_renumber_ordered_lists(kept_lines))).strip()
    total_character_count = max(len(generated_text.strip()), 1)
    removed_fraction = removed_character_count / total_character_count

    if len(sanitized_body) < MIN_REMAINING_CHARACTERS or removed_fraction > MAX_REMOVED_FRACTION:
        return GuardResult(GuardOutcome.ESCALATED, None, tuple(all_violations), removed_sentence_count)

    return GuardResult(
        GuardOutcome.SANITIZED,
        f"{sanitized_body}\n\n{CLARIFICATION_SENTENCE}",
        tuple(all_violations),
        removed_sentence_count,
    )
