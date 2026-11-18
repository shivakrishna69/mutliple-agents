/**
 * The offer settings form (components/offers/OfferSettingsDialog.jsx) and the backend's settings
 * (GET/PATCH /api/hr/onboarding/settings): rates are basis points there (5000 = 50%) and percentages
 * here; lists are one item per line here. Only the groups this person may change, and only the fields
 * that changed, go in the request; the backend checks every value again.
 */

const BASIS_POINTS_PER_PERCENT = 100;

export const TERM_NUMBER_FIELDS = Object.freeze([
  'probationMonths',
  'noticePeriodDays',
  'offerValidityDays',
  'weeklyWorkingHours',
  'nonSolicitationMonths',
]);
export const TERM_OPTIONAL_TEXT_FIELDS = Object.freeze(['signatoryName', 'signatoryTitle', 'shiftTimings', 'esopNote']);
export const TERM_CLAUSE_FIELDS = Object.freeze([
  'confidentialityClause',
  'ipAssignmentClause',
  'nonSolicitationClause',
  'backgroundVerificationClause',
]);
export const TERM_LIST_FIELDS = Object.freeze(['additionalClauses', 'joiningChecklist']);
export const COMPENSATION_RATE_FIELDS = Object.freeze([
  'basicShareBasisPoints',
  'hraFiftyPercentCityBasisPoints',
  'hraOtherCityBasisPoints',
]);
export const COMPENSATION_SWITCH_FIELDS = Object.freeze(['pfOnFullBasic', 'includeGratuityInCtc']);

const toPercentText = (basisPoints) => String(basisPoints / BASIS_POINTS_PER_PERCENT);
const toBasisPoints = (percentText) => {
  const percent = Number(percentText);
  return percentText.trim() === '' || !Number.isFinite(percent)
    ? percentText
    : Math.round(percent * BASIS_POINTS_PER_PERCENT);
};
// A number field the person cleared or mistyped goes as typed, so the backend names the problem.
const toWholeNumber = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : text);
const linesOf = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** The form's values for the settings the backend returned. */
export function settingsFormFrom(settings) {
  const { offerTerms: terms, compensation } = settings;
  return {
    offerTerms: {
      ...Object.fromEntries(TERM_NUMBER_FIELDS.map((field) => [field, String(terms[field] ?? '')])),
      ...Object.fromEntries(TERM_OPTIONAL_TEXT_FIELDS.map((field) => [field, terms[field] ?? ''])),
      ...Object.fromEntries(TERM_CLAUSE_FIELDS.map((field) => [field, terms[field] ?? ''])),
      ...Object.fromEntries(TERM_LIST_FIELDS.map((field) => [field, (terms[field] ?? []).join('\n')])),
    },
    compensation: {
      ...Object.fromEntries(COMPENSATION_RATE_FIELDS.map((field) => [field, toPercentText(compensation[field])])),
      ...Object.fromEntries(COMPENSATION_SWITCH_FIELDS.map((field) => [field, Boolean(compensation[field])])),
    },
  };
}

/** The backend's values for the form's offer terms. */
function termsFromForm(form) {
  return {
    ...Object.fromEntries(TERM_NUMBER_FIELDS.map((field) => [field, toWholeNumber(form[field])])),
    ...Object.fromEntries(TERM_OPTIONAL_TEXT_FIELDS.map((field) => [field, form[field].trim() || null])),
    ...Object.fromEntries(TERM_CLAUSE_FIELDS.map((field) => [field, form[field].trim()])),
    ...Object.fromEntries(TERM_LIST_FIELDS.map((field) => [field, linesOf(form[field])])),
  };
}

/** The backend's values for the form's compensation policy. */
function compensationFromForm(form) {
  return {
    ...Object.fromEntries(COMPENSATION_RATE_FIELDS.map((field) => [field, toBasisPoints(form[field])])),
    ...Object.fromEntries(COMPENSATION_SWITCH_FIELDS.map((field) => [field, form[field]])),
  };
}

/** Only the fields whose value differs from the saved one. */
function changedFields(next, saved) {
  return Object.fromEntries(
    Object.entries(next).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(saved[field] ?? null)),
  );
}

/**
 * The PATCH body for what changed in the groups this person may change, or null when nothing did.
 * @param {object} form  settingsFormFrom's shape, as edited
 * @param {{ offerTerms: object, compensation: object, version: number }} settings  as loaded
 * @param {{ canEditTerms: boolean, canEditCompensation: boolean }} permissions
 */
export function settingsChangeRequest(form, settings, { canEditTerms, canEditCompensation }) {
  const request = { version: settings.version };
  if (canEditTerms) {
    const terms = changedFields(termsFromForm(form.offerTerms), settings.offerTerms);
    if (Object.keys(terms).length > 0) request.offerTerms = terms;
  }
  if (canEditCompensation) {
    const compensation = changedFields(compensationFromForm(form.compensation), settings.compensation);
    if (Object.keys(compensation).length > 0) request.compensation = compensation;
  }
  return request.offerTerms || request.compensation ? request : null;
}
