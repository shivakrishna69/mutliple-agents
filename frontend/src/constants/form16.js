/**
 * How the Form 16 portal names things (backend models/Form16Record.js, services/tax/form16Service.js).
 * Stored values are the backend's; only the labels live here.
 */

export const FORM16_PART_TYPES = Object.freeze({
  CONSOLIDATED: 'CONSOLIDATED',
  PART_A: 'PART_A',
  PART_B: 'PART_B',
});

export const FORM16_PART_LABELS = Object.freeze({
  [FORM16_PART_TYPES.CONSOLIDATED]: 'Part A + Part B',
  [FORM16_PART_TYPES.PART_A]: 'Part A (TDS certificate)',
  [FORM16_PART_TYPES.PART_B]: 'Part B (salary and tax computation)',
});

export const FORM16_LIST_STATUSES = Object.freeze({ UPLOADED: 'uploaded', PENDING: 'pending' });

export const FORM16_STATUS_DISPLAY = Object.freeze({
  [FORM16_LIST_STATUSES.UPLOADED]: { label: 'Uploaded', tone: 'emerald' },
  [FORM16_LIST_STATUSES.PENDING]: { label: 'Pending', tone: 'amber' },
});

export const FORM16_TAX_REGIME_LABELS = Object.freeze({ old: 'Old regime', new: 'New regime' });

/** The computation summary's figures, in the order they are shown and entered. */
export const FORM16_SUMMARY_AMOUNTS = Object.freeze([
  { field: 'grossSalary', label: 'Gross salary' },
  { field: 'totalDeductions', label: 'Total deductions' },
  { field: 'taxableIncome', label: 'Taxable income' },
  { field: 'totalTaxPayable', label: 'Total tax payable' },
  { field: 'tdsDeducted', label: 'TDS deducted' },
]);

/** The CTC split lines from the employee's offer, in order. */
export const FORM16_CTC_SPLIT_LINES = Object.freeze([
  { field: 'basic', label: 'Basic' },
  { field: 'hra', label: 'HRA' },
  { field: 'specialAllowance', label: 'Special allowance' },
  { field: 'gross', label: 'Gross salary', isTotal: true },
  { field: 'employerProvidentFund', label: 'Employer PF' },
  { field: 'employerEsi', label: 'Employer ESI' },
  { field: 'gratuity', label: 'Gratuity' },
  { field: 'variablePay', label: 'Variable pay' },
]);

/** The threshold the portal works with, for labels (the backend applies it). */
export const FORM16_CTC_THRESHOLD_LABEL = '₹12L';
