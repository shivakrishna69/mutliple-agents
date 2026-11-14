/**
 * Checks the rows of an employee CSV (services/employeeImportParser.js) before anything is created,
 * so HR sees every problem at once and imports only rows that will work:
 *
 *   each row      name, emails, department code, designation, role (one the importer may give),
 *                 joining date, work type, employment status
 *   the file      the same personal or company email twice; managers in the file whose own row
 *                 has problems; people who manage each other in a circle
 *   the database  emails that already have an account or an open invitation; company addresses
 *                 taken; departments (inactive ones refused, unknown ones created by the import);
 *                 managers (a current employee, or someone in the same file); offices
 *
 * A row's manager may be in the same file: the import creates managers before their teams.
 */

import { EMAIL_PATTERN, DEPARTMENT_CODE_PATTERN, EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import Department from '../models/Department.js';
import { IMPORT_ROW_STATUSES } from '../models/EmployeeImportJob.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import {
  DEFAULT_EMPLOYMENT_TYPE,
  DEFAULT_JOB_LEVEL,
  EMPLOYMENT_TYPE_DEFINITIONS,
  INVITABLE_ROLES,
  JOB_LEVEL_DEFINITIONS,
} from '../constants/accessRoles.js';
import User, { ACCOUNT_STATUSES } from '../models/User.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';
import { invitableRolesFor } from './invitationService.js';

/** A cell matching a definition's value or label, ignoring case, spaces and hyphens; null when none. */
export function choiceOf(cellText, definitions) {
  const normalize = (text) => text.toLowerCase().replace(/[\s-]+/g, '_');
  const wanted = normalize(cellText);
  return (
    definitions.find((definition) => [definition.value, definition.label].map(normalize).includes(wanted))?.value ??
    null
  );
}

