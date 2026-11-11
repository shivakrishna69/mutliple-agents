/**
 * Every client-facing message the auth flow can return. Controllers, validators, and
 * middleware reference these constants instead of writing strings inline, so wording
 * is reviewed in one place and the frontend can rely on stable text.
 */

import { ROLE_DEFINITIONS } from './accessRoles.js';
import {
  ACCOUNT_EMAIL_SETTINGS,
  GENDERS,
  KNOWLEDGE_BASE_SETTINGS,
  MESSAGE_FIELD_LIMITS,
  ONBOARDING_SETTINGS,
  SIGNUP_PROFILE_SETTINGS,
  TASK_SETTINGS,
  USER_FIELD_LIMITS,
  WEBHOOK_FIELD_LIMITS,
} from './validation.js';

export const AUTH_MESSAGES = Object.freeze({
  REGISTRATION_SUCCESSFUL: 'Account created successfully',
  LOGIN_SUCCESSFUL: 'Logged in successfully',
  LOGOUT_SUCCESSFUL: 'Logged out successfully',
  CURRENT_USER_RETRIEVED: 'Session is active',
  PASSWORD_POLICY_RETRIEVED: 'Password rules',
  AUTH_OPTIONS_RETRIEVED: 'Sign-in options',
  EMAIL_ALREADY_REGISTERED: 'An account with this email already exists',
  // Deliberately identical for "no such email" and "wrong password" so a caller
  // cannot use the login endpoint to discover which emails have accounts.
  INVALID_CREDENTIALS: 'Invalid email or password',
});

export const SESSION_MESSAGES = Object.freeze({
  NOT_AUTHENTICATED: 'You are not signed in',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again',
  SESSION_NOT_YET_VALID: 'Your session is not valid yet. Please sign in again',
  SESSION_INVALID: 'Your session is invalid. Please sign in again',
  SESSION_REVOKED: 'Your session has ended. Please sign in again',
  ACCOUNT_NOT_FOUND: 'The account for this session no longer exists',
  ACCOUNT_NOT_ACTIVE: 'This account is not active. Please contact your administrator',
  CSRF_TOKEN_INVALID: 'Missing or invalid CSRF token',
});

export const RATE_LIMIT_MESSAGES = Object.freeze({
  TOO_MANY_LOGIN_ATTEMPTS: 'Too many sign-in attempts. Please wait a few minutes and try again',
  TOO_MANY_SIGNUP_ATTEMPTS: 'Too many accounts created from this network. Please try again later',
  TOO_MANY_ACCOUNT_EMAIL_REQUESTS: 'Too many email requests from this network. Please try again later',
  TOO_MANY_ACCOUNT_LINK_ATTEMPTS: 'Too many attempts with emailed links. Please wait a few minutes and try again',
  TOO_MANY_SUPPORT_MESSAGES: 'You are sending messages too quickly. Please wait a moment and try again',
  TOO_MANY_VAULT_UPLOADS: 'Too many document uploads. Please wait a few minutes and try again',
  TOO_MANY_VAULT_DOWNLOADS: 'Too many download requests. Please wait a moment and try again',
  TOO_MANY_EMPLOYEE_IMPORTS: 'Too many employee files uploaded. Please wait a few minutes and try again',
  TOO_MANY_PUNCH_ATTEMPTS: 'Too many punch attempts. Please wait a minute and try again',
  TOO_MANY_REGULARIZATION_MESSAGES: 'Too many attendance correction messages. Please wait a minute and try again',
  TOO_MANY_TAX_ESTIMATES: 'Too many tax estimates. Please wait a minute and try again',
  TOO_MANY_PAYSLIP_GENERATIONS: 'Too many payslips generated in a short time. Please wait a minute and try again',
  TOO_MANY_OFFER_CALCULATIONS: 'Too many offer calculations in a short time. Please wait a minute and try again',
  TOO_MANY_OFFER_DISPATCHES: 'Too many offers sent in a short time. Please wait a few minutes and try again',
  TOO_MANY_KNOWLEDGE_UPLOADS: 'Too many documents uploaded in a short time. Please wait a few minutes and try again',
  TOO_MANY_KNOWLEDGE_CHANGES: 'Too many knowledge base changes in a short time. Please wait a moment and try again',
  TOO_MANY_VERIFICATIONS: 'Too many verification requests. Please wait a minute and try again',
  TOO_MANY_INVITATIONS: 'Too many invitations sent. Please wait a few minutes and try again',
  TOO_MANY_INVITATION_ATTEMPTS: 'Too many attempts. Please wait a few minutes and try again',
  TOO_MANY_OKR_UPDATES: 'Too many OKR updates in a short time. Please wait a moment and try again',
  TOO_MANY_LEAVE_ADMIN_UPDATES: 'Too many leave changes in a short time. Please wait a moment and try again',
  TOO_MANY_LEAVE_ASSISTANT_MESSAGES: 'Too many questions to the leave assistant in a short time. Please wait a moment',
  TOO_MANY_AGENT_QUESTIONS: 'Too many questions to department agents in a short time. Please wait a moment',
  TOO_MANY_AGENT_CHAT_CHANGES: 'Too many changes in a short time. Please wait a moment and try again',
  TOO_MANY_TASK_CHANGES: 'Too many task changes in a short time. Please wait a moment and try again',
  TOO_MANY_LEAVE_REQUEST_UPDATES:
    'Too many leave requests or decisions in a short time. Please wait a moment and try again',
  TOO_MANY_WORKPLACE_SETUP_UPDATES:
    'Too many office or calendar changes in a short time. Please wait a moment and try again',
});

export const SUPPORT_MESSAGES = Object.freeze({
  MESSAGE_RECEIVED: 'Message received',
  CUSTOMERS_ONLY: 'Only customer accounts can send support messages',
  CLIENT_MESSAGE_ID_INVALID: 'clientMessageId must be 8-64 letters, digits, or hyphens',
});

