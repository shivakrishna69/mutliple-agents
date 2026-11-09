/**
 * Who may manage a department's knowledge base: one rule, used by every knowledge base endpoint
 * (middleware/departmentKnowledgeScope.js).
 *
 *   administrator           any department (MANAGE_KNOWLEDGE_BASES); may also choose the department's knowledge lead
 *   department head         their own department (Department.departmentHeadId is their employee
 *                           profile); may also choose the knowledge lead
 *   knowledge lead          the department whose agent names them (DepartmentAgent.managedBy)
 *   anyone else             refused, HR included: department knowledge is kept to the department
 *
 * decideKnowledgeAccess(...) → { canManage, canAssignLead, basis }, where basis names the rule that
 * allowed it (for the audit log), or is null when refused.
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';

export const KNOWLEDGE_ACCESS_BASIS = Object.freeze({
  ADMIN: 'admin',
  DEPARTMENT_HEAD: 'department_head',
  KNOWLEDGE_LEAD: 'knowledge_lead',
});

const sameId = (left, right) => Boolean(left) && Boolean(right) && left.toString() === right.toString();

/**
 * @param {{ role: string, userId: string, ownProfileId: string|null,
 *   departmentHeadId: object|string|null, managedBy: object|string|null }} facts
 */
export function decideKnowledgeAccess({ role, userId, ownProfileId, departmentHeadId, managedBy }) {
  if (hasCapability(role, CAPABILITIES.MANAGE_KNOWLEDGE_BASES))
    return { canManage: true, canAssignLead: true, basis: KNOWLEDGE_ACCESS_BASIS.ADMIN };
  if (sameId(ownProfileId, departmentHeadId)) {
    return { canManage: true, canAssignLead: true, basis: KNOWLEDGE_ACCESS_BASIS.DEPARTMENT_HEAD };
  }
  if (sameId(userId, managedBy)) {
    return { canManage: true, canAssignLead: false, basis: KNOWLEDGE_ACCESS_BASIS.KNOWLEDGE_LEAD };
  }
  return { canManage: false, canAssignLead: false, basis: null };
}
