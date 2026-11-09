/**
 * Validation for the onboarding offer endpoints (/api/hr/onboarding). Pure functions returning
 * { isValid, validationErrors, sanitizedInput } (validators/requestShape.js).
 *
 * An offer is the candidate and position an HR invitation takes (validators/peopleValidators.js,
 * the single source of those rules), plus the candidate's date of birth (at least 18 years old, as
 * at signup; it also opens the final letter), their gender (optional; Maharashtra's professional
 * tax depends on it), and the compensation inputs of services/ctcStructure.js. Values the models
 * already check (settings numbers and limits) are left to them.
 */

import { ONBOARDING_SETTINGS } from '../constants/validation.js';
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

const { CTC_LIMITS, WORK_CITY_MAX_LENGTH } = ONBOARDING_SETTINGS;
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
  return { annualCtc, taxRegime, workCity: trimmedCity, professionalTaxState: body.professionalTaxState };
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
  const clauses = changes.offerTerms?.additionalClauses;
  if (clauses !== undefined && (!Array.isArray(clauses) || !clauses.every((clause) => typeof clause === 'string'))) {
    validationErrors.push({ field: 'offerTerms.additionalClauses', message: 'must be a list of texts' });
  }
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}
