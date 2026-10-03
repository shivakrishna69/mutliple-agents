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

/** Limits for the HR models (Department, EmployeeProfile), shared with their request validators. */
export const ORGANIZATION_FIELD_LIMITS = Object.freeze({
  DEPARTMENT_NAME_MAX_LENGTH: 120,
  DESIGNATION_MAX_LENGTH: 120,
  // Deepest reporting chain or department tree walked by the cycle check. Real organisations are
  // far shallower (a 100,000-person company is rarely more than 12 levels deep); the cap bounds
  // the cost of the check and of $graphLookup traversals.
  HIERARCHY_MAX_DEPTH: 50,
  // Geofence radius in metres. Below ~25 m, ordinary phone GPS error (5–20 m outdoors, worse
  // indoors) would reject employees standing inside the office; above 10 km it stops being a
  // meaningful site check.
  GEOFENCE_RADIUS_MIN_METRES: 25,
  GEOFENCE_RADIUS_MAX_METRES: 10_000,
  SCORE_MIN: 0,
  SCORE_MAX: 100,
});

/** Limits for the employee document vault (models/DocumentVault.js, controllers/vaultController.js). */
export const VAULT_FIELD_LIMITS = Object.freeze({
  // Largest accepted upload. Files are buffered in memory before going to S3, so this also bounds
  // the memory one upload can hold.
  MAX_FILE_BYTES: 10 * 1024 * 1024,
  ORIGINAL_FILE_NAME_MAX_LENGTH: 255,
  // Lifetime of a pre-signed download URL.
  DOWNLOAD_URL_TTL_SECONDS: 60,
  // Most documents returned by one listing call.
  LIST_LIMIT: 100,
});

/** Limits for attendance punches (models/Attendance.js, controllers/attendanceController.js). */
export const ATTENDANCE_FIELD_LIMITS = Object.freeze({
  // A browser Geolocation reading less precise than this cannot place someone inside a typical
  // office geofence, so the punch is refused and the user asked to retry (usually with GPS on).
  MAX_LOCATION_ACCURACY_METRES: 100,
  DEVICE_FINGERPRINT_MIN_LENGTH: 16,
  DEVICE_FINGERPRINT_MAX_LENGTH: 256,
  OFFICE_NAME_MAX_LENGTH: 120,
  // Shift policy bounds, in minutes.
  LATE_GRACE_MAX_MINUTES: 180,
  HALF_DAY_AFTER_MAX_MINUTES: 720,
  // How many days back the regularization agent may regularize on its own. Must equal
  // MAX_REGULARIZATION_AGE_DAYS in ai-service app/nodes/attendance_agent.py; the backend enforces it
  // regardless of what the agent sends.
  SELF_SERVICE_REGULARIZATION_DAYS: 7,
  // How many days back a manager may approve a reviewed regularization.
  MANAGER_REGULARIZATION_DAYS: 31,
  // Longest employee message forwarded to the regularization agent (matches the ai-service schema).
  REGULARIZATION_MESSAGE_MAX_LENGTH: 2000,
  REVIEW_NOTE_MAX_LENGTH: 500,
});

/** "HH:MM" on a 24-hour clock, 00:00–23:59. */
export const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Calendar date "YYYY-MM-DD" (shape only; real-date validity is checked separately). */
export const CALENDAR_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * Department code: 2–20 characters, uppercase letters and digits, optionally separated by "-"
 * or "_", starting with a letter or digit. Examples: "ENG", "FIN-AP", "HR_OPS2".
 * Values are uppercased before this check runs.
 */
export const DEPARTMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

/**
 * Finance budget / cost-centre code: 1–40 characters of uppercase letters, digits and the
 * separators "-", "_", "/", "." (covers SAP-style "CC-1001" and ledger-style "4100/ENG.01").
 */
export const BUDGET_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_./-]{0,39}$/;

/**
 * MAC-48 address in canonical form: six pairs of uppercase hex digits separated by colons,
 * e.g. "3C:22:FB:7A:10:9E". Inputs written with "-" separators or lowercase are normalised to this
 * form by the model's setter before the check runs.
 */
export const MAC_ADDRESS_PATTERN = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
