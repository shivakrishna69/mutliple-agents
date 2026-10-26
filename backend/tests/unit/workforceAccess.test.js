import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isWorkforceAdmin, WORKFORCE_ADMIN_ROLES } from '../../services/workforceAccess.js';
import { isVaultManagerRole } from '../../services/vaultAccess.js';

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