/** The role column's words: the stored role values (constants/accessRoles.js INVITABLE_ROLES). Empty means employee. */
export const IMPORT_ROLE_VALUES = Object.freeze(Object.fromEntries(INVITABLE_ROLES.map((role) => [role, role])));
const IMPORTABLE_EMPLOYMENT_STATUSES = Object.freeze([EMPLOYMENT_STATUSES.PROBATION, EMPLOYMENT_STATUSES.ACTIVE]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Each personal email's row: the first one with it, since later rows with the same email are the
 * ones flagged as repeats.
 */
export function firstRowByEmail(rows) {
  const rowByEmail = new Map();
  for (const row of rows) if (!rowByEmail.has(row.input.personalEmail)) rowByEmail.set(row.input.personalEmail, row);
  return rowByEmail;
}

/** "onsite" / "ONSITE" -> "Onsite"; null when it is none of the allowed values. */
export const matchChoice = (value, choices) =>
  choices.find((choice) => choice.toLowerCase() === value.toLowerCase()) ?? null;

function isAllowedJoiningDate(calendarDate, now) {
  if (!isRealCalendarDate(calendarDate) || calendarDate < EMPLOYEE_IMPORT_LIMITS.EARLIEST_JOINING_DATE) return false;
  const latest = new Date(now.getTime() + EMPLOYEE_IMPORT_LIMITS.MAX_JOINING_DAYS_AHEAD * DAY_MS);
  return calendarDate <= latest.toISOString().slice(0, 10);
}

/** One row on its own: the cleaned input and its issues. */
function checkRow(values, { allowedRoles, now }) {
  const issues = [];
  const issue = (field, message) => issues.push({ field, message });
  const cell = (column) => (values[column] ?? '').trim();
  const { NAME_MIN_LENGTH, NAME_MAX_LENGTH, DESIGNATION_MIN_LENGTH, DESIGNATION_MAX_LENGTH } = EMPLOYEE_IMPORT_LIMITS;

  const name = cell('name');
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH)
    issue('name', `must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters`);
  const personalEmail = cell('personal_email').toLowerCase();
  if (!EMAIL_PATTERN.test(personalEmail)) issue('personal_email', 'must be an email address');
  const companyEmail = cell('company_email').toLowerCase() || null;
  if (companyEmail && !EMAIL_PATTERN.test(companyEmail)) issue('company_email', 'must be an email address, or empty');
  const departmentCode = cell('department_code').toUpperCase();
  if (!DEPARTMENT_CODE_PATTERN.test(departmentCode))
    issue('department_code', 'must be 2-20 letters, digits, "-" or "_"');
  const designation = cell('designation');
  if (designation.length < DESIGNATION_MIN_LENGTH || designation.length > DESIGNATION_MAX_LENGTH)
    issue('designation', `must be ${DESIGNATION_MIN_LENGTH}-${DESIGNATION_MAX_LENGTH} characters`);

  const roleWord = cell('role').toLowerCase() || 'employee';
  const role = IMPORT_ROLE_VALUES[roleWord] ?? null;
  if (!role) issue('role', `must be ${Object.keys(IMPORT_ROLE_VALUES).join(', ')} (or empty for employee)`);
  else if (!allowedRoles.includes(role)) issue('role', `you cannot add someone as ${roleWord}`);

  const managerEmail = cell('manager_email').toLowerCase() || null;
  if (managerEmail && !EMAIL_PATTERN.test(managerEmail)) issue('manager_email', 'must be an email address, or empty');
  if (managerEmail && managerEmail === personalEmail) issue('manager_email', 'a person cannot be their own manager');

  const dateOfJoining = cell('date_of_joining');
  if (!isAllowedJoiningDate(dateOfJoining, now))
    issue('date_of_joining', 'must be a date written YYYY-MM-DD, no more than a year ahead');

  const workLocationType = cell('work_type')
    ? matchChoice(cell('work_type'), Object.values(WORK_LOCATION_TYPES))
    : WORK_LOCATION_TYPES.ONSITE;
  if (!workLocationType)
    issue('work_type', `must be ${Object.values(WORK_LOCATION_TYPES).join(', ')} (or empty for Onsite)`);
  const employmentStatus = cell('employment_status')
    ? matchChoice(cell('employment_status'), IMPORTABLE_EMPLOYMENT_STATUSES)
    : EMPLOYMENT_STATUSES.PROBATION;
  if (!employmentStatus)
    issue('employment_status', `must be ${IMPORTABLE_EMPLOYMENT_STATUSES.join(' or ')} (or empty for Probation)`);

  const officeCode = cell('office_code').toUpperCase() || null;
  const jobLevel = cell('job_level') ? choiceOf(cell('job_level'), JOB_LEVEL_DEFINITIONS) : DEFAULT_JOB_LEVEL;
  if (!jobLevel) {
    issue('job_level', `must be one of ${JOB_LEVEL_DEFINITIONS.map((level) => level.value).join(', ')} (or empty)`);
  }
  const employmentType = cell('employment_type')
    ? choiceOf(cell('employment_type'), EMPLOYMENT_TYPE_DEFINITIONS)
    : DEFAULT_EMPLOYMENT_TYPE;
  if (!employmentType) {
    issue(
      'employment_type',
      `must be one of ${EMPLOYMENT_TYPE_DEFINITIONS.map((type) => type.value).join(', ')} (or empty)`,
    );
  }
  return {
    input: {
      name,
      personalEmail,
      companyEmail,
      departmentCode,
      designation,
      role,
      managerEmail,
      dateOfJoining,
      workLocationType,
      employmentStatus,
      officeCode,
      jobLevel,
      employmentType,
    },
    departmentName: cell('department_name'),
    issues,
  };
}

/** Adds an issue to every row after the first that has the same value in `inputField`. */
function flagRepeats(rows, inputField, column, message) {
  const firstRowByValue = new Map();
  for (const row of rows) {
    const value = row.input[inputField];
    if (!value) continue;
    if (firstRowByValue.has(value))
      row.issues.push({ field: column, message: `${message} (row ${firstRowByValue.get(value)})` });
    else firstRowByValue.set(value, row.rowNumber);
  }
}

