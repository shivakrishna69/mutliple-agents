/**
 * Field rules for the auth forms.
 *
 * These mirror backend/constants/validation.js exactly: the same limits, the same email
 * pattern, and the same password strength patterns, checked in the same order. The form
 * therefore rejects precisely what the API would reject, before a request is sent.
 * The backend still validates every request; these checks are for fast feedback, not security.
 * A change to either copy must be made to both.
 */

export const USER_FIELD_LIMITS = Object.freeze({
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 100,
  EMAIL_MAX_LENGTH: 254,
  PASSWORD_MIN_LENGTH: 8,
  // bcrypt on the backend only uses the first 72 bytes, so the API rejects longer passwords.
  // Measured in UTF-8 bytes: "é" is one character but two bytes.
  PASSWORD_MAX_BYTES: 72,
});

/**
 * Email shape check, identical to the backend's:
 *   ^[^\s@]+   one or more characters that are neither whitespace nor "@"  (local part)
 *   @          exactly one "@"
 *   [^\s@]+    one or more non-whitespace, non-"@" characters               (domain name)
 *   \.         a literal dot
 *   [^\s@]+$   one or more non-whitespace, non-"@" characters to the end    (top-level domain)
 * It catches typos such as a missing "@" or domain; it does not prove the address exists.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Password strength rules for signup, each evaluated independently so the form can show
 * a live checklist of which ones are met. Same patterns as the backend's
 * PASSWORD_STRENGTH_RULES; the length rule is listed here too because the checklist shows it.
 */
export const PASSWORD_STRENGTH_RULES = Object.freeze([
  {
    ruleId: 'minimumLength',
    description: `At least ${USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH} characters`,
    isSatisfiedBy: (candidatePassword) => candidatePassword.length >= USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH,
  },
  {
    ruleId: 'uppercaseLetter',
    description: 'One uppercase letter (A–Z)',
    // [A-Z]: at least one ASCII capital letter anywhere in the string.
    isSatisfiedBy: (candidatePassword) => /[A-Z]/.test(candidatePassword),
  },
  {
    ruleId: 'lowercaseLetter',
    description: 'One lowercase letter (a–z)',
    // [a-z]: at least one ASCII lowercase letter anywhere in the string.
    isSatisfiedBy: (candidatePassword) => /[a-z]/.test(candidatePassword),
  },
  {
    ruleId: 'digit',
    description: 'One number (0–9)',
    // \d: at least one digit 0–9.
    isSatisfiedBy: (candidatePassword) => /\d/.test(candidatePassword),
  },
  {
    ruleId: 'specialCharacter',
    description: 'One special character (such as !, @, # or $)',
    // [^A-Za-z0-9\s]: at least one character that is not a letter, digit, or whitespace,
    // i.e. punctuation or a symbol. Spaces are allowed in passwords but do not count here.
    isSatisfiedBy: (candidatePassword) => /[^A-Za-z0-9\s]/.test(candidatePassword),
  },
]);

/** Number of UTF-8 bytes in a string, the unit bcrypt's 72-byte limit is measured in. */
export function measureUtf8ByteLength(textValue) {
  return new TextEncoder().encode(textValue).length;
}

/**
 * Lowercases and trims an email exactly as the backend does before validating and storing it,
 * so length and pattern checks here see the same string the backend will see.
 */
export function normalizeEmail(rawEmail) {
  return rawEmail.trim().toLowerCase();
}