export const VALIDATION_MESSAGES = Object.freeze({
  REQUEST_VALIDATION_FAILED: 'Request validation failed',
  REQUEST_BODY_MUST_BE_OBJECT: 'Request body must be a JSON object',
  NAME_REQUIRED: 'Name is required',
  NAME_MUST_BE_STRING: 'Name must be a string',
  NAME_LENGTH_INVALID: `Name must be between ${USER_FIELD_LIMITS.NAME_MIN_LENGTH} and ${USER_FIELD_LIMITS.NAME_MAX_LENGTH} characters`,
  EMAIL_REQUIRED: 'Email is required',
  EMAIL_MUST_BE_STRING: 'Email must be a string',
  EMAIL_TOO_LONG: `Email must be at most ${USER_FIELD_LIMITS.EMAIL_MAX_LENGTH} characters`,
  EMAIL_FORMAT_INVALID: 'Email format is invalid',
  PASSWORD_REQUIRED: 'Password is required',
  PASSWORD_MUST_BE_STRING: 'Password must be a string',
  PASSWORD_TOO_SHORT: `Password must be at least ${USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH} characters`,
  PASSWORD_TOO_LONG: `Password must be at most ${USER_FIELD_LIMITS.PASSWORD_MAX_BYTES} bytes`,
  NEW_PASSWORD_SAME_AS_CURRENT: 'The new password must be different from the current one',
  FIRST_NAME_REQUIRED: 'First name is required',
  FIRST_NAME_MUST_BE_STRING: 'First name must be text',
  FIRST_NAME_TOO_LONG: `First name must be at most ${USER_FIELD_LIMITS.GIVEN_NAME_MAX_LENGTH} characters`,
  LAST_NAME_REQUIRED: 'Last name is required',
  LAST_NAME_MUST_BE_STRING: 'Last name must be text',
  LAST_NAME_TOO_LONG: `Last name must be at most ${USER_FIELD_LIMITS.FAMILY_NAME_MAX_LENGTH} characters`,
  PHONE_REQUIRED: 'Phone number is required',
  PHONE_MUST_BE_STRING: 'Phone number must be text',
  PHONE_INVALID: 'Enter a valid phone number for the country you picked, or the number with its country code',
  PHONE_COUNTRY_INVALID: 'Pick the country of your phone number from the list',
  BIRTH_DATE_REQUIRED: 'Date of birth is required',
  BIRTH_DATE_INVALID: 'Enter your date of birth as a real date',
  BIRTH_DATE_TOO_YOUNG: `You must be at least ${SIGNUP_PROFILE_SETTINGS.MINIMUM_AGE_YEARS} years old to create an account`,
  BIRTH_DATE_TOO_OLD: 'Check your date of birth: it is too far in the past',
  GENDER_REQUIRED: 'Select your gender',
  GENDER_INVALID: 'Select your gender from the list',
  TERMS_NOT_ACCEPTED: 'Please accept the terms of service and privacy policy to continue',
  VERIFICATION_CODE_FORMAT: `Enter the ${ACCOUNT_EMAIL_SETTINGS.VERIFICATION_CODE_DIGITS}-digit code from the email`,
  CONFIRM_PASSWORD_REQUIRED: 'Type the password again to confirm it',
  PASSWORDS_DO_NOT_MATCH: 'The two passwords do not match',
  REMEMBER_DEVICE_MUST_BE_BOOLEAN: '"Remember this device" must be true or false',
  TOKEN_REQUIRED: 'The link token is required',
  TOKEN_MUST_BE_STRING: 'The link token must be a string',
});

export const ACCOUNT_MESSAGES = Object.freeze({
  PASSWORD_CHANGED: 'Password changed. Other devices have been signed out',
  CURRENT_PASSWORD_INCORRECT: 'The current password is incorrect',
});

/**
 * Signup confirmation and password reset (controllers/accountEmailController.js). The answers to
 * signup, resend and forgot-password are the same whether or not the address has an account.
 */
export const ACCOUNT_EMAIL_MESSAGES = Object.freeze({
  SIGNUP_CHECK_EMAIL: 'Check your email for a code and a link to finish signing up',
  VERIFICATION_RESENT: 'If this address is waiting to be confirmed, a new code and link are on their way',
  EMAIL_VERIFIED: 'Email confirmed. You are signed in',
  VERIFICATION_LINK_INVALID: 'This confirmation link is not valid or has expired. Ask for a new one',
  VERIFICATION_CODE_INVALID:
    'This code is not correct or has expired. Check the latest email we sent, or ask for a new code',
  EMAIL_NOT_VERIFIED:
    'Confirm your email address first: enter the code or open the link we sent you, or ask for a new one',
  PASSWORD_RESET_REQUESTED: `If this address has an account, a code and a link to reset the password are on their way. They work for ${ACCOUNT_EMAIL_SETTINGS.PASSWORD_RESET_VALIDITY_MS / 60_000} minutes`,
  RESET_LINK_VALID: 'This password reset link is valid',
  RESET_LINK_INVALID: 'This password reset link is not valid or has expired. Ask for a new one',
  RESET_CODE_INVALID: 'This code is not correct or has expired. Check the latest email we sent, or ask for a new code',
  PASSWORD_RESET_DONE: 'Your password has been changed and every device signed out. Sign in with your new password',
  EMAIL_COOLDOWN: 'An email was sent to this address a moment ago. Please wait before asking for another',
  EMAIL_UNAVAILABLE:
    'Email is not available on this server, so this cannot be done right now. Contact your administrator',
});

export const ADMIN_MESSAGES = Object.freeze({
  ADMINS_ONLY: 'Only administrators can do this',
  USER_MANAGERS_ONLY: 'Only administrators and IT administrators can manage users',
  ADMIN_ROLE_RESTRICTED: "Only an administrator can make someone an administrator or change an administrator's role",
  USERS_RETRIEVED: 'Users retrieved',
  ROLE_UPDATED: 'Role updated',
  ROLE_UNCHANGED: 'The user already has this role',
  USER_NOT_FOUND: 'User not found',
  INVALID_USER_ID: 'User id is not valid',
  INVALID_ROLE: `Role must be one of: ${ROLE_DEFINITIONS.map((role) => role.label).join(', ')}`,
  CANNOT_CHANGE_OWN_ROLE: 'You cannot change your own role',
  SEARCH_TOO_LONG: 'Search text must be at most 100 characters',
});

export const ORG_MESSAGES = Object.freeze({
  HIERARCHY_RETRIEVED: 'Organisation hierarchy retrieved',
  REPORTS_RETRIEVED: 'Reports retrieved',
  INVALID_EMPLOYEE_ID: 'Employee id is not valid',
});

export const VAULT_MESSAGES = Object.freeze({
  DOCUMENT_UPLOADED: 'Document uploaded',
  DOCUMENTS_RETRIEVED: 'Documents retrieved',
  DOWNLOAD_URL_ISSUED: 'Download link issued',
  DOCUMENT_VERIFIED: 'Document verified',
  INVALID_EMPLOYEE_ID: 'Employee id is not valid',
  INVALID_DOCUMENT_ID: 'Document id is not valid',
  INVALID_DOCUMENT_TYPE: 'documentType must be Offer_Letter, Appraisal_Doc, Gov_ID or Leave_Document',
  INVALID_ACCESSIBLE_ROLES: 'accessibleRoles must be a comma-separated list of admin and/or hr, each listed once',
  FILE_REQUIRED: 'Attach exactly one file in the "file" field',
  FILE_TOO_LARGE: 'The file is too large (maximum 10 MB)',
  UNSUPPORTED_FILE_TYPE: 'Only PDF, JPEG and PNG files are accepted',
  MULTIPART_REQUIRED: 'Send the upload as multipart/form-data',
  MALFORMED_UPLOAD: 'The upload could not be read. Check the form fields and try again',
  DOCUMENT_NOT_FOUND: 'Document not found',
  ACCESS_DENIED: 'You do not have access to this document',
  UPLOAD_NOT_ALLOWED: 'You are not allowed to upload this document',
  ROLE_GRANT_NOT_ALLOWED: 'Only admin and HR users can choose who may access a document',
  VERIFY_NOT_ALLOWED: 'You are not allowed to verify this document',
  CANNOT_VERIFY_OWN_DOCUMENT: 'You cannot verify your own document',
  ALREADY_VERIFIED: 'This document is already verified',
  CONCURRENT_UPDATE: 'This document was changed by someone else. Reload and try again',
  STORAGE_NOT_CONFIGURED: 'Document storage is not available on this server',
  STORAGE_UNAVAILABLE: 'Document storage is temporarily unavailable. Please try again shortly',
});