/** Personal and company emails against the accounts that exist. */
async function checkAgainstAccounts(rows) {
  const personalEmails = rows.map((row) => row.input.personalEmail).filter(Boolean);
  const companyEmails = rows.map((row) => row.input.companyEmail).filter(Boolean);
  const [accounts, companyAddressHolders] = await Promise.all([
    User.find({ email: { $in: personalEmails } })
      .select('email status +password')
      .lean(),
    User.find({ $or: [{ companyEmail: { $in: companyEmails } }, { email: { $in: companyEmails } }] })
      .select('email companyEmail')
      .lean(),
  ]);
  const accountByEmail = new Map(accounts.map((account) => [account.email, account]));
  const takenCompanyEmails = new Set(companyAddressHolders.flatMap((holder) => [holder.email, holder.companyEmail]));
  for (const row of rows) {
    const account = accountByEmail.get(row.input.personalEmail);
    if (account?.status === ACCOUNT_STATUSES.INVITED)
      row.issues.push({ field: 'personal_email', message: 'this person is already invited; resend their invitation' });
    // A revoked invitation that was never used can be invited again, and an unconfirmed signup is
    // replaced by the invitation (services/employeeProvisioning.js); anything else is a real account.
    else if (
      account &&
      account.status !== ACCOUNT_STATUSES.UNVERIFIED &&
      !(account.status === ACCOUNT_STATUSES.DISABLED && !account.password)
    )
      row.issues.push({ field: 'personal_email', message: 'someone with this email already has an account' });
    if (row.input.companyEmail && takenCompanyEmails.has(row.input.companyEmail))
      row.issues.push({ field: 'company_email', message: 'another account already has this address' });
  }
}

/**
 * Departments: existing active ones are used, inactive ones refused, unknown ones created, named by
 * the first row that gives a department_name for the code (the code itself when none does).
 */
async function checkDepartments(rows, departmentNameByCode) {
  const codes = [...new Set(rows.map((row) => row.input.departmentCode).filter(Boolean))];
  const departments = await Department.find({ code: { $in: codes } })
    .select('code isActive')
    .lean();
  const departmentByCode = new Map(departments.map((department) => [department.code, department]));
  const departmentsToCreate = new Map();
  for (const row of rows) {
    const { departmentCode } = row.input;
    if (!DEPARTMENT_CODE_PATTERN.test(departmentCode)) continue;
    const department = departmentByCode.get(departmentCode);
    if (department?.isActive === false)
      row.issues.push({ field: 'department_code', message: 'this department is no longer active' });
    else if (!department && !departmentsToCreate.has(departmentCode))
      departmentsToCreate.set(departmentCode, departmentNameByCode.get(departmentCode) ?? departmentCode);
  }
  return [...departmentsToCreate].map(([code, name]) => ({ code, name }));
}

async function checkOffices(rows) {
  const codes = [...new Set(rows.map((row) => row.input.officeCode).filter(Boolean))];
  const offices = await OfficeLocation.find({ code: { $in: codes } })
    .select('code')
    .lean();
  const knownCodes = new Set(offices.map((office) => office.code));
  for (const row of rows) {
    if (row.input.officeCode && !knownCodes.has(row.input.officeCode))
      row.issues.push({ field: 'office_code', message: 'no office has this code' });
  }
}

