/**
 * Whose people and departments an NSK user may look at (the people tools, peopleTools.js).
 *
 *   organisation   roles with RUN_PEOPLE_LOOKUP (admin, HR, finance, IT administrator): everyone
 *                  still employed, every active department
 *   departments    a department head without that capability: the active departments they head
 *                  (Department.departmentHeadId is their employee record) and the people in them;
 *                  not the units under them, as for the knowledge bases they manage
 *   null           anyone else: no people tools
 *
 * Headship is read from the database on every call, so a new head can look at once and a former
 * head no longer can.
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';
import Department from '../../models/Department.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';

export const PEOPLE_SCOPES = Object.freeze({ ORGANISATION: 'organisation', DEPARTMENTS: 'departments' });

/** The ids of the active departments this account's employee record heads (none without one). */
export async function headedDepartmentIdsOf(userId) {
  const profile = await EmployeeProfile.findOne({ userId }).select('_id').lean();
  if (!profile) return [];
  const departments = await Department.find({ departmentHeadId: profile._id, isActive: { $ne: false } })
    .select('_id')
    .lean();
  return departments.map((department) => department._id.toString());
}

/**
 * @param {{ role: string, headedDepartmentIds: string[] }} actor
 * @returns {{ kind: string, departmentIds?: string[] }|null}
 */
export function peopleScopeOf(actor) {
  if (hasCapability(actor.role, CAPABILITIES.RUN_PEOPLE_LOOKUP)) return { kind: PEOPLE_SCOPES.ORGANISATION };
  if (actor.headedDepartmentIds.length > 0 && hasCapability(actor.role, CAPABILITIES.USE_NSK_ASSISTANT)) {
    return { kind: PEOPLE_SCOPES.DEPARTMENTS, departmentIds: actor.headedDepartmentIds };
  }
  return null;
}

/** True when `scope` covers `departmentId`. */
export function scopeCoversDepartment(scope, departmentId) {
  if (!scope || !departmentId) return false;
  return scope.kind === PEOPLE_SCOPES.ORGANISATION || scope.departmentIds.includes(departmentId.toString());
}
