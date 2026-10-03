/**
 * Validation for the people (onboarding) endpoints. Pure functions returning
 * { isValid: true, sanitizedInput } or { isValid: false, validationErrors: [{ field, message }] }.
 * Permission and reference checks (role allowed for the inviter, department/manager exist) are in
 * services/invitationService.js.
 */

import { EMAIL_PATTERN } from '../constants/validation.js';
import { INVITABLE_ROLES, INVITATION_LIMITS } from '../models/EmployeeInvitation.js';
import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../models/EmployeeProfile.js';
import { isValidObjectIdString } from './conversationValidators.js';

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_JOINING_DATE_DISTANCE_DAYS = 366;
const INVITABLE_EMPLOYMENT_STATUSES = [EMPLOYMENT_STATUSES.PROBATION, EMPLOYMENT_STATUSES.ACTIVE];

function readTrimmedString(rawValue) {
  return typeof rawValue === 'string' ? rawValue.trim() : '';
}

/** "YYYY-MM-DD" that is a real date within a year of today, as a UTC Date; otherwise null. */
function parseJoiningDate(rawValue) {
  if (typeof rawValue !== 'string' || !CALENDAR_DATE_PATTERN.test(rawValue)) return null;
  const parsedDate = new Date(`${rawValue}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== rawValue) return null;
  const distanceDays = Math.abs(parsedDate.getTime() - Date.now()) / 86_400_000;
  return distanceDays <= MAX_JOINING_DATE_DISTANCE_DAYS ? parsedDate : null;
}

/** POST /api/people/invitations */
export function validateInvitationInput(requestBody) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const validationErrors = [];

  const name = readTrimmedString(body.name);
  if (name.length < INVITATION_LIMITS.NAME_MIN_LENGTH || name.length > INVITATION_LIMITS.NAME_MAX_LENGTH) {
    validationErrors.push({ field: 'name', message: `must be ${INVITATION_LIMITS.NAME_MIN_LENGTH}-${INVITATION_LIMITS.NAME_MAX_LENGTH} characters` });
  }
  const email = readTrimmedString(body.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) validationErrors.push({ field: 'email', message: 'must be a valid email address' });
  if (!INVITABLE_ROLES.includes(body.role)) validationErrors.push({ field: 'role', message: `must be one of ${INVITABLE_ROLES.join(', ')}` });

  const designation = readTrimmedString(body.designation);
  if (designation.length < 2 || designation.length > INVITATION_LIMITS.DESIGNATION_MAX_LENGTH) {
    validationErrors.push({ field: 'designation', message: `must be 2-${INVITATION_LIMITS.DESIGNATION_MAX_LENGTH} characters` });
  }
  if (!isValidObjectIdString(body.departmentId)) validationErrors.push({ field: 'departmentId', message: 'choose a department' });
  const hasManager = body.reportingManagerId !== undefined && body.reportingManagerId !== null && body.reportingManagerId !== '';
  if (hasManager && !isValidObjectIdString(body.reportingManagerId)) validationErrors.push({ field: 'reportingManagerId', message: 'must be an employee' });
  if (!Object.values(WORK_LOCATION_TYPES).includes(body.workLocationType)) {
    validationErrors.push({ field: 'workLocationType', message: `must be one of ${Object.values(WORK_LOCATION_TYPES).join(', ')}` });
  }
  const dateOfJoining = parseJoiningDate(body.dateOfJoining);
  if (!dateOfJoining) validationErrors.push({ field: 'dateOfJoining', message: 'must be a date within a year of today' });
  if (!INVITABLE_EMPLOYMENT_STATUSES.includes(body.employmentStatus)) {
    validationErrors.push({ field: 'employmentStatus', message: `must be ${INVITABLE_EMPLOYMENT_STATUSES.join(' or ')}` });
  }

  if (validationErrors.length > 0) return { isValid: false, validationErrors };
  return {
    isValid: true,
    sanitizedInput: {
      name,
      email,
      role: body.role,
      profileDraft: {
        designation,
        departmentId: body.departmentId.toLowerCase(),
        reportingManagerId: hasManager ? body.reportingManagerId.toLowerCase() : null,
        workLocationType: body.workLocationType,
        dateOfJoining,
        employmentStatus: body.employmentStatus,
      },
    },
  };
}
