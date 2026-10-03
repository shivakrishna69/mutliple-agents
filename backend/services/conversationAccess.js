/**
 * Who may see a conversation. One rule set for every channel (Socket.IO rooms today, HTTP
 * conversation routes later), so access cannot differ between them.
 *
 *   admin     every conversation.
 *   customer  only conversations they own (customerId). Ownership never changes: customerId
 *             is immutable on the model.
 *   agent     conversations assigned to them, plus conversations waiting in the human queue
 *             (escalated-to-human with no assignee) so they can read the thread before
 *             claiming it. An agent loses access when another agent claims the conversation.
 */

import { ROLES } from '../models/User.js';
import { CONVERSATION_STATUS } from '../models/Conversation.js';

/** Roles that work conversations rather than own them. */
export const STAFF_ROLES = Object.freeze([ROLES.ADMIN, ROLES.AGENT]);

export function isStaffRole(role) {
  return STAFF_ROLES.includes(role);
}

/**
 * @param {{ id: string, role: string }} user  Public profile (req.user / socket.data.user).
 * @param {{ customerId: unknown, assignedAgentId: unknown, status: string }} conversationAccessFields
 *   A Conversation document, lean record, or status payload; ids may be ObjectIds or strings.
 */
export function canUserAccessConversation(user, { customerId, assignedAgentId, status }) {
  if (user.role === ROLES.ADMIN) return true;

  if (user.role === ROLES.CUSTOMER) {
    return customerId != null && String(customerId) === user.id;
  }

  if (user.role === ROLES.AGENT) {
    if (assignedAgentId != null) return String(assignedAgentId) === user.id;
    return status === CONVERSATION_STATUS.ESCALATED_TO_HUMAN;
  }

  return false;
}
