/**
 * The password policy the screens receive (services/passwordPolicy.js) must agree with the check
 * the server applies (validators/authValidators.js checkNewPassword): a password meets every
 * published check exactly when the server accepts it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PASSWORD_CHECKLIST_LABELS, PASSWORD_STRENGTH_LABELS } from '../../constants/messages.js';
import { describePasswordPolicy } from '../../services/passwordPolicy.js';
import { checkNewPassword } from '../../validators/authValidators.js';

const policy = describePasswordPolicy();

/** What a screen does with the policy: count the checks a password meets. */
function checksMet(password) {
  return policy.checks.filter((check) =>
    check.pattern
      ? new RegExp(check.pattern.source, check.pattern.flags).test(password)
      : password.length >= check.minLength,
  ).length;
}

function strengthOf(password) {
  const met = checksMet(password);
  return policy.strengthLevels.filter((level) => met >= level.minimumChecksMet).at(-1).level;
}

describe('describePasswordPolicy', () => {
  it('lists the length check and every strength rule, labelled from the server messages', () => {
    assert.deepEqual(
      policy.checks.map((check) => check.id),
      ['minimumLength', 'uppercaseLetter', 'lowercaseLetter', 'digit', 'specialCharacter'],
    );
    for (const check of policy.checks) assert.equal(check.label, PASSWORD_CHECKLIST_LABELS[check.id]);
    assert.deepEqual(
      policy.strengthLevels.map((level) => level.label),
      Object.values(PASSWORD_STRENGTH_LABELS),
    );
  });

  it('agrees with the server: every check met exactly when the password is accepted', () => {
    for (const password of [
      'Valid#Pass2026',
      'short1!A',
      'alllowercase1!',
      'ALLUPPERCASE1!',
      'NoDigitsHere!',
      'NoSymbols2026',
      'Spaces are 1 Not symbols',
      'Ab1!',
      '',
    ]) {
      const acceptedByServer = checkNewPassword(password) === null;
      assert.equal(checksMet(password) === policy.checks.length, acceptedByServer, password);
      assert.equal(strengthOf(password) === 'strong', acceptedByServer, password);
    }
  });

  it('rates weaker passwords on the meter while typing', () => {
    assert.equal(strengthOf('abc'), 'weak');
    assert.equal(strengthOf('abcdefgh1'), 'fair');
    assert.equal(strengthOf('Abcdefgh1'), 'good');
    assert.equal(strengthOf('Abcdefgh1!'), 'strong');
  });
});
