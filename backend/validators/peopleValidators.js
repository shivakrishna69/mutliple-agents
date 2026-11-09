/**
 * Validation for the people (onboarding) endpoints. Pure functions returning
 * { isValid: true, sanitizedInput } or { isValid: false, validationErrors: [{ field, message }] }.
 * Permission and reference checks (role allowed for the inviter, department/manager exist) are in
 * services/invitationService.js.
 */

import { DEFAULT_EMPLOYMENT_TYPE, DEFAULT_JOB_LEVEL, EMPLOYMENT_TYPES, JOB_LEVELS } from '../constants/accessRoles.js';
import { EMAIL_PATTERN } from '../constants/validation.js';
import { INVITABLE_ROLES, INVITATION_LIMITS } from '../models/EmployeeInvitation.js';
import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../models/EmployeeProfile.js';
import { isValidObjectIdString } from './conversationValidators.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';

const MAX_JOINING_DATE_DISTANCE_DAYS = 366;
const INVITABLE_EMPLOYMENT_STATUSES = [EMPLOYMENT_STATUSES.PROBATION, EMPLOYMENT_STATUSES.ACTIVE];

function readTrimmedString(rawValue) {
  return typeof rawValue === 'string' ? rawValue.trim() : '';
}

/** "YYYY-MM-DD" that is a real date within a year of today, as a UTC Date; otherwise null. */
function parseJoiningDate(rawValue) {
  if (!isRealCalendarDate(rawValue)) return null;
  const parsedDate = new Date(`${rawValue}T00:00:00.000Z`);
  const distanceDays = Math.abs(parsedDate.getTime() - Date.now()) / 86_400_000;
  return distanceDays <= MAX_JOINING_DATE_DISTANCE_DAYS ? parsedDate : null;
}

/** POST /api/people/invitations */
export function validateInvitationInput(requestBody) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const validationErrors = [];

  const name = readTrimmedString(body.name);
  if (name.length < INVITATION_LIMITS.NAME_MIN_LENGTH || name.length > INVITATION_LIMITS.NAME_MAX_LENGTH) {
    validationErrors.push({
      field: 'name',
      message: `must be ${INVITATION_LIMITS.NAME_MIN_LENGTH}-${INVITATION_LIMITS.NAME_MAX_LENGTH} characters`,
    });
  }
  const email = readTrimmedString(body.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254)
    validationErrors.push({ field: 'email', message: 'must be a valid email address' });
  // Optional: without it, an address in the company's mail domain is suggested (services/companyEmail.js).
  const companyEmail = readTrimmedString(body.companyEmail).toLowerCase() || null;
  if (companyEmail !== null && (!EMAIL_PATTERN.test(companyEmail) || companyEmail.length > 254))
    validationErrors.push({ field: 'companyEmail', message: 'must be a valid email address, or left out' });
  if (!INVITABLE_ROLES.includes(body.role))
    validationErrors.push({ field: 'role', message: `must be one of ${INVITABLE_ROLES.join(', ')}` });

  const designation = readTrimmedString(body.designation);
  if (designation.length < 2 || designation.length > INVITATION_LIMITS.DESIGNATION_MAX_LENGTH) {
    validationErrors.push({
      field: 'designation',
      message: `must be 2-${INVITATION_LIMITS.DESIGNATION_MAX_LENGTH} characters`,
    });
  }
  if (!isValidObjectIdString(body.departmentId))
    validationErrors.push({ field: 'departmentId', message: 'choose a department' });
  const hasManager =
    body.reportingManagerId !== undefined && body.reportingManagerId !== null && body.reportingManagerId !== '';
  if (hasManager && !isValidObjectIdString(body.reportingManagerId))
    validationErrors.push({ field: 'reportingManagerId', message: 'must be an employee' });
  if (!Object.values(WORK_LOCATION_TYPES).includes(body.workLocationType)) {
    validationErrors.push({
      field: 'workLocationType',
      message: `must be one of ${Object.values(WORK_LOCATION_TYPES).join(', ')}`,
    });
  }
  const dateOfJoining = parseJoiningDate(body.dateOfJoining);
  if (!dateOfJoining)
    validationErrors.push({ field: 'dateOfJoining', message: 'must be a date within a year of today' });
  if (!INVITABLE_EMPLOYMENT_STATUSES.includes(body.employmentStatus)) {
    validationErrors.push({
      field: 'employmentStatus',
      message: `must be ${INVITABLE_EMPLOYMENT_STATUSES.join(' or ')}`,
    });
  }

  const jobLevel = body.jobLevel ?? DEFAULT_JOB_LEVEL;
  if (!JOB_LEVELS.includes(jobLevel))
    validationErrors.push({ field: 'jobLevel', message: `must be one of ${JOB_LEVELS.join(', ')}` });
  const employmentType = body.employmentType ?? DEFAULT_EMPLOYMENT_TYPE;
  if (!EMPLOYMENT_TYPES.includes(employmentType)) {
    validationErrors.push({ field: 'employmentType', message: `must be one of ${EMPLOYMENT_TYPES.join(', ')}` });
  }

  if (validationErrors.length > 0) return { isValid: false, validationErrors };
  return {
    isValid: true,
    sanitizedInput: {
      name,
      email,
      companyEmail,
      role: body.role,
      profileDraft: {
        designation,
        departmentId: body.departmentId.toLowerCase(),
        reportingManagerId: hasManager ? body.reportingManagerId.toLowerCase() : null,
        workLocationType: body.workLocationType,
        dateOfJoining,
        employmentStatus: body.employmentStatus,
        jobLevel,
        employmentType,
      },
    },
  };
}
