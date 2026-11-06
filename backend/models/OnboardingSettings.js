/**
 * OnboardingSettings: how this company structures and words its offers. One document (key
 * "onboarding"), created with the defaults (ONBOARDING_SETTINGS) on first use and changed by HR or
 * administrators (GET/PATCH /api/hr/onboarding/settings). Saves are versioned, so two people
 * editing at once cannot overwrite each other.
 *
 *   compensation   the salary structure policy services/ctcStructure.js applies: Basic share of
 *                  CTC, HRA share of Basic (50% cities and elsewhere), PF on the whole Basic or up
 *                  to the statutory ceiling, gratuity inside the CTC or not. Rates in basis points.
 *   offerTerms     the offer letter's terms: probation, notice period, weekly hours, how long the
 *                  offer stays open, the signatory (required before an offer can be sent), and up
 *                  to OFFER_TERM_LIMITS.CLAUSES_MAX further clauses
 */

import mongoose from 'mongoose';
import { ONBOARDING_SETTINGS } from '../constants/validation.js';

export const ONBOARDING_SETTINGS_KEY = 'onboarding';

const { DEFAULT_COMPENSATION_POLICY: POLICY, DEFAULT_OFFER_TERMS: TERMS } = ONBOARDING_SETTINGS;
const { COMPENSATION_LIMITS: LIMITS, OFFER_TERM_LIMITS: TERM_LIMITS } = ONBOARDING_SETTINGS;

/** A whole number in [minimum, maximum], e.g. "Probation must be 0 to 12 months". */
const wholeNumber = (label, unit, defaultValue, [minimum, maximum]) => ({
  type: Number,
  default: defaultValue,
  validate: {
    validator: (value) => Number.isInteger(value) && value >= minimum && value <= maximum,
    message: `${label} must be ${minimum} to ${maximum}${unit ? ` ${unit}` : ''}`,
  },
});

const optionalText = (label, defaultValue) => ({
  type: String,
  trim: true,
  default: defaultValue,
  maxlength: [
    TERM_LIMITS.SIGNATORY_MAX_LENGTH,
    `${label} must be at most ${TERM_LIMITS.SIGNATORY_MAX_LENGTH} characters`,
  ],
});

const onboardingSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, immutable: true },
    compensation: {
      basicShareBasisPoints: wholeNumber('Basic share', 'basis points', POLICY.basicShareBasisPoints, [
        LIMITS.BASIC_SHARE_MIN_BASIS_POINTS,
        LIMITS.BASIC_SHARE_MAX_BASIS_POINTS,
      ]),
      hraFiftyPercentCityBasisPoints: wholeNumber(
        'HRA share in the 50% cities',
        'basis points',
        POLICY.hraFiftyPercentCityBasisPoints,
        [0, LIMITS.HRA_MAX_BASIS_POINTS],
      ),
      hraOtherCityBasisPoints: wholeNumber('HRA share elsewhere', 'basis points', POLICY.hraOtherCityBasisPoints, [
        0,
        LIMITS.HRA_MAX_BASIS_POINTS,
      ]),
      pfOnFullBasic: { type: Boolean, default: POLICY.pfOnFullBasic },
      includeGratuityInCtc: { type: Boolean, default: POLICY.includeGratuityInCtc },
    },
    offerTerms: {
      probationMonths: wholeNumber('Probation', 'months', TERMS.probationMonths, [0, TERM_LIMITS.PROBATION_MONTHS_MAX]),
      noticePeriodDays: wholeNumber('Notice period', 'days', TERMS.noticePeriodDays, [
        0,
        TERM_LIMITS.NOTICE_PERIOD_DAYS_MAX,
      ]),
      weeklyWorkingHours: wholeNumber('Weekly working hours', 'hours', TERMS.weeklyWorkingHours, [
        1,
        TERM_LIMITS.WEEKLY_WORKING_HOURS_MAX,
      ]),
      offerValidityDays: wholeNumber('Offer validity', 'days', TERMS.offerValidityDays, [
        1,
        TERM_LIMITS.OFFER_VALIDITY_DAYS_MAX,
      ]),
      signatoryName: optionalText('Signatory name', TERMS.signatoryName),
      signatoryTitle: optionalText('Signatory title', TERMS.signatoryTitle),
      additionalClauses: {
        type: [
          {
            type: String,
            trim: true,
            maxlength: [
              TERM_LIMITS.CLAUSE_MAX_LENGTH,
              `Each clause must be at most ${TERM_LIMITS.CLAUSE_MAX_LENGTH} characters`,
            ],
          },
        ],
        default: () => [...TERMS.additionalClauses],
        validate: {
          validator: (clauses) => clauses.length <= TERM_LIMITS.CLAUSES_MAX,
          message: `At most ${TERM_LIMITS.CLAUSES_MAX} clauses`,
        },
      },
    },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

export default mongoose.model('OnboardingSettings', onboardingSettingsSchema);
