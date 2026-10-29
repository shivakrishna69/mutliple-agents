/**
 * Display data for leave. Values mirror the backend (backend/models/LeaveType.js,
 * models/LeaveLedgerEntry.js, constants/validation.js LEAVE_LIMITS); the backend validates every
 * change, so these only label things and shape the forms.
 */

import { formatCalendarDate } from '../utils/dates.js';

/** Mirrors LEAVE_LIMITS: notes, single movements, and policy days in half-day steps. */
export const LEAVE_FIELD_LIMITS = Object.freeze({
  NOTE_MIN_LENGTH: 3,
  NOTE_MAX_LENGTH: 500,
  MAX_SINGLE_MOVEMENT_DAYS: 365,
  POLICY_DAY_STEP: 0.5,
  MAX_POLICY_DAYS: 365,
  TYPE_CODE_PATTERN: '^[A-Z][A-Z0-9_]{1,19}$',
});

export const ACCRUAL_METHOD_OPTIONS = Object.freeze([
  { value: 'MONTHLY', label: 'Monthly, a twelfth of the quota each month' },
  { value: 'UPFRONT_YEARLY', label: 'Whole quota at the start of the leave year' },
  { value: 'NONE', label: 'No accrual (HR grants it per person)' },
]);

export const ACCRUAL_TIMING_OPTIONS = Object.freeze([
  { value: 'START_OF_MONTH', label: 'At the start of each month' },
  { value: 'END_OF_MONTH', label: 'At the end of each month (earned by working it)' },
]);

/** Steps a joiner's part-year credit may be rounded to. */
export const PRO_RATA_STEP_OPTIONS = Object.freeze([
  { value: '0.25', label: 'Quarter day' },
  { value: '0.5', label: 'Half day' },
  { value: '1', label: 'Whole day' },
]);

export const YEAR_END_EXCESS_OPTIONS = Object.freeze([
  { value: 'LAPSE', label: 'Lapse' },
  { value: 'ENCASH', label: 'Encash through payroll' },
]);

/** Statuses a leave type may be offered to (Terminated never; mirrors EMPLOYMENT_STATUSES). */
export const ELIGIBLE_STATUS_OPTIONS = Object.freeze(['Probation', 'Active', 'Notice']);

/** Adjustments HR may post by hand (mirrors backend HR_ADJUSTMENT_REASON_CODES). */
export const HR_ADJUSTMENT_REASON_OPTIONS = Object.freeze([
  { value: 'MANUAL', label: 'Correction (add or remove days)' },
  { value: 'ENTITLEMENT_GRANT', label: 'Grant an entitlement (e.g. maternity leave)' },
]);

/** Balance breakdown, in the order movements happen during a year (backend MOVEMENT_KINDS). */
export const BALANCE_MOVEMENTS = Object.freeze([
  { key: 'carriedIn', label: 'Carried in' },
  { key: 'accrued', label: 'Accrued' },
  { key: 'adjusted', label: 'Adjusted' },
  { key: 'used', label: 'Used' },
  { key: 'encashed', label: 'Encashed' },
  { key: 'lapsed', label: 'Lapsed' },
  { key: 'carriedOut', label: 'Carried out' },
]);

const ENTRY_TYPE_LABELS = Object.freeze({
  ACCRUAL: 'Accrual',
  HOLD: 'Held for a request',
  CONFIRM_DEBIT: 'Leave taken',
  RELEASE_HOLD: 'Hold released',
  ENCASHMENT: 'Encashed',
});
const REASON_LABELS = Object.freeze({
  MANUAL: 'HR correction',
  ENTITLEMENT_GRANT: 'Entitlement granted',
  CANCELLATION_CREDIT: 'Leave given back',
  LAPSE: 'Lapsed at year end',
});
const YEAR_END_LABELS = Object.freeze({
  CARRY_FORWARD_OUT: 'Carried to next year',
  CARRY_FORWARD_IN: 'Carried in from last year',
  ENCASHMENT: 'Encashed at year end',
});

