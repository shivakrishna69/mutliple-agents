/**
 * Who may ask a department's agent: one rule for listing the agents a person can ask and for every
 * question they send.
 *
 *   effective audience   the agent's own setting (DepartmentAgent.audience), or, when it follows
 *                        the department, COMPANY for a shared service (Department.isSharedService)
 *                        and DEPARTMENT otherwise
 *   COMPANY              anyone with an employee record that has not ended (full-time, contractor
 *                        or intern alike)
 *   DEPARTMENT           people in the department or in a unit under it (Data Engineering's agent
 *                        answers its sub-teams too)
 *   always               whoever manages the knowledge base (its head, its knowledge lead,
 *                        administrators), so they can try their own agent, with or without a record
 */

import { AGENT_AUDIENCES } from '../../constants/validation.js';
import Department from '../../models/Department.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';

// Far deeper than any real organisation chart; stops the walk if the data ever held a loop.
const MAX_DEPARTMENT_DEPTH = 50;

/** COMPANY or DEPARTMENT: the agent's audience once the department's shared-service switch is applied. */
export function effectiveAudienceOf(department, agent) {
  if (agent.audience === AGENT_AUDIENCES.COMPANY || agent.audience === AGENT_AUDIENCES.DEPARTMENT) {
    return agent.audience;
  }
  return department.isSharedService ? AGENT_AUDIENCES.COMPANY : AGENT_AUDIENCES.DEPARTMENT;
}

/**
 * The asker's employee record and the departments they belong to: their own and every unit above
 * it. `profile` is null when they have no record, or when it has ended.
 * @returns {Promise<{ profile: object|null, departmentIds: Set<string> }>}
 */
export async function loadAskerMembership(userId) {
  const profile = await EmployeeProfile.findOne({ userId })
    .select('_id organizationData.departmentId organizationData.employmentStatus')
    .lean();
  if (!profile || profile.organizationData?.employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) {
    return { profile: null, departmentIds: new Set() };
  }
  const departmentIds = new Set();
  let currentId = profile.organizationData?.departmentId ?? null;
  for (let depth = 0; currentId && depth < MAX_DEPARTMENT_DEPTH; depth += 1) {
    const key = currentId.toString();
    if (departmentIds.has(key)) break;
    departmentIds.add(key);
    const current = await Department.findById(currentId).select('parentDepartmentId').lean();
    currentId = current?.parentDepartmentId ?? null;
  }
  return { profile, departmentIds };
}

/**
 * Why this person may not ask this agent, or null when they may.
 * @param {{ department: object, agent: object, membership: { profile: object|null, departmentIds: Set<string> },
 *   managesKnowledgeBase: boolean }} facts
 * @returns {null|'NO_EMPLOYEE_PROFILE'|'ASK_DENIED'}
 */
export function askRefusalReason({ department, agent, membership, managesKnowledgeBase }) {
  if (managesKnowledgeBase) return null;
  if (!membership.profile) return 'NO_EMPLOYEE_PROFILE';
  if (effectiveAudienceOf(department, agent) === AGENT_AUDIENCES.COMPANY) return null;
  return membership.departmentIds.has(department._id.toString()) ? null : 'ASK_DENIED';
}