export const ATTENDANCE_MESSAGES = Object.freeze({
  PUNCHED_IN: 'Punched in',
  PUNCHED_IN_UNASSIGNED:
    'Punched in. You have no base office yet, so your location was recorded for HR to review. Ask HR to assign your office',
  BODY_MUST_BE_OBJECT: 'Request body must be a JSON object',
  LATITUDE_INVALID: 'lat must be a number between -90 and 90',
  LONGITUDE_INVALID: 'lng must be a number between -180 and 180',
  LOCATION_MISSING: 'Your device did not report a real location (0, 0). Turn on location services and try again',
  ACCURACY_INVALID: 'accuracyMeters must be a positive number of metres',
  FINGERPRINT_INVALID: 'deviceFingerprint must be 16-256 printable characters without spaces',
  MAC_ADDRESS_INVALID: 'macAddress must be a MAC-48 address such as 3C:22:FB:7A:10:9E',
  MAC_ADDRESS_PLACEHOLDER:
    'macAddress 02:00:00:00:00:00 is a placeholder reported by mobile systems, not a device address',
  PROFILE_NOT_FOUND: 'No employee profile is linked to your account. Contact HR',
  EMPLOYMENT_ENDED: 'Your employment has ended, so attendance cannot be recorded',
  OFFICE_NOT_CONFIGURED: 'Your base office has not been set up yet. Contact HR before punching in',
  LOCATION_TOO_IMPRECISE:
    'Your location is not precise enough to confirm you are at the office. Turn on GPS / precise location and try again',
  DEVICE_NOT_RECOGNISED: 'This device is not registered for your attendance. Use your registered device or contact HR',
  UNAUTHORIZED_SPATIAL_LOCATION: 'Unauthorized Spatial Location: you are outside the area allowed for punching in',
  ALREADY_PUNCHED_IN: 'You have already punched in today',
  PUNCHED_OUT: 'Punched out',
  NOT_PUNCHED_IN: 'You have not punched in, so there is nothing to punch out of',
  ALREADY_PUNCHED_OUT: 'You have already punched out today',
  PUNCH_OUT_TOO_LATE:
    'Your punch-in was closed automatically at the end of the shift, because the punch-out came too late. ' +
    'Ask your manager if the hours need correcting',
  TODAY_RETRIEVED: 'Today’s attendance retrieved',
  TODAY_FORBIDDEN: 'Only HR, administrators and people with a team can see who is working today',
  TODAY_QUERY_INVALID: 'The date or department asked for is not valid',
  MY_DAY_RETRIEVED: 'Your attendance today retrieved',
  ANALYTICS_RETRIEVED: 'Attendance analytics retrieved',
  ANALYTICS_FORBIDDEN: 'Only HR, administrators and people with a team can see attendance analytics',
  ANALYTICS_QUERY_INVALID: 'The month or department asked for is not valid',
  ANALYTICS_MONTH_AHEAD: 'Attendance analytics cover this month and earlier months',
  WORK_MODE_INVALID: 'workMode must be "office", "home" or "on_duty"',
  WORK_MODE_NOT_ALLOWED: 'Your work type does not allow punching in this way. Choose another option or contact HR',
  ON_DUTY_REASON_INVALID: 'Say why you are on duty (where you are working), in 3 to 300 characters',
  ON_DUTY_REASON_UNEXPECTED: 'onDutyReason is only for on-duty punches',
});

export const PRESENCE_MESSAGES = Object.freeze({
  SETUP_RETRIEVED: 'Presence settings retrieved',
  NOTICE_ACKNOWLEDGED: 'Thank you. Your activity status is now shown to your team',
  NOTICE_OUTDATED: 'The notice has changed since this page was opened. Reload it to read the current one',
  NOTICE_VERSION_INVALID: 'version must be the notice version you read',
  FORBIDDEN: 'Only HR, administrators and people with a team can see their activity',
  QUERY_INVALID: 'The date or department asked for is not valid',
  NOW_RETRIEVED: 'Presence retrieved',
  DAILY_RETRIEVED: 'Daily activity retrieved',
  PROFILE_NOT_FOUND: 'No employee profile is linked to your account, so there are no working days to show',
});

export const REGULARIZATION_MESSAGES = Object.freeze({
  AGENT_REPLIED: 'Regularization request processed',
  REGULARIZATION_RECORDED: 'Attendance regularized',
  REGULARIZATION_ALREADY_RECORDED: 'Attendance for that day was already recorded',
  REVIEW_FILED: 'Review filed',
  REVIEW_ALREADY_FILED: 'Review already filed',
  REVIEWS_RETRIEVED: 'Reviews retrieved',
  REVIEW_DECIDED: 'Review decided',
  BODY_MUST_BE_OBJECT: 'Request body must be a JSON object',
  MESSAGE_INVALID: 'message must be 1-2000 characters describing the attendance correction',
  START_NEW_INVALID: 'startNew must be true or false',
  DECISION_INVALID: 'decision must be "approve" or "reject"',
  PUNCH_IN_TIME_INVALID: 'punch-in time must be HH:MM (24-hour)',
  NOTE_INVALID: 'note must be text of at most 500 characters',
  EMPLOYEE_ID_INVALID: 'employee_id is not a valid id',
  DATE_INVALID: 'date must be a real calendar day as YYYY-MM-DD',
  ZONED_TIME_INVALID: 'punch_in_time must be an ISO 8601 date-time with a UTC offset',
  EVIDENCE_COUNT_INVALID: 'evidence count must be a whole number from 0 to 500 (at least 1 for automatic approval)',
  REASON_INVALID: 'reason must be text of at most 300 characters',
  THREAD_ID_INVALID: 'thread_id must be at most 200 printable characters',
  ROUTING_REASON_INVALID: 'routing_reason is not a known reason',
  GEOFENCE_RADIUS_INVALID: 'allowed_geofence_radius must be a whole number of metres',
  IDEMPOTENCY_KEY_INVALID: 'idempotency_key must be 1-300 printable characters',
  INVALID_REVIEW_ID: 'Review id is not valid',
  REVIEW_NOT_FOUND: 'Review not found',
  REVIEWS_FORBIDDEN: 'Only managers, HR and administrators can review regularization requests',
  REVIEW_NOT_YOURS: 'This review belongs to another manager',
  CANNOT_DECIDE_OWN_REVIEW: 'You cannot decide your own regularization request',
  REVIEW_ALREADY_DECIDED: 'This review has already been decided',
  REVIEW_HAS_NO_DATE: 'This request has no date; reject it so the employee can submit it again with the date',
  REVIEW_CONCURRENT_UPDATE: 'This review was decided by someone else just now. Reload and check its status',
  PUNCH_TIME_DOES_NOT_EXIST: 'That local time does not exist on that date (daylight-saving change)',
  AI_UNAVAILABLE: 'The attendance assistant is unavailable right now. Please try again shortly',
  AI_TIMEOUT: 'The attendance assistant took too long to answer. Please try again',
  INTERNAL_KEY_INVALID: 'Missing or invalid internal API key',
});

