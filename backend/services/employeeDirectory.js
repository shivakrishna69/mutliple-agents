/**
 * The current employees (everyone not terminated), as HR pickers show them: the invitation form's
 * manager list, and the workplace and leave screens. Permission checks are made by the caller.
 */

import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import User from '../models/User.js';

const toIdString = (id) => id?.toString() ?? null;

/**
 * @returns {Promise<{ employeeId: string, name: string, email: string|null, designation: string,
 *   departmentId: string|null, officeLocationId: string|null, reportingManagerId: string|null,
 *   employmentStatus: string }[]>} sorted by name
 */
export async function listCurrentEmployees() {
  const profiles = await EmployeeProfile.find({
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
  })
    .select(
      'userId organizationData.designation organizationData.departmentId organizationData.officeLocationId ' +
        'organizationData.reportingManagerId organizationData.employmentStatus',
    )
    .lean();
  const accounts = await User.find({ _id: { $in: profiles.map((profile) => profile.userId) } })
    .select('name email')
    .lean();
  const accountByUserId = new Map(accounts.map((account) => [account._id.toString(), account]));
  return profiles
    .map((profile) => {
      const account = accountByUserId.get(profile.userId.toString());
      const organization = profile.organizationData;
      return {
        employeeId: profile._id.toString(),
        name: account?.name ?? 'Unnamed',
        email: account?.email ?? null,
        designation: organization.designation,
        departmentId: toIdString(organization.departmentId),
        officeLocationId: toIdString(organization.officeLocationId),
        reportingManagerId: toIdString(organization.reportingManagerId),
        employmentStatus: organization.employmentStatus,
      };
    })
    .sort((first, second) => first.name.localeCompare(second.name));
}
