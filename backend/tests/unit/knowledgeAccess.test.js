/**
 * Who may manage a department's knowledge base (services/knowledge/knowledgeAccess.js), and the
 * shape of a settings change (validators/knowledgeValidators.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KNOWLEDGE_ACCESS_BASIS, decideKnowledgeAccess } from '../../services/knowledge/knowledgeAccess.js';
import { documentIdErrors, validateKnowledgeSettingsChanges } from '../../validators/knowledgeValidators.js';

const HEAD_PROFILE = '65f1a2b3c4d5e6f708192a01';
const LEAD_USER = '65f1a2b3c4d5e6f708192a02';
const OTHER_USER = '65f1a2b3c4d5e6f708192a03';
const department = { departmentHeadId: HEAD_PROFILE, managedBy: LEAD_USER };

describe('decideKnowledgeAccess', () => {
  it('lets an administrator manage any department and choose its lead', () => {
    assert.deepEqual(decideKnowledgeAccess({ ...department, role: 'admin', userId: OTHER_USER, ownProfileId: null }), {
      canManage: true,
      canAssignLead: true,
      basis: KNOWLEDGE_ACCESS_BASIS.ADMIN,
    });
  });

  it('lets the head manage their department and choose its lead, whatever their role', () => {
    for (const role of ['customer', 'hr', 'agent']) {
      assert.deepEqual(decideKnowledgeAccess({ ...department, role, userId: OTHER_USER, ownProfileId: HEAD_PROFILE }), {
        canManage: true,
        canAssignLead: true,
        basis: KNOWLEDGE_ACCESS_BASIS.DEPARTMENT_HEAD,
      });
    }
  });

  it('lets the lead manage the knowledge base but not choose the lead', () => {
    assert.deepEqual(
      decideKnowledgeAccess({ ...department, role: 'customer', userId: LEAD_USER, ownProfileId: null }),
      {
        canManage: true,
        canAssignLead: false,
        basis: KNOWLEDGE_ACCESS_BASIS.KNOWLEDGE_LEAD,
      },
    );
  });

  it('refuses everyone else, HR included, and a department with no head or lead', () => {
    for (const role of ['customer', 'hr', 'agent']) {
      assert.equal(
        decideKnowledgeAccess({ ...department, role, userId: OTHER_USER, ownProfileId: '65f1a2b3c4d5e6f708192aff' })
          .canManage,
        false,
        role,
      );
    }
    assert.equal(
      decideKnowledgeAccess({
        role: 'customer',
        userId: OTHER_USER,
        ownProfileId: null,
        departmentHeadId: null,
        managedBy: null,
      }).canManage,
      false,
      'no profile and no head never match',
    );
  });
});

describe('validateKnowledgeSettingsChanges', () => {
  it('takes the known settings and the version', () => {
    const result = validateKnowledgeSettingsChanges({
      systemPrompt: 'Be brief.',
      status: 'PAUSED',
      managedBy: null,
      version: 3,
    });
    assert.deepEqual(result, {
      isValid: true,
      sanitizedInput: { changes: { systemPrompt: 'Be brief.', status: 'PAUSED', managedBy: null }, version: 3 },
    });
  });

  it('refuses unknown fields, wrong types, unknown statuses, bad ids, no changes and no version', () => {
    const fieldsOf = (body) =>
      validateKnowledgeSettingsChanges(body)
        .validationErrors.map((error) => error.field)
        .sort();
    assert.deepEqual(fieldsOf({ departmentId: 'x', version: 1 }), ['body', 'departmentId']);
    assert.deepEqual(fieldsOf({ name: 5, version: 1 }), ['name']);
    assert.deepEqual(fieldsOf({ systemPrompt: { $ne: '' }, version: 1 }), ['systemPrompt']);
    assert.deepEqual(fieldsOf({ status: 'DELETED', version: 1 }), ['status']);
    assert.deepEqual(fieldsOf({ managedBy: 'someone', version: 1 }), ['managedBy']);
    assert.deepEqual(fieldsOf({ name: 'Agent' }), ['version']);
    assert.deepEqual(fieldsOf([]), ['body']);
  });

  it('checks the document id parameter', () => {
    assert.equal(documentIdErrors({ docId: '65f1a2b3c4d5e6f708192a3b' }), null);
    assert.deepEqual(documentIdErrors({ docId: '../x' }), [{ field: 'docId', message: 'must be an id' }]);
  });
});