export const PAYROLL_MESSAGES = Object.freeze({
  RULES_RETRIEVED: 'Payroll rules retrieved',
  ESTIMATE_COMPUTED: 'Tax estimate computed',
  BODY_MUST_BE_OBJECT: 'Request body must be a JSON object',
  INPUT_INVALID: 'The salary or investment details are invalid',
  PAYSLIP_ISSUED: 'Payslip issued',
  PAYSLIPS_RETRIEVED: 'Payslips retrieved',
  DOWNLOAD_ISSUED: 'Download link issued',
  VERIFICATION_COMPLETED: 'Verification completed',
  PAYSLIP_MANAGERS_ONLY: 'Only HR, Finance & Payroll and administrators can issue payslips',
  PAYSLIP_ACCESS_DENIED: 'You do not have access to these payslips',
  PAYSLIP_NOT_FOUND: 'Payslip not found',
  NO_EMPLOYEE_PROFILE: 'No employee profile is linked to your account',
  VERIFICATION_ID_INVALID: 'Verification IDs look like PS-202610-1A2B-3C4D-5E6F-7A8B',
  VERIFICATION_NOT_FOUND: 'No payslip has this verification ID',
});

export const OKR_MESSAGES = Object.freeze({
  ALIGNMENT_RETRIEVED: 'OKR alignment retrieved',
  OBJECTIVE_CREATED: 'Objective created',
  OBJECTIVE_UPDATED: 'Objective updated',
  KEY_RESULT_CREATED: 'Key result created',
  PROGRESS_UPDATED: 'Progress updated',
  MILESTONE_CREATED: 'Milestone added',
  MILESTONE_UPDATED: 'Milestone updated',
  INPUT_INVALID: 'The OKR details are invalid',
  OKRS_EMPLOYEES_ONLY: 'OKRs are available to employees, HR and administrators',
});

/** Messages shared by several features. */
export const COMMON_MESSAGES = Object.freeze({
  STALE_VERSION: 'This was changed by someone else. Reload and try again',
  EMPLOYEE_NOT_FOUND: 'Employee not found',
});

export const COMPANY_MESSAGES = Object.freeze({
  BRANDING_RETRIEVED: 'Company branding retrieved',
  SETTINGS_RETRIEVED: 'Company settings retrieved',
  SETTINGS_UPDATED: 'Company settings updated',
  INPUT_INVALID: 'The company settings are invalid',
  RESTRICTED: 'Only administrators, IT administrators and HR can see the company settings',
  ADMINS_ONLY: 'Only administrators and IT administrators can change the company settings',
});

export const DEPARTMENT_MESSAGES = Object.freeze({
  DEPARTMENTS_RETRIEVED: 'Departments retrieved',
  DEPARTMENT_RETRIEVED: 'Department retrieved',
  DEPARTMENT_CREATED: 'Department added',
  DEPARTMENT_UPDATED: 'Department updated',
  DEPARTMENT_DELETED: 'Department removed',
  DEPARTMENT_NOT_FOUND: 'Department not found',
  DEPARTMENT_CODE_TAKEN: 'Another department already uses this code',
  DEPARTMENT_SLUG_TAKEN: 'Another department already uses this address',
  DEPARTMENT_NAME_TAKEN: 'A department with this name already exists at this level',
  DEPARTMENT_IN_USE:
    'This department still has employees, sub-departments or invitations, so it cannot be removed; deactivate it instead',
  INPUT_INVALID: 'The department details are invalid',
  RESTRICTED: 'Only HR and administrators can manage departments',
});

export const EMPLOYEE_IMPORT_MESSAGES = Object.freeze({
  FILE_CHECKED: 'File checked. Review the rows, then start the import',
  JOBS_RETRIEVED: 'Imports retrieved',
  JOB_RETRIEVED: 'Import retrieved',
  JOB_STARTED: 'Import started. Employees are being created in the background',
  RESULTS_RETRIEVED: 'Import results retrieved',
  JOB_NOT_FOUND: 'Import not found',
  JOB_NOT_WAITING: 'This import has already been started',
  NOTHING_TO_IMPORT: 'No row of this file can be imported. Fix the file and upload it again',
  FILE_REQUIRED: 'Choose a CSV file to upload in the field "file"',
  FILE_TOO_LARGE: 'The file is too large. Split it into smaller files',
  MALFORMED_UPLOAD: 'The upload could not be read. Please try again',
  MULTIPART_REQUIRED: 'Send the file as multipart/form-data',
  FILE_NOT_CSV: 'The file could not be read as CSV. Save it from your spreadsheet as "CSV UTF-8"',
  FILE_EMPTY: 'The file has no employee rows',
  TOO_MANY_ROWS: 'The file has too many rows. Split it into smaller files',
  COLUMNS_MISSING: 'The file is missing required columns',
  RESTRICTED: 'Only HR and administrators can import employees',
  INPUT_INVALID: 'The import request is invalid',
});

export const OFFICE_MESSAGES = Object.freeze({
  OFFICES_RETRIEVED: 'Offices retrieved',
  OFFICE_RETRIEVED: 'Office retrieved',
  OFFICE_CREATED: 'Office added',
  OFFICE_UPDATED: 'Office updated',
  OFFICE_DELETED: 'Office removed',
  OFFICE_NOT_FOUND: 'Office not found',
  OFFICE_CODE_TAKEN: 'Another office already uses this code',
  OFFICE_IN_USE: 'This office still has employees, attendance records or holidays, so it cannot be removed',
  INPUT_INVALID: 'The office details are invalid',
  RESTRICTED: 'Only HR and administrators can manage offices',
  EMPLOYEE_OFFICE_ASSIGNED: 'Base office updated',
  EMPLOYEE_GEOFENCE_RADIUS_SET: 'Punch-in radius updated',
  EMPLOYEES_RETRIEVED: 'Employees retrieved',
});

