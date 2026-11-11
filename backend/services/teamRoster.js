/**
 * The people a viewer may see in team views (the Today board, live presence, daily activity), with
 * what those views show about each of them: name, employee ID, job title, department and office.
 *
 * Who appears: HR and administrators see everyone (optionally one department); anyone else sees the
 * people who report to them, and is refused when nobody does. Invited people who have not joined
 * yet (account not active), people whose joining date is later, and former employees are left out.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import Department from '../models/Department.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import User, { ACCOUNT_STATUSES } from '../models/User.js';
import { calendarDateOfUtcInstant } from '../utils/calendarDates.js';
import { readOfficeLocalClock } from './attendancePolicy.js';
import { getCompanySettings } from './companySettings.js';
import { ServiceError } from './serviceError.js';
import { isWorkforceAdmin } from './workforceAccess.js';

export const TEAM_SCOPES = Object.freeze({ ORGANISATION: 'organisation', DIRECT_REPORTS: 'direct_reports' });

/** Everyone still employed: the roster filter for organisation-wide work such as nightly jobs. */
export const CURRENT_EMPLOYEES = Object.freeze({
  'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
});

const toIdString = (id) => id?.toString() ?? null;

/**
 * Which profiles the viewer may see.
 * @param {{ id: string, role: string }} viewer
 * @param {{ departmentId?: string|null, forbidden: { code: string, message: string } }} options
 *   `forbidden` is the refusal for someone without a team (each view words it its own way).
 * @returns {Promise<{ scope: string, filter: object }>}
 * @throws {ServiceError} 403 with `forbidden`
 */
export async function resolveTeamScope(viewer, { departmentId = null, forbidden }) {
  if (isWorkforceAdmin(viewer.role)) {
    return {
      scope: TEAM_SCOPES.ORGANISATION,
      filter: departmentId
        ? { ...CURRENT_EMPLOYEES, 'organizationData.departmentId': departmentId }
        : CURRENT_EMPLOYEES,
    };
  }
  const ownProfile = await EmployeeProfile.findOne({ userId: viewer.id }).select('_id').lean();
  const reportsFilter = ownProfile && { ...CURRENT_EMPLOYEES, 'organizationData.reportingManagerId': ownProfile._id };
  if (!reportsFilter || !(await EmployeeProfile.exists(reportsFilter))) {
    throw new ServiceError(HTTP_STATUS.FORBIDDEN, forbidden.code, forbidden.message);
  }
  return { scope: TEAM_SCOPES.DIRECT_REPORTS, filter: reportsFilter };
}

/**
 * The people matching `filter` who have joined, sorted by name.
 * @param {{ filter: object, now?: Date }} request
 * @returns {Promise<{ people: object[], officesById: Map<string, object>, companyTimeZone: string }>}
 *   Each person: { employeeId, userId, employeeCode, name, designation, department, officeId, office,
 *   reportingManagerId, joinedOn (calendar date) }; `office` is the lean office document (name, timeZone, workday) or null.
 */
export async function loadTeamRoster({ filter, now = new Date() }) {
  const profiles = await EmployeeProfile.find({ ...filter, 'organizationData.dateOfJoining': { $lte: now } })
    .select(
      'userId employeeCode organizationData.designation organizationData.departmentId ' +
        'organizationData.officeLocationId organizationData.reportingManagerId organizationData.dateOfJoining',
    )
    .lean();
  const accounts = await User.find({
    _id: { $in: profiles.map((profile) => profile.userId) },
    status: ACCOUNT_STATUSES.ACTIVE,
  })
    .select('name')
    .lean();
  const nameByUserId = new Map(accounts.map((account) => [account._id.toString(), account.name]));
  const joined = profiles.filter((profile) => nameByUserId.has(profile.userId.toString()));

  const officeIds = [...new Set(joined.map((profile) => toIdString(profile.organizationData.officeLocationId)))];
  const departmentIds = [...new Set(joined.map((profile) => toIdString(profile.organizationData.departmentId)))];
  const [offices, departments, companySettings] = await Promise.all([
    OfficeLocation.find({ _id: { $in: officeIds.filter(Boolean) } })
      .select('name timeZone workday')
      .lean(),
    Department.find({ _id: { $in: departmentIds.filter(Boolean) } })
      .select('name')
      .lean(),
    getCompanySettings(),
  ]);
  const officesById = new Map(offices.map((office) => [office._id.toString(), office]));
  const departmentNameById = new Map(departments.map((department) => [department._id.toString(), department.name]));

  const people = joined
    .map((profile) => {
      const officeId = toIdString(profile.organizationData.officeLocationId);
      const departmentId = toIdString(profile.organizationData.departmentId);
      return {
        employeeId: profile._id.toString(),
        userId: profile.userId.toString(),
        employeeCode: profile.employeeCode ?? null,
        name: nameByUserId.get(profile.userId.toString()),
        designation: profile.organizationData.designation,
        department: departmentId ? { id: departmentId, name: departmentNameById.get(departmentId) ?? null } : null,
        officeId: officesById.has(officeId) ? officeId : null,
        office: officesById.get(officeId) ?? null,
        reportingManagerId: toIdString(profile.organizationData.reportingManagerId),
        joinedOn: profile.organizationData.dateOfJoining
          ? calendarDateOfUtcInstant(profile.organizationData.dateOfJoining)
          : null,
      };
    })
    .sort((first, second) => first.name.localeCompare(second.name));
  return { people, officesById, companyTimeZone: companySettings.timeZone };
}

/** The person's calendar date at `now`, in their office's time zone or else the company's. */
export function localDateOf(person, companyTimeZone, now) {
  return readOfficeLocalClock(now, person.office?.timeZone ?? companyTimeZone).calendarDate;
}

/** What team views show about a person, without the internal fields. */
export function toPersonView(person) {
  return {
    employeeId: person.employeeId,
    employeeCode: person.employeeCode,
    name: person.name,
    designation: person.designation,
    department: person.department,
    office: person.office ? { id: person.officeId, name: person.office.name } : null,
  };
}
