/**
 * Which of the server's password checks (GET /api/auth/password-policy) a password meets: the
 * minimum length, then each rule's regular expression. Used to draw the strength meter while the
 * person types; the server checks the password itself on submit.
 */

export function evaluatePasswordChecks(password, passwordPolicy) {
  return passwordPolicy.checks.map((check) => ({
    ...check,
    isMet: check.pattern
      ? new RegExp(check.pattern.source, check.pattern.flags).test(password)
      : password.length >= check.minLength,
  }));
}