export const LEAVE_MESSAGES = Object.freeze({
  SETTINGS_RETRIEVED: 'Leave settings retrieved',
  SETTINGS_UPDATED: 'Leave settings updated',
  LEAVE_YEAR_LOCKED: 'The leave year start cannot change once leave has been recorded',
  TYPES_RETRIEVED: 'Leave types retrieved',
  TYPE_CREATED: 'Leave type added',
  TYPE_UPDATED: 'Leave type updated',
  LEAVE_TYPE_NOT_FOUND: 'Leave type not found',
  LEAVE_TYPE_CODE_TAKEN: 'Another leave type already uses this code',
  BALANCE_NOT_TRACKED: 'This leave type does not keep a balance',
  BALANCES_RETRIEVED: 'Leave balances retrieved',
  LEDGER_RETRIEVED: 'Leave history retrieved',
  ADJUSTMENT_POSTED: 'Leave balance adjusted',
  ENCASHMENT_POSTED: 'Leave encashed',
  TRACKS_BALANCE_LOCKED: 'Whether this leave type keeps a balance cannot change once leave has been recorded for it',
  LEAVE_YEAR_NOT_OPEN:
    'Adjustments can be made to the current leave year, or to the previous one until its year end is processed',
  PAYROLL_REFERENCE_RESERVED: 'References starting with YEAR-END- are reserved for year-end encashments',
  OWN_BALANCE_RESTRICTED: 'Your own leave balance must be adjusted or encashed by another HR user or an administrator',
  INSUFFICIENT_BALANCE: 'The leave balance is not enough for this',
  NOT_ENCASHABLE: 'This leave type cannot be encashed',
  ENCASHMENT_EXCEEDS_LIMIT: 'Encashing this many days would leave less than the policy keeps',
  DUPLICATE_ENCASHMENT: 'An encashment with this payroll reference is already recorded',
  JOB_COMPLETED: 'Leave accruals and year-end movements are up to date',
  RECONCILED: 'Leave balances checked against the ledger',
  FUTURE_RUN_DATE: 'The leave job cannot run for a future date',
  // Requests
  REQUEST_PREVIEWED: 'Leave priced',
  REQUEST_SUBMITTED: 'Leave request submitted',
  REQUESTS_RETRIEVED: 'Leave requests retrieved',
  REQUEST_RETRIEVED: 'Leave request retrieved',
  REQUEST_APPROVED: 'Leave request approved',
  REQUEST_REJECTED: 'Leave request rejected',
  REQUEST_WITHDRAWN: 'Leave request withdrawn',
  REQUEST_CANCELLED: 'Leave cancelled',
  CHANGE_REQUESTED: 'Change request sent for approval',
  CHANGE_APPROVED: 'Change approved',
  CHANGE_REJECTED: 'Change rejected',
  PAYROLL_EXPORT_RETRIEVED: 'Leave payroll figures retrieved',
  ASSISTANT_REPLIED: 'The leave assistant replied',
  ASSISTANT_UNAVAILABLE: 'The leave assistant is not available right now. You can still ask for leave with the form',
  REQUEST_NOT_FOUND: 'Leave request not found',
  LEAVE_TYPE_INACTIVE: 'This leave type is no longer offered',
  NOT_ELIGIBLE: 'This leave type is not available to you at your current employment status',
  OFFICE_NOT_ASSIGNED: 'You have no base office yet, so your working days cannot be worked out. Please ask HR',
  HALF_DAY_NOT_ALLOWED: 'This leave type can only be taken in full days',
  OUTSIDE_LEAVE_YEAR: 'Leave must fall within the current leave year',
  BEFORE_JOINING: 'Leave cannot start before your joining date',
  TOO_FAR_BACK: 'This leave starts further back than the policy allows for this type',
  NOTICE_TOO_SHORT: 'This leave type needs more notice',
  SERVICE_TOO_SHORT: 'You have not completed the service this leave type requires',
  NOTHING_TO_TAKE: 'These dates are all non-working days, so there is no leave to take',
  TOO_MANY_CONSECUTIVE_DAYS: 'This is more days in one go than the policy allows for this type',
  ATTACHMENT_REQUIRED: 'A leave this long needs a supporting document from your document vault',
  ATTACHMENT_NOT_FOUND: 'The supporting document must be a leave document in your own document vault',
  OVERLAPPING_REQUEST: 'You already have leave on some of these days',
  NOT_APPROVER: 'Only the reporting manager, HR or an administrator can decide this request',
  SELF_DECISION: 'Your own leave must be decided by someone else',
  NOT_REQUESTER: 'Only the employee can change their own leave request',
  REQUEST_NOT_PENDING: 'This request has already been decided',
  REQUEST_NOT_APPROVED: 'Only approved leave can be cancelled or changed',
  REQUEST_BUSY: 'This request is being updated. Please try again in a moment',
  STEP_APPROVED: 'Approved. The request now needs HR’s approval',
  HR_APPROVAL_NEEDED: 'This leave also needs HR’s approval, which only HR or an administrator can give',
  STEP_ALREADY_DECIDED: 'Someone decided this step a moment ago. Reload to see where the request stands',
  SAME_APPROVER_TWICE: 'You approved an earlier step of this request, so someone else must approve this one',
  ALREADY_STARTED: 'This leave has started, so ask for a change instead of cancelling it',
  NOT_STARTED: 'This leave has not started yet, so you can cancel it directly',
  CHANGE_ALREADY_OPEN: 'A change to this leave is already waiting for a decision',
  NO_CHANGE_OPEN: 'There is no change request waiting for a decision',
  INVALID_SHORTEN: 'The new last day must fall within the leave and give back some of it',
  INPUT_INVALID: 'The leave details are invalid',
  RESTRICTED: 'Only HR and administrators can manage leave',
  EMPLOYEES_ONLY: 'Leave is available to employees, HR and administrators',
});

export const WORK_CALENDAR_MESSAGES = Object.freeze({
  HOLIDAYS_RETRIEVED: 'Holidays retrieved',
  HOLIDAY_CREATED: 'Holiday added',
  HOLIDAY_UPDATED: 'Holiday updated',
  HOLIDAY_DELETED: 'Holiday removed',
  DAYS_RETRIEVED: 'Calendar retrieved',
  INPUT_INVALID: 'The calendar details are invalid',
  RESTRICTED: 'Only HR and administrators can change the work calendar',
  OFFICE_REQUIRED: 'Choose the office whose calendar you want to see',
  OFFICE_NOT_ASSIGNED: 'You have no base office yet, so there is no work calendar to show. Please ask HR',
  HOLIDAY_NOT_FOUND: 'Holiday not found',
  HOLIDAY_CLASHES: 'Another holiday already covers this date for one of these offices',
  EMPLOYEES_ONLY: 'The work calendar is available to employees, HR and administrators',
});

