/**
 * Employee CSV import (components/people/EmployeeImportPanel.jsx). The columns and limits mirror
 * the backend (services/employeeImportParser.js IMPORT_COLUMNS, constants/validation.js
 * EMPLOYEE_IMPORT_LIMITS), which checks every file whatever this page lets through.
 */

/** The template's header row, in the backend's column order. */
export const IMPORT_TEMPLATE_COLUMNS = Object.freeze([
  'name',
  'personal_email',
  'company_email',
  'department_code',
  'department_name',
  'designation',
  'role',
  'manager_email',
  'date_of_joining',
  'work_type',
  'employment_status',
  'office_code',
]);

/** Two made-up rows showing a manager and someone reporting to them. */
export const IMPORT_TEMPLATE_EXAMPLE_ROWS = Object.freeze([
  [
    'Asha Example',
    'asha.example@example.com',
    '',
    'ENG',
    'Engineering',
    'Engineering Manager',
    'employee',
    '',
    '2026-11-02',
    'Onsite',
    'Active',
    '',
  ],
  [
    'Ravi Example',
    'ravi.example@example.com',
    '',
    'ENG',
    '',
    'Software Engineer',
    'employee',
    'asha.example@example.com',
    '2026-11-02',
    'Hybrid',
    'Probation',
    '',
  ],
]);

export const IMPORT_TEMPLATE_FILE_NAME = 'employee-import-template.csv';

/** What each column takes, shown next to the upload. */
export const IMPORT_COLUMN_GUIDE = Object.freeze([
  { column: 'name, personal_email, department_code, designation, date_of_joining', meaning: 'Required' },
  { column: 'company_email', meaning: 'Leave blank to get first.last@ your company domain' },
  { column: 'department_name', meaning: 'Only for a new department code: it is created with this name' },
  { column: 'role', meaning: 'employee (default), hr or agent' },
  { column: 'manager_email', meaning: 'Their manager: someone already here, or earlier in the same file' },
  { column: 'work_type', meaning: 'Onsite (default), Remote or Hybrid' },
  { column: 'employment_status', meaning: 'Probation (default) or Active' },
  { column: 'date_of_joining', meaning: 'YYYY-MM-DD' },
]);

export const IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How often a running import is checked. */
export const IMPORT_POLL_INTERVAL_MS = 2_000;

export const IMPORT_JOB_STATUS_DISPLAY = Object.freeze({
  validated: { label: 'Checked, not started', tone: 'amber' },
  queued: { label: 'Waiting to start', tone: 'sky' },
  running: { label: 'Importing', tone: 'brand' },
  completed: { label: 'Finished', tone: 'emerald' },
});

/** Statuses during which the import is still working. */
export const IMPORT_ACTIVE_STATUSES = Object.freeze(['queued', 'running']);

export const IMPORT_ROW_STATUS_DISPLAY = Object.freeze({
  invalid: { label: 'Not imported', tone: 'rose' },
  pending: { label: 'Waiting', tone: 'amber' },
  processing: { label: 'In progress', tone: 'sky' },
  created: { label: 'Invited', tone: 'emerald' },
  failed: { label: 'Failed', tone: 'rose' },
});

/** Invitation delivery outcomes (backend services/mailService.js). */
export const IMPORT_DELIVERY_DISPLAY = Object.freeze({
  sent: 'Emailed',
  not_configured: 'Share the link',
  failed: 'Email failed: share the link',
});
