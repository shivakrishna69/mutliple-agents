/**
 * Field rules shared by the User model and the request validators.
 * Keeping them in one place means the API rejects a value for the same reason
 * the database would, and the two can never drift apart.
 */

export const USER_FIELD_LIMITS = Object.freeze({
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 100,
  // Maximum length of an email address per RFC 5321 (forward-path limit).
  EMAIL_MAX_LENGTH: 254,
  PASSWORD_MIN_LENGTH: 8,
  // bcrypt only uses the first 72 bytes of its input; anything longer would be silently
  // ignored, so a longer password would give a false sense of strength. Measured in UTF-8
  // bytes, not characters, because multi-byte characters count more than once.
  PASSWORD_MAX_BYTES: 72,
});

/**
 * Password strength rules applied at signup, in addition to the length limits above.
 * Each pattern must match at least once somewhere in the password. Messages for each
 * `ruleId` live in constants/messages.js (PASSWORD_RULE_MESSAGES).
 *
 * The frontend (frontend/src/constants/validation.js) enforces the same rules with the same
 * patterns for instant feedback. This backend copy is the one that actually protects the
 * system: the API rejects a weak password no matter which client sent it.
 */
export const PASSWORD_STRENGTH_RULES = Object.freeze([
  // [A-Z]: at least one ASCII uppercase letter.
  { ruleId: 'uppercaseLetter', pattern: /[A-Z]/ },
  // [a-z]: at least one ASCII lowercase letter.
  { ruleId: 'lowercaseLetter', pattern: /[a-z]/ },
  // \d: at least one digit 0–9.
  { ruleId: 'digit', pattern: /\d/ },
  // [^A-Za-z0-9\s]: at least one character that is not a letter, digit, or whitespace
  // (punctuation or a symbol). Spaces are allowed in passwords but do not satisfy this rule.
  { ruleId: 'specialCharacter', pattern: /[^A-Za-z0-9\s]/ },
]);

/** Limits for conversation messages, shared by the Message model and the webhook validator. */
export const MESSAGE_FIELD_LIMITS = Object.freeze({
  // Large enough for a long AI answer; keeps a message far below MongoDB's 16 MB document limit.
  TEXT_MAX_LENGTH: 20_000,
});

/** Limits for inbound webhook payloads. */
export const WEBHOOK_FIELD_LIMITS = Object.freeze({
  // The sender's unique id for this message, used for de-duplication. Provider ids are typically
  // UUIDs or similar; 200 characters leaves room for prefixed formats.
  EVENT_ID_MAX_LENGTH: 200,
  // Signatures older or newer than this are rejected, which bounds how long a captured request
  // could be replayed (replays inside the window are caught by eventId de-duplication).
  SIGNATURE_TOLERANCE_SECONDS: 300,
});

/** Printable ASCII without whitespace: what an eventId may contain. */
export const WEBHOOK_EVENT_ID_PATTERN = /^[\x21-\x7E]+$/;

/**
 * Pragmatic email shape check: one "@", no whitespace, and a dot in the domain.
 * Full RFC 5322 validation is not attempted; deliverability is proven only by sending mail.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