export const PEOPLE_MESSAGES = Object.freeze({
  RESTRICTED: 'Employee onboarding is available to HR and administrators only',
  OPTIONS_RETRIEVED: 'Invitation options retrieved',
  INVITATIONS_RETRIEVED: 'Invitations retrieved',
  INVITATION_CREATED: 'Invitation created',
  INVITATION_RESENT: 'Invitation sent again',
  INVITATION_REVOKED: 'Invitation revoked',
  INVITATION_RETRIEVED: 'Invitation retrieved',
  INVITATION_ACCEPTED: 'Welcome aboard! Your account is ready',
  INVITATION_INVALID: 'The invitation details are invalid',
  INVITATION_ID_INVALID: 'Invalid invitation id',
  STATUS_INVALID: 'Status must be pending, expired, accepted or revoked',
});

export const AGENT_TELEMETRY_MESSAGES = Object.freeze({
  EVENTS_ACCEPTED: 'Telemetry events processed',
  BATCH_INVALID: 'The telemetry batch is invalid',
});

export const ANALYTICS_MESSAGES = Object.freeze({
  RISK_REPORT_RETRIEVED: 'Workforce risk report retrieved',
  SCORES_RECORDED: 'Scores recorded',
  ANALYTICS_RESTRICTED: 'Workforce analytics are available to HR and administrators only',
  QUERY_INVALID: 'The report filters are invalid',
  SCORES_INVALID: 'The score batch is invalid',
});

export const WEBHOOK_MESSAGES = Object.freeze({
  MESSAGE_PROCESSED: 'Message processed',
  DUPLICATE_EVENT: 'Event already processed',
  SIGNATURE_MISSING: 'Missing webhook signature headers',
  SIGNATURE_MALFORMED: 'Webhook signature headers are malformed',
  SIGNATURE_EXPIRED: 'Webhook timestamp is outside the allowed window',
  SIGNATURE_INVALID: 'Webhook signature is invalid',
  SENDER_NOT_FOUND: 'Sender is not a registered customer',
  EVENT_ID_REQUIRED: 'eventId is required',
  EVENT_ID_MUST_BE_STRING: 'eventId must be a string',
  EVENT_ID_INVALID: `eventId must be 1-${WEBHOOK_FIELD_LIMITS.EVENT_ID_MAX_LENGTH} printable characters without spaces`,
  SENDER_EMAIL_REQUIRED: 'senderEmail is required',
  SENDER_EMAIL_MUST_BE_STRING: 'senderEmail must be a string',
  SENDER_EMAIL_INVALID: 'senderEmail is not a valid email address',
  TEXT_REQUIRED: 'text is required',
  TEXT_MUST_BE_STRING: 'text must be a string',
  TEXT_TOO_LONG: `text must be at most ${MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH} characters`,
});

export const CONVERSATION_MESSAGES = Object.freeze({
  LIST_RETRIEVED: 'Conversations retrieved',
  DETAILS_RETRIEVED: 'Conversation retrieved',
  MESSAGES_RETRIEVED: 'Messages retrieved',
  CLAIMED: 'Conversation claimed',
  RELEASED: 'Conversation returned to the queue',
  REPLY_SENT: 'Reply sent',
  STAFF_ONLY: 'Only support staff can do this',
  NOT_ACCESSIBLE: 'Conversation not found or not accessible',
  INVALID_CONVERSATION_ID: 'Conversation id is not valid',
  NOT_CLAIMABLE: 'Only conversations waiting for a human can be claimed',
  ALREADY_CLAIMED: 'Another agent has already claimed this conversation',
  NOT_ASSIGNED_TO_YOU: 'Only the agent assigned to this conversation can do this',
  REPLY_TEXT_REQUIRED: 'Reply text is required',
  REPLY_TEXT_MUST_BE_STRING: 'Reply text must be a string',
  REPLY_TEXT_TOO_LONG: `Reply text must be at most ${MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH} characters`,
  CHANGED_CONCURRENTLY: 'The conversation was changed by someone else; reload and try again',
});

/** Messages carried in Socket.IO error payloads and acknowledgements. */
export const SOCKET_MESSAGES = Object.freeze({
  ORIGIN_NOT_ALLOWED: 'Origin not allowed',
  INVALID_PAYLOAD: 'Payload must be an object with a valid conversationId',
  CONVERSATION_NOT_ACCESSIBLE: 'Conversation not found or not accessible',
  TOO_MANY_ROOMS: 'Too many conversations joined on this connection',
  RATE_LIMITED: 'Too many requests on this connection; slow down',
  ACCESS_REVOKED: 'You no longer have access to this conversation',
  SESSION_ENDED: 'Your session has ended. Please sign in again',
  TELEMETRY_FORBIDDEN: 'Agent telemetry is available to administrators only',
  PRESENCE_NOT_RECORDED: 'Your activity is not recorded: acknowledge the notice first, or presence is switched off',
  PRESENCE_FORBIDDEN: 'Only HR, administrators and people with a team can follow presence',
  SERVER_ERROR: 'Something went wrong. Please try again',
});

/**
 * Text saved as the assistant's reply when the AI service cannot answer. It is shown to the
 * customer, so it explains what happens next rather than what went wrong.
 */
export const CUSTOMER_FACING_MESSAGES = Object.freeze({
  AI_UNAVAILABLE_FALLBACK_REPLY:
    "Sorry, our assistant can't respond right now. We've passed your message to our support team, and a person will reply shortly.",
});

/** One message per PASSWORD_STRENGTH_RULES `ruleId` (constants/validation.js). */
export const PASSWORD_RULE_MESSAGES = Object.freeze({
  uppercaseLetter: 'Password must contain at least one uppercase letter (A-Z)',
  lowercaseLetter: 'Password must contain at least one lowercase letter (a-z)',
  digit: 'Password must contain at least one number (0-9)',
  specialCharacter: 'Password must contain at least one special character',
});

/** The gender choices the sign-up screen lists, in this order (GET /api/auth/options). */
export const GENDER_LABELS = Object.freeze({
  [GENDERS.MALE]: 'Male',
  [GENDERS.FEMALE]: 'Female',
  [GENDERS.NON_BINARY]: 'Non-binary',
  [GENDERS.PREFER_NOT_TO_SAY]: 'Prefer not to say',
});

/** The password checklist the signup and reset screens show (GET /api/auth/password-policy). */
export const PASSWORD_CHECKLIST_LABELS = Object.freeze({
  minimumLength: `At least ${USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH} characters`,
  uppercaseLetter: 'One uppercase letter (A-Z)',
  lowercaseLetter: 'One lowercase letter (a-z)',
  digit: 'One number (0-9)',
  specialCharacter: 'One symbol (for example @ $ # !)',
});

/** Words for the strength meter, by how many checklist items a password meets (PASSWORD_STRENGTH_LEVELS). */
export const PASSWORD_STRENGTH_LABELS = Object.freeze({
  weak: 'Weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong',
});

/** The dashboard (controllers/dashboardController.js). */
export const DASHBOARD_MESSAGES = Object.freeze({
  OVERVIEW_RETRIEVED: 'Dashboard',
  RANGE_INVALID: 'Choose today, the last 7 days or the last 30 days',
});

