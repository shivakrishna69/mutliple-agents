import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canUserAccessConversation, isStaffRole } from '../../services/conversationAccess.js';

const CUSTOMER_ID = '64b000000000000000000001';
const AGENT_ID = '64b000000000000000000002';
const OTHER_AGENT_ID = '64b000000000000000000003';

const customer = { id: CUSTOMER_ID, role: 'customer' };
const agent = { id: AGENT_ID, role: 'agent' };

describe('canUserAccessConversation', () => {
  it('lets admins see every conversation', () => {
    assert.equal(canUserAccessConversation({ id: 'x', role: 'admin' }, { customerId: CUSTOMER_ID }), true);
  });

  it('lets customers see only their own conversations', () => {
    assert.equal(canUserAccessConversation(customer, { customerId: CUSTOMER_ID }), true);
    assert.equal(canUserAccessConversation(customer, { customerId: OTHER_AGENT_ID }), false);
    assert.equal(canUserAccessConversation(customer, { customerId: null }), false);
  });

  it('lets an agent see conversations assigned to them, including ObjectId-like values', () => {
    const objectIdLike = { toString: () => AGENT_ID };
    assert.equal(canUserAccessConversation(agent, { assignedAgentId: AGENT_ID, status: 'ai-handling' }), true);
    assert.equal(canUserAccessConversation(agent, { assignedAgentId: objectIdLike, status: 'ai-handling' }), true);
  });

  it('lets an agent read the unassigned human queue but not other agents’ conversations', () => {
    assert.equal(canUserAccessConversation(agent, { assignedAgentId: null, status: 'escalated-to-human' }), true);
    assert.equal(canUserAccessConversation(agent, { assignedAgentId: null, status: 'ai-handling' }), false);
    assert.equal(
      canUserAccessConversation(agent, { assignedAgentId: OTHER_AGENT_ID, status: 'escalated-to-human' }),
      false,
    );
  });

  it('denies roles without conversation access', () => {
    assert.equal(canUserAccessConversation({ id: CUSTOMER_ID, role: 'hr' }, { customerId: CUSTOMER_ID }), false);
  });
});

describe('isStaffRole', () => {
  it('treats admins and agents as staff only', () => {
    assert.equal(isStaffRole('admin'), true);
    assert.equal(isStaffRole('agent'), true);
    assert.equal(isStaffRole('hr'), false);
    assert.equal(isStaffRole('customer'), false);
  });
});
