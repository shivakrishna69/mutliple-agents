/**
 * The password rules as the screens show them (GET /api/auth/password-policy), built from the same
 * constants the validators enforce (validators/authValidators.js checkNewPassword), so the checklist
 * on screen and the check on the server cannot drift apart.
 *
 *   checks          each item of the checklist: the minimum length, then every strength rule as a
 *                   regular expression (source and flags) the screen can test while the person types
 *   strengthLevels  the meter: a level and its label by how many checks are met
 *   maxBytes        bcrypt's limit; the server refuses longer passwords
 */

import { PASSWORD_CHECKLIST_LABELS, PASSWORD_STRENGTH_LABELS } from '../constants/messages.js';
import { PASSWORD_STRENGTH_LEVELS, PASSWORD_STRENGTH_RULES, USER_FIELD_LIMITS } from '../constants/validation.js';

export function describePasswordPolicy() {
  return {
    minLength: USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH,
    maxBytes: USER_FIELD_LIMITS.PASSWORD_MAX_BYTES,
    checks: [
      {
        id: 'minimumLength',
        label: PASSWORD_CHECKLIST_LABELS.minimumLength,
        minLength: USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH,
      },
      ...PASSWORD_STRENGTH_RULES.map(({ ruleId, pattern }) => ({
        id: ruleId,
        label: PASSWORD_CHECKLIST_LABELS[ruleId],
        pattern: { source: pattern.source, flags: pattern.flags },
      })),
    ],
    strengthLevels: PASSWORD_STRENGTH_LEVELS.map(({ level, minimumChecksMet }) => ({
      level,
      minimumChecksMet,
      label: PASSWORD_STRENGTH_LABELS[level],
    })),
  };
}
