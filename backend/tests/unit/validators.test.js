import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkNewPassword,
  validateChangePasswordInput,
  validateLoginInput,
  validateRegistrationInput,
} from '../../validators/authValidators.js';
import { validateInvitationInput } from '../../validators/peopleValidators.js';
import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../../models/EmployeeProfile.js';

const STRONG_PASSWORD = 'Valid#Pass2026';

function fieldsOf(validationResult) {
  return validationResult.validationErrors.map((validationError) => validationError.field);
}

describe('checkNewPassword', () => {
  it('accepts a password meeting every rule', () => {
    assert.equal(checkNewPassword(STRONG_PASSWORD), null);
  });

  it('rejects short, oversized, non-string and rule-breaking passwords', () => {
    for (const weakPassword of [
      'Ab#1',
      'alllowercase#1',
      'ALLUPPERCASE#1',
      'NoDigits#here',
      'NoSpecial123',
      'É'.repeat(40),
    ]) {
      assert.notEqual(checkNewPassword(weakPassword), null, `expected "${weakPassword.slice(0, 20)}" to be rejected`);
    }
    assert.notEqual(checkNewPassword(undefined), null);
    assert.notEqual(checkNewPassword(12345678), null);
  });
});

describe('validateRegistrationInput', () => {
  it('normalises the email, trims the name and drops unexpected fields such as role', () => {
    const result = validateRegistrationInput({
      name: '  Asha Rao ',
      email: ' Asha.Rao@Example.COM ',
      password: STRONG_PASSWORD,
      role: 'admin',
    });
    assert.equal(result.isValid, true);
    assert.deepEqual(result.sanitizedInput, {
      name: 'Asha Rao',
      email: 'asha.rao@example.com',
      password: STRONG_PASSWORD,
    });
  });

  it('reports every failing field at once', () => {
    const result = validateRegistrationInput({ name: '', email: 'not-an-email', password: 'short' });
    assert.equal(result.isValid, false);
    assert.deepEqual(fieldsOf(result).sort(), ['email', 'name', 'password']);
  });

  it('rejects operator objects (NoSQL injection) and non-object bodies', () => {
    const injected = validateRegistrationInput({ name: 'Asha', email: { $ne: null }, password: STRONG_PASSWORD });
    assert.deepEqual(fieldsOf(injected), ['email']);
    assert.deepEqual(fieldsOf(validateRegistrationInput([])), ['body']);
    assert.deepEqual(fieldsOf(validateLoginInput(null)), ['body']);
  });
});

describe('validateChangePasswordInput', () => {
  it('rejects reusing the current password', () => {
    const result = validateChangePasswordInput({ currentPassword: STRONG_PASSWORD, newPassword: STRONG_PASSWORD });
    assert.deepEqual(fieldsOf(result), ['newPassword']);
  });
});

describe('validateInvitationInput', () => {
  const today = new Date().toISOString().slice(0, 10);
  const validInvitation = {
    name: 'Kiran Patel',
    email: 'Kiran.Patel@Example.com',
    role: 'customer',
    designation: 'Support Engineer',
    departmentId: '64B000000000000000000001',
    workLocationType: WORK_LOCATION_TYPES.ONSITE,
    dateOfJoining: today,
    employmentStatus: EMPLOYMENT_STATUSES.PROBATION,
  };

  it('accepts a complete invitation and normalises ids and email', () => {
    const result = validateInvitationInput(validInvitation);
    assert.equal(result.isValid, true, JSON.stringify(result.validationErrors));
    assert.equal(result.sanitizedInput.email, 'kiran.patel@example.com');
    assert.equal(result.sanitizedInput.profileDraft.departmentId, '64b000000000000000000001');
    assert.equal(result.sanitizedInput.profileDraft.reportingManagerId, null);
  });

  it('never allows inviting an admin', () => {
    const result = validateInvitationInput({ ...validInvitation, role: 'admin' });
    assert.deepEqual(fieldsOf(result), ['role']);
  });

  it('rejects impossible and far-away joining dates', () => {
    assert.deepEqual(fieldsOf(validateInvitationInput({ ...validInvitation, dateOfJoining: '2026-02-30' })), [
      'dateOfJoining',
    ]);
    assert.deepEqual(fieldsOf(validateInvitationInput({ ...validInvitation, dateOfJoining: '2099-01-01' })), [
      'dateOfJoining',
    ]);
  });

  it('rejects a malformed reporting manager id', () => {
    const result = validateInvitationInput({ ...validInvitation, reportingManagerId: 'not-an-id' });
    assert.deepEqual(fieldsOf(result), ['reportingManagerId']);
  });
});
