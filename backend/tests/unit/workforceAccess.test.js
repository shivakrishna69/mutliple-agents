import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isWorkforceAdmin, WORKFORCE_ADMIN_ROLES } from '../../services/workforceAccess.js';
import { evaluateUploadAccess, isVaultManagerRole, VAULT_DENIAL_REASONS } from '../../services/vaultAccess.js';

describe('isWorkforceAdmin', () => {
  it('grants organisation-wide HR access to admins and HR only', () => {
    assert.deepEqual([...WORKFORCE_ADMIN_ROLES].sort(), ['admin', 'hr']);
    assert.equal(isWorkforceAdmin('admin'), true);
    assert.equal(isWorkforceAdmin('hr'), true);
    assert.equal(isWorkforceAdmin('agent'), false);
    assert.equal(isWorkforceAdmin('customer'), false);
    assert.equal(isWorkforceAdmin(undefined), false);
  });

  it('is the rule the document vault uses for managing other employees’ documents', () => {
    for (const role of ['admin', 'hr', 'agent', 'customer'])
      assert.equal(isVaultManagerRole(role), isWorkforceAdmin(role));
  });
});

describe('evaluateUploadAccess', () => {
  const employee = { role: 'customer' };

  it('lets employees upload their own ID and leave documents, and nothing HR issues', () => {
    for (const documentType of ['Gov_ID', 'Leave_Document']) {
      assert.deepEqual(evaluateUploadAccess({ user: employee, isOwnProfile: true, documentType }), { isAllowed: true });
    }
    for (const documentType of ['Offer_Letter', 'Appraisal_Doc']) {
      assert.equal(
        evaluateUploadAccess({ user: employee, isOwnProfile: true, documentType }).denialReason,
        VAULT_DENIAL_REASONS.SELF_UPLOAD_TYPE_NOT_ALLOWED,
      );
    }
    assert.equal(
      evaluateUploadAccess({ user: employee, isOwnProfile: false, documentType: 'Leave_Document' }).denialReason,
      VAULT_DENIAL_REASONS.ROLE_CANNOT_UPLOAD,
    );
  });
});
