/**
 * Shared access rules for HR features: which roles act on HR data for the whole organisation, and
 * how a signed-in user's own employee profile is found. People, payroll, analytics, attendance
 * reviews, OKRs, the document vault and leave all use these, so each rule is defined once.
 *
 * Feature-specific rules stay with their feature (for example, who may invite whom lives in
 * services/invitationService.js), and data lists that happen to contain the same roles, such as the
 * roles a vault document may be shared with (models/DocumentVault.js), are not permission checks.
 */

import { CAPABILITIES, ROLE_CAPABILITIES, hasCapability } from '../constants/accessRoles.js';
import EmployeeProfile from '../models/EmployeeProfile.js';

/**
 * Roles with organisation-wide access to HR data and operations: those with MANAGE_WORKFORCE
 * (constants/accessRoles.js). The browser learns its own capabilities from the signed-in user.
 */
export const WORKFORCE_ADMIN_ROLES = Object.freeze(
  Object.keys(ROLE_CAPABILITIES).filter((role) => hasCapability(role, CAPABILITIES.MANAGE_WORKFORCE)),
);

export function isWorkforceAdmin(role) {
  return hasCapability(role, CAPABILITIES.MANAGE_WORKFORCE);
}

/** The signed-in user's EmployeeProfile id as a string, or null when they have no profile. */
export async function findOwnEmployeeProfileId(userId) {
  const ownProfile = await EmployeeProfile.findOne({ userId }).select('_id').lean();
  return ownProfile ? ownProfile._id.toString() : null;
}
