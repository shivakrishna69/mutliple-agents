/**
 * Validation for the onboarding offer endpoints (/api/hr/onboarding). Pure functions returning
 * { isValid, validationErrors, sanitizedInput } (validators/requestShape.js).
 *
 * An offer is the candidate and position an HR invitation takes (validators/peopleValidators.js,
 * the single source of those rules), plus the candidate's date of birth (at least 18 years old, as
 * at signup; it also opens the final letter), their gender (optional; Maharashtra's professional
 * tax depends on it), the compensation inputs of services/ctcStructure.js (CTC, variable pay, the
 * Basic, HRA and special allowance HR sets, if any) with the stock options granted, and the offer's
 * own terms (probation, notice, acceptance deadline; the settings' when left out). Values the models
 * already check (settings numbers and limits) are left to them.
 */

import { ONBOARDING_SETTINGS } from '../constants/validation.js';
import { addDaysToCalendarDate, isRealCalendarDate } from '../utils/calendarDates.js';
import { ROLES } from '../models/User.js';
import { PROFESSIONAL_TAX_STATES, TAX_REGIMES } from '../utils/payroll/rules.js';
import { readBirthDate, readGender } from './authValidators.js';
import { validateInvitationInput } from './peopleValidators.js';
import {
  bodyNotObjectResult,
  checkVersion,
  hasChanges,
  isPlainObject,
  pickShapedFields,
  validationResult,
} from './requestShape.js';

const { CTC_LIMITS, WORK_CITY_MAX_LENGTH, VARIABLE_PAY_MAX_BASIS_POINTS, ESOP_UNITS_MAX, OFFER_TERM_LIMITS } =
  ONBOARDING_SETTINGS;
const BASIS_POINTS = 10_000;
const COMPONENT_FIELDS = Object.freeze(['basicAnnual', 'hraAnnual', 'specialAllowanceAnnual']);
const WORK_CITY_MIN_LENGTH = 2;

const SETTINGS_FIELDS = Object.freeze(['compensation', 'offerTerms']);
const SETTINGS_GROUPS = Object.freeze({
  compensation: Object.freeze([
    'basicShareBasisPoints',
    'hraFiftyPercentCityBasisPoints',
    'hraOtherCityBasisPoints',
    'pfOnFullBasic',
    'includeGratuityInCtc',
  ]),
  offerTerms: Object.freeze([
    'probationMonths',
    'noticePeriodDays',
    'weeklyWorkingHours',
    'offerValidityDays',
    'signatoryName',
    'signatoryTitle',
    'additionalClauses',
    'shiftTimings',
    'confidentialityClause',
    'ipAssignmentClause',
    'nonSolicitationClause',
    'nonSolicitationMonths',
    'esopNote',
    'joiningChecklist',
  ]),
});
const SETTINGS_SWITCHES = Object.freeze(['pfOnFullBasic', 'includeGratuityInCtc']);

/** The compensation inputs; problems are added to `validationErrors`. */
function readCompensation(body, validationErrors) {
  const fail = (field, message) => validationErrors.push({ field, message });
  const { annualCtc, workCity } = body;
  const taxRegime = body.taxRegime ?? TAX_REGIMES.NEW;
  if (!Number.isInteger(annualCtc) || annualCtc < CTC_LIMITS.MIN || annualCtc > CTC_LIMITS.MAX) {
    fail('annualCtc', `must be whole rupees from ${CTC_LIMITS.MIN} to ${CTC_LIMITS.MAX}`);
  }
  if (!Object.values(TAX_REGIMES).includes(taxRegime)) {
    fail('taxRegime', `must be one of ${Object.values(TAX_REGIMES).join(', ')}`);
  }
  const trimmedCity = typeof workCity === 'string' ? workCity.trim() : '';
  if (trimmedCity.length < WORK_CITY_MIN_LENGTH || trimmedCity.length > WORK_CITY_MAX_LENGTH) {
    fail('workCity', `must be a city name of ${WORK_CITY_MIN_LENGTH}-${WORK_CITY_MAX_LENGTH} characters`);
  }
  if (!Object.values(PROFESSIONAL_TAX_STATES).includes(body.professionalTaxState)) {
    fail('professionalTaxState', `must be one of ${Object.values(PROFESSIONAL_TAX_STATES).join(', ')}`);
  }
  const isWholeAmount = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum;
  const variablePayAnnual = body.variablePayAnnual ?? 0;
  const variableMaximum = Number.isInteger(annualCtc)
    ? Math.floor((annualCtc * VARIABLE_PAY_MAX_BASIS_POINTS) / BASIS_POINTS)
    : 0;
  if (!isWholeAmount(variablePayAnnual, variableMaximum)) {
    fail('variablePayAnnual', `must be whole rupees, at most ${VARIABLE_PAY_MAX_BASIS_POINTS / 100}% of the CTC`);
  }
  const esopUnits = body.esopUnits ?? 0;
  if (!isWholeAmount(esopUnits, ESOP_UNITS_MAX)) fail('esopUnits', `must be a whole number up to ${ESOP_UNITS_MAX}`);
  const components = Object.fromEntries(COMPONENT_FIELDS.map((field) => [field, null]));
  if (body.components !== undefined && body.components !== null) {
    if (!isPlainObject(body.components)) {
      fail('components', 'must be an object of annual amounts');
    } else {
      for (const [field, value] of Object.entries(body.components)) {
        if (!COMPONENT_FIELDS.includes(field)) fail(`components.${field}`, 'is not a component that can be set');
        else if (value === null || value === undefined) continue;
        else if (!isWholeAmount(value, annualCtc))
          fail(`components.${field}`, 'must be whole rupees a year, within the CTC');
        else components[field] = value;
      }
    }
  }
  return {
    annualCtc,
    taxRegime,
    workCity: trimmedCity,
    professionalTaxState: body.professionalTaxState,
    variablePayAnnual,
    esopUnits,
    components,
  };
}