/** The dashboard's range picker, in order (GET /api/dashboard/overview `ranges`). */
export const DASHBOARD_RANGE_LABELS = Object.freeze({
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
});

/** The service health check (controllers/systemController.js). */
export const SYSTEM_HEALTH_MESSAGES = Object.freeze({
  RETRIEVED: 'Service health',
  ADMIN_ONLY: 'Only administrators can see the health of the services',
});

/** What each checked service is called on the dashboard's "Connected services" card. */
export const SYSTEM_SERVICE_LABELS = Object.freeze({
  aiService: 'AI service',
  email: 'Email delivery',
  database: 'Database',
  cache: 'Cache',
});

/** How each service's state reads, and what not being set up means for it. */
export const SYSTEM_STATUS_LABELS = Object.freeze({
  operational: 'Operational',
  degraded: 'Slow',
  down: 'Down',
  not_configured: 'Not set up',
});

/** Onboarding offers (controllers/onboardingController.js). */
export const ONBOARDING_MESSAGES = Object.freeze({
  HR_ONLY: 'Only HR, Finance & Payroll and administrators can see offers',
  OFFER_MANAGERS_ONLY: 'Only HR and administrators can prepare, change and send offers',
  COMPENSATION_MANAGERS_ONLY: 'Only HR, Finance & Payroll and administrators can work out salary structures',
  CALCULATED: 'Salary structure',
  SETTINGS_RETRIEVED: 'Onboarding settings',
  SETTINGS_UPDATED: 'Onboarding settings saved',
  SETTINGS_CHANGED_ELSEWHERE: 'Someone else changed these settings a moment ago. Reload to see their changes',
  DRAFT_CREATED: 'Offer draft saved for review',
  DRAFTS_RETRIEVED: 'Offer drafts',
  DRAFT_RETRIEVED: 'Offer draft',
  DRAFT_UPDATED: 'Offer draft updated',
  DRAFT_CANCELLED: 'Offer draft cancelled',
  DRAFT_NOT_FOUND: 'Offer draft not found',
  DRAFT_NOT_EDITABLE: 'Only drafts waiting for review can be changed',
  DRAFT_CHANGED_ELSEWHERE: 'Someone else changed this draft a moment ago. Reload to see their changes',
  DRAFT_FIGURES_CHANGED:
    'The salary figures have changed since this draft was saved (the policy or the statutory rules changed). Review the new figures and save the draft again',
  DISPATCHED: `Offer sent. The candidate has ${ONBOARDING_SETTINGS.ACTIVATION_VALIDITY_HOURS} hours to activate their account`,
  DISPATCH_IN_PROGRESS: 'This offer is already being sent',
  DISPATCH_NOT_ALLOWED: 'Only drafts waiting for review, or whose sending failed, can be sent',
  DISPATCH_EMAIL_FAILED: 'The employee record was created, but the offer email could not be sent. Try sending it again',
  SIGNATORY_MISSING: 'Set the offer letter signatory in the onboarding settings before sending offers',
  PDF_UNAVAILABLE: 'Offer letters cannot be produced on this server right now. Contact your administrator',
  CTC_TOO_LOW:
    'This CTC is too low for the company salary policy: Basic, HRA and employer contributions already exceed it',
  INPUT_INVALID: 'Some details need fixing',
  PREVIEW_WATERMARK: 'DRAFT – NOT AN OFFER',
});

/** Department knowledge bases (/api/departments/:departmentId/agent, services/knowledge/*). */
const KNOWLEDGE_MAX_FILE_MB = KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES / (1024 * 1024);

export const KNOWLEDGE_MESSAGES = Object.freeze({
  // Template for a new agent's name: the department's name, then this.
  DEFAULT_AGENT_NAME_SUFFIX: 'Department Agent',
  SETTINGS_RETRIEVED: 'Knowledge base settings',
  KNOWLEDGE_BASES_RETRIEVED: 'Knowledge bases you manage',
  LEAD_CANDIDATES_RETRIEVED: 'People who can lead this knowledge base',
  SETTINGS_UPDATED: 'Knowledge base settings saved',
  DOCUMENTS_RETRIEVED: 'Knowledge base documents',
  DOCUMENT_UPLOADED: 'Document uploaded. It is being read and will be ready for the agent shortly',
  DOCUMENT_DELETED: 'Document removed from the knowledge base',
  ACCESS_DENIED: "Only this department's head, its knowledge lead and administrators can manage its knowledge base",
  LEAD_CHANGE_NOT_ALLOWED: "Only an administrator or the department's head can change the knowledge lead",
  LEAD_NOT_ELIGIBLE: 'The knowledge lead must be an active account of an employee in this department',
  DEPARTMENT_NOT_FOUND: 'Department not found',
  DEPARTMENT_INACTIVE: 'This department is inactive. Reactivate it to manage its knowledge base',
  DOCUMENT_NOT_FOUND: 'Document not found in this knowledge base',
  AGENT_PAUSED: 'This knowledge base is paused. Resume it in the settings to add documents',
  DOCUMENT_LIMIT_REACHED: `A knowledge base holds at most ${KNOWLEDGE_BASE_SETTINGS.MAX_DOCUMENTS_PER_DEPARTMENT} documents. Remove some before adding more`,
  DUPLICATE_DOCUMENT: 'This file is already in the knowledge base',
  FILE_REQUIRED: 'Attach exactly one file in the "file" field',
  FILE_TOO_LARGE: `The file is too large (maximum ${KNOWLEDGE_MAX_FILE_MB} MB)`,
  MULTIPART_REQUIRED: 'Send the upload as multipart/form-data',
  MALFORMED_UPLOAD: 'The upload could not be read. Try again',
  EMPTY_FILE: 'The file is empty',
  UNSUPPORTED_FILE_TYPE: 'Only PDF, Word (.docx), Markdown (.md) and text (.txt) files are accepted',
  EXTENSION_MISMATCH:
    "The file's name does not match its content. Save it with the right extension and upload it again",
  DOCX_TOO_LARGE_UNPACKED: 'This Word document is too large once unpacked. Split it into smaller files',
  INDEX_UNAVAILABLE: 'The document could not be removed from the knowledge index right now. Try again shortly',
  INPUT_INVALID: 'Some details need fixing',
  // Why a document could not be added to the knowledge base, as the lead reads it on the document.
  PROCESSING_FAILURES: Object.freeze({
    ENCRYPTED: 'This PDF is password-protected. Upload a copy without a password',
    CORRUPT: 'This file could not be read. It may be damaged; try saving it again and uploading the new copy',
    NO_TEXT:
      'No text was found in this file. Scanned documents are not supported yet: upload a version with selectable text',
    TOO_MANY_PAGES: `This PDF has more than ${KNOWLEDGE_BASE_SETTINGS.PDF_MAX_PAGES} pages. Split it into smaller files`,
    TOO_MUCH_TEXT: 'This file holds more text than one document may. Split it into smaller files',
    TOO_MANY_CHUNKS: 'This file holds more text than one document may. Split it into smaller files',
    TIMED_OUT: 'This file took too long to read. Split it into smaller files, or save it again and retry',
    OUT_OF_MEMORY: 'This file is too complex to read. Split it into smaller files, or save it again and retry',
    FILE_MISSING: 'The stored copy of this file is missing or damaged. Delete it and upload it again',
    INDEX_UNAVAILABLE: 'The knowledge index could not be reached after several attempts. Try again later',
  }),
});