/** A ledger entry's kind in words. */
export function describeLedgerEntry({ entryType, reasonCode, yearEndKind }) {
  return YEAR_END_LABELS[yearEndKind] ?? REASON_LABELS[reasonCode] ?? ENTRY_TYPE_LABELS[entryType] ?? entryType;
}

const DAYS_FORMATTER = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** 1 -> "1 day", 2.5 -> "2.5 days", -1 -> "-1 day". */
export function formatDays(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return '—';
  return `${DAYS_FORMATTER.format(days)} ${Math.abs(days) === 1 ? 'day' : 'days'}`;
}

/** "+1.25" / "-2" / "0", for ledger columns. */
export function formatSignedDays(days) {
  if (!days) return '0';
  return `${days > 0 ? '+' : ''}${DAYS_FORMATTER.format(days)}`;
}

/** Half-day edges of a leave (mirrors backend constants/calendarDays.js DAY_PORTIONS). */
export const DAY_PORTIONS = Object.freeze({ FULL: 'full', FIRST_HALF: 'first_half', SECOND_HALF: 'second_half' });

/** The first day may start in the afternoon; the last may end at lunch. */
export const START_PORTION_OPTIONS = Object.freeze([
  { value: DAY_PORTIONS.FULL, label: 'Full day' },
  { value: DAY_PORTIONS.SECOND_HALF, label: 'Afternoon only (second half)' },
]);
export const END_PORTION_OPTIONS = Object.freeze([
  { value: DAY_PORTIONS.FULL, label: 'Full day' },
  { value: DAY_PORTIONS.FIRST_HALF, label: 'Morning only (first half)' },
]);

/** How a day of a leave is described (mirrors backend DAY_KINDS). */
export const DAY_KIND_LABELS = Object.freeze({
  working: 'Working day',
  weekly_off: 'Weekly off',
  holiday: 'Holiday',
});

/** Mirrors backend LEAVE_REQUEST_STATUSES. */
export const REQUEST_STATUS_DISPLAY = Object.freeze({
  PENDING: { label: 'Waiting for approval', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'emerald' },
  REJECTED: { label: 'Declined', tone: 'rose' },
  CANCELLED: { label: 'Cancelled', tone: 'slate' },
});

/** Mirrors backend CHANGE_REQUEST_KINDS. */
export const CHANGE_KINDS = Object.freeze({ CANCEL: 'CANCEL', SHORTEN: 'SHORTEN' });

/** Mirrors backend APPROVAL_QUEUES. */
export const APPROVAL_QUEUES = Object.freeze({ REQUESTS: 'requests', CHANGES: 'changes' });

/** The vault document type employees upload to support leave (mirrors backend VAULT_DOCUMENT_TYPES). */
export const LEAVE_DOCUMENT_TYPE = 'Leave_Document';

/** "Mon 3 Nov" or "Mon 3 Nov – Wed 5 Nov", with half days named. */
export function describeLeaveDates({ startDate, startDayPortion, endDate, endDayPortion }) {
  const day = (calendarDate) => formatCalendarDate(calendarDate, { weekday: 'short', day: 'numeric', month: 'short' });
  const startNote = startDayPortion === DAY_PORTIONS.SECOND_HALF ? ' (afternoon)' : '';
  const endNote = endDayPortion === DAY_PORTIONS.FIRST_HALF ? ' (morning)' : '';
  if (startDate === endDate) return `${day(startDate)}${startNote}${endNote}`;
  return `${day(startDate)}${startNote} – ${day(endDate)}${endNote}`;
}

/** Shown when the document vault cannot store files (storage not configured, or failing). */
export const UPLOAD_UNAVAILABLE_MESSAGE =
  'Upload service unavailable. Please select an existing document from your vault.';
export const UPLOAD_UNAVAILABLE_NO_DOCUMENTS_HINT = 'You have none yet, so ask HR to add one to your vault for you.';