/**
 * The offer's own terms, each optional (null: the settings' value); problems are added to
 * `validationErrors`. The acceptance deadline is a date after today, within the longest validity.
 */
function readOfferTerms(body, validationErrors, now) {
  const fail = (field, message) => validationErrors.push({ field, message });
  const terms = body.terms ?? {};
  if (!isPlainObject(terms)) {
    fail('terms', 'must be an object');
    return { probationMonths: null, noticePeriodDays: null, offerValidUntil: null };
  }
  const wholeNumberOrNull = (field, maximum) => {
    const value = terms[field] ?? null;
    if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= maximum)) {
      fail(`terms.${field}`, `must be a whole number from 0 to ${maximum}`);
    }
    return value;
  };
  const probationMonths = wholeNumberOrNull('probationMonths', OFFER_TERM_LIMITS.PROBATION_MONTHS_MAX);
  const noticePeriodDays = wholeNumberOrNull('noticePeriodDays', OFFER_TERM_LIMITS.NOTICE_PERIOD_DAYS_MAX);
  const deadline = terms.offerValidUntil ?? null;
  const today = now.toISOString().slice(0, 10);
  const latest = addDaysToCalendarDate(today, OFFER_TERM_LIMITS.OFFER_VALIDITY_DAYS_MAX);
  if (deadline !== null && !(isRealCalendarDate(deadline) && deadline > today && deadline <= latest)) {
    fail(
      'terms.offerValidUntil',
      `must be a date (YYYY-MM-DD) after today, at most ${OFFER_TERM_LIMITS.OFFER_VALIDITY_DAYS_MAX} days ahead`,
    );
  }
  return {
    probationMonths,
    noticePeriodDays,
    offerValidUntil: deadline === null ? null : new Date(`${deadline}T00:00:00Z`),
  };
}

/**
 * POST /calculate, POST /create-draft and PATCH /drafts/:id: the whole offer.
 * @param {object} requestBody
 * @param {{ now?: Date }} [options]
 */
export function validateOfferInput(requestBody, { now = new Date() } = {}) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const invitation = validateInvitationInput({ ...requestBody, role: requestBody.role ?? ROLES.EMPLOYEE });
  const validationErrors = invitation.isValid ? [] : [...invitation.validationErrors];
  const birthDate = readBirthDate(requestBody.dateOfBirth, true, now);
  if (birthDate.error) validationErrors.push({ field: 'dateOfBirth', message: birthDate.error });
  const genderChoice = readGender(requestBody.gender, false);
  if (genderChoice.error) validationErrors.push({ field: 'gender', message: genderChoice.error });
  const compensation = readCompensation(requestBody, validationErrors);
  const terms = readOfferTerms(requestBody, validationErrors, now);
  // Maharashtra's professional tax has different slabs for women and men.
  if (
    compensation.professionalTaxState === PROFESSIONAL_TAX_STATES.MAHARASHTRA &&
    !genderChoice.gender &&
    !genderChoice.error
  ) {
    validationErrors.push({ field: 'gender', message: 'is needed for Maharashtra professional tax' });
  }
  if (validationErrors.length > 0) return validationResult(validationErrors);

  const { name, email, companyEmail, role, profileDraft } = invitation.sanitizedInput;
  return validationResult([], {
    candidate: { name, personalEmail: email, companyEmail, dateOfBirth: birthDate.date, gender: genderChoice.gender },
    position: { role, ...profileDraft },
    compensation,
    terms,
    includePreview: requestBody.includePreview === true,
  });
}

/** PATCH /drafts/:id: the whole offer again, and the version it was based on. */
export function validateOfferEdit(requestBody, options) {
  const offer = validateOfferInput(requestBody, options);
  const validationErrors = offer.isValid ? [] : [...offer.validationErrors];
  const version = checkVersion(requestBody?.version, validationErrors);
  return validationResult(validationErrors, offer.isValid ? { ...offer.sanitizedInput, version } : undefined);
}

/** POST /drafts/:id/cancel: the version it was based on. */
export function validateVersionOnly(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { version });
}

/** PATCH /settings: the groups and fields that may change, and the version they were based on. */
export function validateSettingsChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const changes = pickShapedFields(requestBody, SETTINGS_FIELDS, SETTINGS_GROUPS, validationErrors);
  // The model would turn "yes" or 1 into true; a switch must be sent as a switch.
  for (const switchName of SETTINGS_SWITCHES) {
    const value = changes.compensation?.[switchName];
    if (value !== undefined && typeof value !== 'boolean') {
      validationErrors.push({ field: `compensation.${switchName}`, message: 'must be true or false' });
    }
  }
  for (const listName of ['additionalClauses', 'joiningChecklist']) {
    const items = changes.offerTerms?.[listName];
    if (items !== undefined && (!Array.isArray(items) || !items.every((item) => typeof item === 'string'))) {
      validationErrors.push({ field: `offerTerms.${listName}`, message: 'must be a list of texts' });
    }
  }
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}
