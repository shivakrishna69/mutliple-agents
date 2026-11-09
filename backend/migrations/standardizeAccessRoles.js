/**
 * Access roles as constants/accessRoles.js defines them:
 *
 *   - "customer" becomes "employee" (its new name) on accounts, pending invitations, offer drafts and
 *     the rows of imports not yet run, so nothing written before the rename is left behind.
 *   - A role stored in another case ("ADMIN", "Hr") becomes the lowercase value it spells: written by
 *     hand in the database, it matched no check and left the account with no access at all.
 *   - Employee records without a job level or employment type get the defaults.
 *
 * Writes go to the collections directly, since documents holding an old value would not pass the
 * models' validation. Running it again changes nothing.
 */

import { DEFAULT_EMPLOYMENT_TYPE, DEFAULT_JOB_LEVEL, ROLES } from '../constants/accessRoles.js';
import EmployeeImportJob from '../models/EmployeeImportJob.js';
import EmployeeInvitation from '../models/EmployeeInvitation.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import OnboardingDraft from '../models/OnboardingDraft.js';
import User from '../models/User.js';

const RENAMED_ROLE = 'customer';

/** Matches a stored value spelling `role` in any other case (role values are lowercase letters and "_"). */
const otherCaseOf = (role) => ({ $regex: `^${role}$`, $options: 'i', $ne: role });

export default Object.freeze({
  name: 'standardize-access-roles',
  async run() {
    const results = await Promise.all([
      User.collection.updateMany(
        { role: { $regex: `^${RENAMED_ROLE}$`, $options: 'i' } },
        { $set: { role: ROLES.EMPLOYEE } },
      ),
      ...Object.values(ROLES).map((role) =>
        User.collection.updateMany({ role: otherCaseOf(role) }, { $set: { role } }),
      ),
      EmployeeInvitation.collection.updateMany({ role: RENAMED_ROLE }, { $set: { role: ROLES.EMPLOYEE } }),
      OnboardingDraft.collection.updateMany(
        { 'position.role': RENAMED_ROLE },
        { $set: { 'position.role': ROLES.EMPLOYEE } },
      ),
      EmployeeImportJob.collection.updateMany(
        { 'rows.input.role': RENAMED_ROLE },
        { $set: { 'rows.$[row].input.role': ROLES.EMPLOYEE } },
        { arrayFilters: [{ 'row.input.role': RENAMED_ROLE }] },
      ),
      EmployeeProfile.collection.updateMany(
        { 'organizationData.jobLevel': { $exists: false } },
        { $set: { 'organizationData.jobLevel': DEFAULT_JOB_LEVEL } },
      ),
      EmployeeProfile.collection.updateMany(
        { 'organizationData.employmentType': { $exists: false } },
        { $set: { 'organizationData.employmentType': DEFAULT_EMPLOYMENT_TYPE } },
      ),
    ]);
    return { changedCount: results.reduce((total, result) => total + result.modifiedCount, 0) };
  },
});
