"""The deterministic guard that stops replies from claiming actions the AI cannot take."""

import pytest

from app.guards.output_guard import (
    CLARIFICATION_SENTENCE,
    GuardOutcome,
    ViolationCategory,
    validate_and_sanitize_output,
)

HELPFUL_PARAGRAPH = (
    "Your Pro plan renews on the first day of each month. "
    "You can download every invoice from Settings, then Billing, then Invoice history."
)


@pytest.mark.parametrize(
    "honest_reply",
    [
        "A specialist can review the duplicate charge for you.",
        "I can't process refunds myself.",
        "You can update your card under Billing.",
        "The team will need the invoice date to look at this.",
        "Refunds are processed within 5 working days.",
        "You'll receive a confirmation email from the payment provider.",
    ],
)
def test_honest_statements_pass_unchanged(honest_reply):
    result = validate_and_sanitize_output(honest_reply)
    assert result.outcome is GuardOutcome.PASSED
    assert result.final_text == honest_reply


@pytest.mark.parametrize(
    "cited_record",
    [
        "Our records show your latest invoice was issued on 1 October and was paid on 3 October.",
        "According to our records, your refund was processed on 2 October.",
        "The billing records indicate your September charge was reversed on 5 September.",
    ],
)
def test_past_events_cited_from_the_records_pass_unchanged(cited_record):
    assert validate_and_sanitize_output(cited_record).outcome is GuardOutcome.PASSED


@pytest.mark.parametrize(
    "claim_after_citation",
    [
        "Our records show a failed payment, so your account will be updated today.",
        "Our records show the charge, and I've refunded it for you.",
        "Our records show the duplicate charge, and our billing team will review it.",
        "Our records show the issue. Your ticket number is #48213.",
        "Our records show your invoice was issued on 1 October, and your plan will be changed tomorrow.",
    ],
)
def test_a_records_citation_does_not_excuse_promises_or_claimed_actions(claim_after_citation):
    assert validate_and_sanitize_output(claim_after_citation).outcome is not GuardOutcome.PASSED


def test_a_passive_claim_before_the_citation_is_still_caught():
    reply = "Your refund has been processed, as our records show."
    assert validate_and_sanitize_output(reply).outcome is not GuardOutcome.PASSED


@pytest.mark.parametrize(
    ("claim", "expected_category"),
    [
        ("I've forwarded your request to billing.", ViolationCategory.FIRST_PERSON_ACTION_CLAIM),
        ("I’ll escalate this right away.", ViolationCategory.FIRST_PERSON_ACTION_CLAIM),
        ("Let me open a ticket for you.", ViolationCategory.FIRST_PERSON_ACTION_CLAIM),
        ("Your refund has been processed.", ViolationCategory.PASSIVE_COMPLETION_CLAIM),
        ("Our billing team will review the charge.", ViolationCategory.STAFF_COMMITMENT),
        ("You'll hear back from the team within a day.", ViolationCategory.STAFF_COMMITMENT),
        ("Your ticket number is #48213.", ViolationCategory.FABRICATED_REFERENCE),
    ],
)
def test_each_kind_of_false_claim_is_detected(claim, expected_category):
    result = validate_and_sanitize_output(f"{HELPFUL_PARAGRAPH} {claim}")
    assert result.outcome is GuardOutcome.SANITIZED
    assert expected_category in {violation.category for violation in result.violations}
    assert claim not in result.final_text


def test_sanitizing_keeps_the_helpful_part_and_explains_once():
    result = validate_and_sanitize_output(f"{HELPFUL_PARAGRAPH} I've updated your billing address.")
    assert result.outcome is GuardOutcome.SANITIZED
    assert result.removed_sentence_count == 1
    assert result.final_text == f"{HELPFUL_PARAGRAPH}\n\n{CLARIFICATION_SENTENCE}"


def test_a_reply_that_is_mostly_false_claims_escalates_to_a_human():
    result = validate_and_sanitize_output("I've processed your refund. Your account has been updated.")
    assert result.outcome is GuardOutcome.ESCALATED
    assert result.final_text is None
    assert result.removed_sentence_count == 2


def test_removed_list_items_are_renumbered():
    reply = (
        "Here is what you can try:\n"
        "1. Sign out and sign in again to refresh your session.\n"
        "2. I've reset your password for you.\n"
        "3. Clear the browser cache and reload the dashboard page."
    )
    result = validate_and_sanitize_output(reply)
    assert result.outcome is GuardOutcome.SANITIZED
    assert "1. Sign out" in result.final_text
    assert "2. Clear the browser cache" in result.final_text
    assert "3." not in result.final_text


def test_matched_phrases_are_bounded_and_do_not_carry_the_whole_sentence():
    result = validate_and_sanitize_output(f"{HELPFUL_PARAGRAPH} I've forwarded the card ending 4242 to billing.")
    assert all("4242" not in violation.matched_phrase for violation in result.violations)
    assert result.describe().startswith("sanitized: 1 sentence")