/** Managers outside the file must be current employees, found by any of their emails. */
async function checkExistingManagers(rows, fileEmails) {
  const outsideEmails = [
    ...new Set(rows.map((row) => row.input.managerEmail).filter((email) => email && !fileEmails.has(email))),
  ];
  const accounts = await User.find({
    $or: [{ email: { $in: outsideEmails } }, { companyEmail: { $in: outsideEmails } }],
  })
    .select('email companyEmail')
    .lean();
  const profiles = await EmployeeProfile.find({
    userId: { $in: accounts.map((account) => account._id) },
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
  })
    .select('userId')
    .lean();
  const profileIdByUserId = new Map(profiles.map((profile) => [profile.userId.toString(), profile._id]));
  const managerIdByEmail = new Map();
  for (const account of accounts) {
    const profileId = profileIdByUserId.get(account._id.toString());
    if (!profileId) continue;
    managerIdByEmail.set(account.email, profileId);
    if (account.companyEmail) managerIdByEmail.set(account.companyEmail, profileId);
  }
  for (const row of rows) {
    const { managerEmail } = row.input;
    if (!managerEmail || fileEmails.has(managerEmail)) continue;
    const managerId = managerIdByEmail.get(managerEmail);
    if (managerId) row.existingManagerId = managerId;
    else row.issues.push({ field: 'manager_email', message: 'no current employee or row in this file has this email' });
  }
}

/**
 * Managers in the file: a circle (A manages B manages A) is refused, and a row whose manager's row
 * cannot be imported cannot be either; repeated until nothing changes, since that passes down.
 */
function checkManagersInFile(rows, fileEmails) {
  const rowByEmail = firstRowByEmail(rows);
  for (const row of rows) {
    const seen = new Set([row.input.personalEmail]);
    let managerEmail = row.input.managerEmail;
    while (managerEmail && fileEmails.has(managerEmail)) {
      if (seen.has(managerEmail)) {
        row.issues.push({ field: 'manager_email', message: 'managers in this file form a circle' });
        break;
      }
      seen.add(managerEmail);
      managerEmail = rowByEmail.get(managerEmail)?.input.managerEmail;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const manager = row.input.managerEmail && rowByEmail.get(row.input.managerEmail);
      if (row.issues.length === 0 && manager && manager !== row && manager.issues.length > 0) {
        row.issues.push({ field: 'manager_email', message: `the manager's row (${manager.rowNumber}) has problems` });
        changed = true;
      }
    }
  }
}

/**
 * @param {{ rowNumber: number, values: Record<string, string> }[]} parsedRows
 * @param {{ importerRole: string, now?: Date }} options
 * @returns {Promise<{ rows: object[], departmentsToCreate: { code: string, name: string }[],
 *   counts: { total: number, valid: number, invalid: number } }>} rows as models/EmployeeImportJob.js stores them
 */
export async function validateImportRows(parsedRows, { importerRole, now = new Date() }) {
  const allowedRoles = invitableRolesFor(importerRole);
  const departmentNameByCode = new Map();
  const rows = parsedRows.map(({ rowNumber, values }) => {
    const { input, departmentName, issues } = checkRow(values, { allowedRoles, now });
    if (departmentName && !departmentNameByCode.has(input.departmentCode))
      departmentNameByCode.set(input.departmentCode, departmentName);
    return { rowNumber, input, issues, existingManagerId: null };
  });

  flagRepeats(rows, 'personalEmail', 'personal_email', 'the same email is on an earlier row');
  flagRepeats(rows, 'companyEmail', 'company_email', 'the same company email is on an earlier row');
  const fileEmails = new Set(rows.map((row) => row.input.personalEmail).filter(Boolean));
  await checkAgainstAccounts(rows);
  const departmentsToCreate = await checkDepartments(rows, departmentNameByCode);
  await checkOffices(rows);
  await checkExistingManagers(rows, fileEmails);
  checkManagersInFile(rows, fileEmails);

  for (const row of rows)
    row.status = row.issues.length > 0 ? IMPORT_ROW_STATUSES.INVALID : IMPORT_ROW_STATUSES.PENDING;
  const valid = rows.filter((row) => row.status === IMPORT_ROW_STATUSES.PENDING).length;
  // Only departments that a row that will be imported uses.
  const usedCodes = new Set(
    rows.filter((row) => row.status === IMPORT_ROW_STATUSES.PENDING).map((row) => row.input.departmentCode),
  );
  return {
    rows,
    departmentsToCreate: departmentsToCreate.filter((department) => usedCodes.has(department.code)),
    counts: { total: rows.length, valid, invalid: rows.length - valid },
  };
}
