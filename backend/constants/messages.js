/**
 * Every client-facing message the auth flow can return. Controllers, validators, and
 * middleware reference these constants instead of writing strings inline, so wording
 * is reviewed in one place and the frontend can rely on stable text.
 */

import { MESSAGE_FIELD_LIMITS, USER_FIELD_LIMITS, WEBHOOK_FIELD_LIMITS } from './validation.js';

export const AUTH_MESSAGES = Object.freeze({
  REGISTRATION_SUCCESSFUL: 'Account created successfully',
  LOGIN_SUCCESSFUL: 'Logged in successfully',
  LOGOUT_SUCCESSFUL: 'Logged out successfully',
  CURRENT_USER_RETRIEVED: 'Session is active',
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
  CSRF_TOKEN_INVALID: 'Missing or invalid CSRF token',
});

export const RATE_LIMIT_MESSAGES = Object.freeze({
  TOO_MANY_LOGIN_ATTEMPTS: 'Too many sign-in attempts. Please wait a few minutes and try again',
  TOO_MANY_SIGNUP_ATTEMPTS: 'Too many accounts created from this network. Please try again later',
  TOO_MANY_SUPPORT_MESSAGES: 'You are sending messages too quickly. Please wait a moment and try again',
  TOO_MANY_VAULT_UPLOADS: 'Too many document uploads. Please wait a few minutes and try again',
  TOO_MANY_VAULT_DOWNLOADS: 'Too many download requests. Please wait a moment and try again',
  TOO_MANY_PUNCH_ATTEMPTS: 'Too many punch attempts. Please wait a minute and try again',
  TOO_MANY_REGULARIZATION_MESSAGES: 'Too many attendance correction messages. Please wait a minute and try again',
  TOO_MANY_TAX_ESTIMATES: 'Too many tax estimates. Please wait a minute and try again',
  TOO_MANY_PAYSLIP_GENERATIONS: 'Too many payslips generated in a short time. Please wait a minute and try again',
  TOO_MANY_VERIFICATIONS: 'Too many verification requests. Please wait a minute and try again',
  TOO_MANY_INVITATIONS: 'Too many invitations sent. Please wait a few minutes and try again',
  TOO_MANY_INVITATION_ATTEMPTS: 'Too many attempts. Please wait a few minutes and try again',
  TOO_MANY_OKR_UPDATES: 'Too many OKR updates in a short time. Please wait a moment and try again',
  TOO_MANY_LEAVE_ADMIN_UPDATES: 'Too many leave changes in a short time. Please wait a moment and try again',
  TOO_MANY_LEAVE_ASSISTANT_MESSAGES: 'Too many questions to the leave assistant in a short time. Please wait a moment',
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
});

export const ACCOUNT_MESSAGES = Object.freeze({
  PASSWORD_CHANGED: 'Password changed. Other devices have been signed out',
  CURRENT_PASSWORD_INCORRECT: 'The current password is incorrect',
});

export const ADMIN_MESSAGES = Object.freeze({
  ADMINS_ONLY: 'Only administrators can do this',
  USERS_RETRIEVED: 'Users retrieved',
  ROLE_UPDATED: 'Role updated',
  ROLE_UNCHANGED: 'The user already has this role',
  USER_NOT_FOUND: 'User not found',
  INVALID_USER_ID: 'User id is not valid',
  INVALID_ROLE: 'Role must be admin, agent, hr, or customer',
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
  GEOFENCE_NOT_CONFIGURED: 'Your attendance geofence has not been set up yet. Contact HR before punching in',
  LOCATION_TOO_IMPRECISE:
    'Your location is not precise enough to confirm you are at the office. Turn on GPS / precise location and try again',
  DEVICE_NOT_RECOGNISED: 'This device is not registered for your attendance. Use your registered device or contact HR',
  UNAUTHORIZED_SPATIAL_LOCATION: 'Unauthorized Spatial Location: you are outside the area allowed for punching in',
  ALREADY_PUNCHED_IN: 'You have already punched in today',
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
  PAYSLIP_MANAGERS_ONLY: 'Only HR and administrators can issue payslips',
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
