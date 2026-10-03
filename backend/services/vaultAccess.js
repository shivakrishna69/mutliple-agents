/**
 * Authorisation rules for the document vault, in one place so every endpoint applies the same ones.
 *
 *   Read (list, download)
 *     - the owner: the signed-in user whose EmployeeProfile is the document's employeeId, or
 *     - a user whose role is listed in the document's accessibleRoles (admin and/or hr).
 *   Upload
 *     - admin or hr: any document type, for any employee, and may choose accessibleRoles;
 *     - the employee themselves: their own Gov_ID only (offer letters and appraisals are issued by
 *       HR, not self-declared), always with the default accessibleRoles.
 *   Verify
 *     - a role listed in accessibleRoles, and never the owner (no self-verification, even for an
 *       HR user verifying their own ID).
 *
 * Ownership is decided by EmployeeProfile.userId matching the session's user id. A document's
 * employeeId is an EmployeeProfile id, never a User id, so the two are never compared directly.
 */

import EmployeeProfile from '../models/EmployeeProfile.js';
import { VAULT_DOCUMENT_TYPES, VAULT_GRANTABLE_ROLES } from '../models/DocumentVault.js';

/** Default readers of a new document when the uploader does not choose. */
export const DEFAULT_ACCESSIBLE_ROLES = Object.freeze([...VAULT_GRANTABLE_ROLES]);

/** Document types an employee may upload about themselves. */
const SELF_UPLOADABLE_DOCUMENT_TYPES = Object.freeze([VAULT_DOCUMENT_TYPES.GOV_ID]);

/** Reasons recorded in audit logs when access is refused. */
export const VAULT_DENIAL_REASONS = Object.freeze({
  NOT_OWNER_AND_ROLE_NOT_GRANTED: 'not_owner_and_role_not_granted',
  ROLE_CANNOT_UPLOAD: 'role_cannot_upload',
  SELF_UPLOAD_TYPE_NOT_ALLOWED: 'self_upload_type_not_allowed',
  ROLE_GRANT_BY_NON_MANAGER: 'role_grant_by_non_manager',
  SELF_VERIFICATION: 'self_verification',
  ROLE_NOT_GRANTED: 'role_not_granted',
});

export function isVaultManagerRole(role) {
  return VAULT_GRANTABLE_ROLES.includes(role);
}

/** The signed-in user's EmployeeProfile id as a string, or null when they have no profile. */
export async function findOwnEmployeeProfileId(userId) {
  const ownProfile = await EmployeeProfile.findOne({ userId }).select('_id').lean();
  return ownProfile ? ownProfile._id.toString() : null;
}

/**
 * Read access to one document.
 * @returns {{ isAllowed: true, grantBasis: 'owner' | 'role' } | { isAllowed: false, denialReason: string }}
 */
export function evaluateDocumentReadAccess({ user, ownEmployeeProfileId, documentRecord }) {
  if (ownEmployeeProfileId && documentRecord.employeeId.toString() === ownEmployeeProfileId) {
    return { isAllowed: true, grantBasis: 'owner' };
  }
  if (documentRecord.accessibleRoles.includes(user.role)) {
    return { isAllowed: true, grantBasis: 'role' };
  }
  return { isAllowed: false, denialReason: VAULT_DENIAL_REASONS.NOT_OWNER_AND_ROLE_NOT_GRANTED };
}

/** Upload permission for one target employee and document type. */
export function evaluateUploadAccess({ user, isOwnProfile, documentType, requestedAccessibleRoles }) {
  if (isVaultManagerRole(user.role)) return { isAllowed: true };
  if (!isOwnProfile) return { isAllowed: false, denialReason: VAULT_DENIAL_REASONS.ROLE_CANNOT_UPLOAD };
  if (!SELF_UPLOADABLE_DOCUMENT_TYPES.includes(documentType)) {
    return { isAllowed: false, denialReason: VAULT_DENIAL_REASONS.SELF_UPLOAD_TYPE_NOT_ALLOWED };
  }
  if (requestedAccessibleRoles) return { isAllowed: false, denialReason: VAULT_DENIAL_REASONS.ROLE_GRANT_BY_NON_MANAGER };
  return { isAllowed: true };
}

/** Verification permission for one document. */
export function evaluateVerifyAccess({ user, ownEmployeeProfileId, documentRecord }) {
  if (ownEmployeeProfileId && documentRecord.employeeId.toString() === ownEmployeeProfileId) {
    return { isAllowed: false, denialReason: VAULT_DENIAL_REASONS.SELF_VERIFICATION };
  }
  if (!documentRecord.accessibleRoles.includes(user.role)) {
    return { isAllowed: false, denialReason: VAULT_DENIAL_REASONS.ROLE_NOT_GRANTED };
  }
  return { isAllowed: true };
}
