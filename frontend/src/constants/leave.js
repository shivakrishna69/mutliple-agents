/**
 * Display data for leave. Values mirror the backend (backend/models/LeaveType.js,
 * models/LeaveLedgerEntry.js, constants/validation.js LEAVE_LIMITS); the backend validates every
 * change, so these only label things and shape the forms.
 */

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