/** Questions to department agents, their conversations, and each department's Questions Inbox. */
export const AGENT_CHAT_MESSAGES = Object.freeze({
  AGENTS_RETRIEVED: 'Department agents you can ask',
  ANSWERED: 'The agent answered',
  CONVERSATIONS_RETRIEVED: 'Your conversations with this agent',
  CONVERSATION_RETRIEVED: 'Conversation',
  CONVERSATION_DELETED: 'Conversation deleted',
  CONVERSATIONS_CLEARED: 'Your conversations with this agent were deleted',
  FEEDBACK_SAVED: 'Thanks for your feedback',
  FEEDBACK_ESCALATED: 'Thanks for your feedback. Your question was sent to the department',
  QUESTIONS_RETRIEVED: 'Questions for this department',
  QUESTION_ANSWERED: 'Answer sent',
  QUESTION_DISMISSED: 'Question closed',
  FAQ_SAVED: 'Saved as an FAQ. The agent can use it once it is processed',
  INPUT_INVALID: 'Some details need fixing',
  ASK_DENIED: "This agent answers questions from its department's people only",
  ASK_NOT_ALLOWED: 'Your role cannot ask department agents',
  NO_EMPLOYEE_PROFILE: 'Department agents answer employees. Your account is not linked to an employee record',
  DEPARTMENT_NOT_FOUND: 'Department not found',
  AGENT_UNAVAILABLE: "This department's agent is not available right now",
  AGENT_NOT_READY: "This department's agent has no documents to answer from yet",
  AI_UNAVAILABLE: 'The agent could not answer right now. Please try again in a moment',
  STREAM_FAILED: 'Something went wrong while answering. Please try again',
  DAILY_LIMIT_REACHED: (limit) =>
    `You have asked ${limit} questions today, the daily limit. You can ask again tomorrow (UTC)`,
  CONVERSATION_NOT_FOUND: 'Conversation not found',
  MESSAGE_NOT_FOUND: 'Answer not found',
  QUESTION_NOT_FOUND: 'Question not found in this department',
  QUESTION_CLOSED: 'This question has already been closed',
  QUESTION_NOT_ANSWERED: 'Answer the question before saving it as an FAQ',
  FAQ_ALREADY_SAVED: 'This question is already saved as an FAQ',
  // What the employee reads when the agent did not answer; their question went to the department.
  REPLY_NOT_FOUND: (departmentName) =>
    `I couldn't find this in the ${departmentName} knowledge base, so I sent your question to the ${departmentName} team. You'll be notified when they reply.`,
  REPLY_REFUSED: (departmentName) =>
    `I couldn't find a reliable answer to this in the ${departmentName} knowledge base, so I sent your question to the ${departmentName} team. You'll be notified when they reply.`,
});

/** In-app notifications. */
export const NOTIFICATION_MESSAGES = Object.freeze({
  RETRIEVED: 'Notifications',
  MARKED_READ: 'Marked as read',
  ALL_MARKED_READ: 'All notifications marked as read',
  NOT_FOUND: 'Notification not found',
  INPUT_INVALID: 'Some details need fixing',
  QUESTION_RECEIVED_TITLE: (departmentName) => `New question for ${departmentName}`,
  QUESTION_RECEIVED_BODY: (askerName, agentName) => `${askerName} asked ${agentName} something it could not answer`,
  QUESTION_DOWNVOTED_BODY: (askerName, agentName) => `${askerName} found an answer from ${agentName} unhelpful`,
  QUESTION_ANSWERED_TITLE: (departmentName) => `${departmentName} answered your question`,
  QUESTION_ANSWERED_BODY: (leadName) => `${leadName} replied to the question you asked the department's agent`,
  TASK_ASSIGNED_TITLE: (taskKey) => `${taskKey} was assigned to you`,
  TASK_ASSIGNED_BODY: (assignerName, taskTitle) => `${assignerName} assigned you "${taskTitle}"`,
});

/** Department task boards: sprints, tasks, comments and team leads. */
export const TASK_MESSAGES = Object.freeze({
  BOARD_RETRIEVED: 'Task board',
  BOARDS_RETRIEVED: 'Task boards you can open',
  LEADS_UPDATED: 'Task leads saved',
  SPRINTS_RETRIEVED: 'Sprints',
  SPRINT_CREATED: 'Sprint created',
  SPRINT_UPDATED: 'Sprint saved',
  TASKS_RETRIEVED: 'Tasks',
  TASK_RETRIEVED: 'Task',
  TASK_CREATED: 'Task created',
  TASK_UPDATED: 'Task saved',
  COMMENT_ADDED: 'Comment added',
  METRICS_RETRIEVED: 'Team work',
  INPUT_INVALID: 'Some details need fixing',
  NOT_ALLOWED: 'Task boards are not available to your role',
  DEPARTMENT_NOT_FOUND: 'Department not found',
  NOT_A_MEMBER: "Only this department's people can see its task board",
  LEADS_ONLY: "Only this department's head and task leads can do this",
  HEAD_ONLY: "Only this department's head or an administrator can choose its task leads",
  LEAD_NOT_A_MEMBER: 'Task leads must be people in this department',
  ASSIGNEE_NOT_A_MEMBER: 'Tasks can only be assigned to people in this department',
  SPRINT_NOT_FOUND: 'Sprint not found in this department',
  SPRINT_COMPLETED: 'This sprint is completed; it takes no more tasks',
  SPRINT_ALREADY_ACTIVE: 'Another sprint is active. Complete it before starting this one',
  SPRINT_TRANSITION_NOT_ALLOWED: 'A sprint goes from planning to active to completed, in that order',
  SPRINT_DATES_INVALID: `A sprint ends on or after its start, and lasts at most ${TASK_SETTINGS.SPRINT_MAX_DAYS} days`,
  TASK_NOT_FOUND: 'Task not found in this department',
  TASK_EDIT_NOT_ALLOWED: 'You can change tasks you reported or are assigned to',
  TASK_STATUS_NOT_ALLOWED: 'You can move tasks assigned to you; the task leads can move any task',
  TASK_SPRINT_NOT_ALLOWED:
    'Only the task leads plan sprints; you can bring a backlog task assigned to you into the active sprint',
  TASK_DONE_NEEDS_REVIEW: 'A task is marked done from In review. Move it to In review first',
  TASK_DONE_NOT_ALLOWED: 'Only the task leads or the person who reported a task can mark it done',
});
