/**
 * Loads a user's employment record from MongoDB in the shape the ai-service expects as
 * EmployeeContext (ai-service app/schemas.py): the EmployeeProfile linked to the account, its
 * OfficeLocation (time zone and shift), and the display name from User.
 *
 * Used by every path that can reach the attendance regularization agent:
 *   - POST /api/attendance/regularize (the dedicated endpoint), and
 *   - the support chat (webhookController), so the supervisor can route an attendance question to
 *     the agent with the customer's real employment context.
 * The context is built from the authenticated user id only; nothing in it comes from the request.
 */

import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import User from '../models/User.js';

/** Why no context could be built. */
export const EMPLOYEE_CONTEXT_UNAVAILABLE = Object.freeze({
  NO_PROFILE: 'no_profile',
  EMPLOYMENT_ENDED: 'employment_ended',
  OFFICE_NOT_CONFIGURED: 'office_not_configured',
});

/**
 * @param {string} userId  The authenticated user's id.
 * @returns {Promise<{ isAvailable: true, employeeContext: object, employeeProfile: object, office: object }
 *                 | { isAvailable: false, unavailableReason: string }>}
 */
export async function loadEmployeeAgentContext(userId) {
  const employeeProfile = await EmployeeProfile.findOne({ userId })
    .select('userId organizationData +biometricMetadata.allowedGeofenceRadius')
    .lean();
  if (!employeeProfile) return { isAvailable: false, unavailableReason: EMPLOYEE_CONTEXT_UNAVAILABLE.NO_PROFILE };

  const { employmentStatus, officeLocationId, reportingManagerId } = employeeProfile.organizationData;
  if (employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) {
    return { isAvailable: false, unavailableReason: EMPLOYEE_CONTEXT_UNAVAILABLE.EMPLOYMENT_ENDED };
  }

  const [office, account] = await Promise.all([
    officeLocationId ? OfficeLocation.findById(officeLocationId).lean() : null,
    User.findById(employeeProfile.userId).select('name').lean(),
  ]);
  if (!office || !office.workday?.shiftEndLocalTime) {
    return { isAvailable: false, unavailableReason: EMPLOYEE_CONTEXT_UNAVAILABLE.OFFICE_NOT_CONFIGURED };
  }

  return {
    isAvailable: true,
    employeeProfile,
    office,
    employeeContext: {
      employee_id: employeeProfile._id.toString(),
      display_name: account?.name ?? 'Employee',
      time_zone: office.timeZone,
      shift_start_time: office.workday.shiftStartLocalTime,
      shift_end_time: office.workday.shiftEndLocalTime,
      manager_id: reportingManagerId ? reportingManagerId.toString() : null,
      allowed_geofence_radius: employeeProfile.biometricMetadata?.allowedGeofenceRadius ?? null,
    },
  };
}
