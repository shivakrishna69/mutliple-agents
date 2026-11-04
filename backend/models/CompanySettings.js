/**
 * CompanySettings: who the company is, one document (key "company"), created on first use and
 * changed by administrators.
 *
 *   name               shown in the app, in emails and on payslips' header line
 *   shortCode          2-6 capital letters; the prefix of employee IDs (NSK0001) and of nothing else
 *   emailDomain        the company's mail domain (nsksofttech.in); work addresses are suggested in it.
 *                      null until the company has one
 *   logoUrl            an https (or site-relative /...) address of the logo; null shows the product logo
 *   brandColors        primary and accent colours as #RRGGBB
 *   timeZone           the company's IANA time zone, for company-wide dates and new offices
 *   employeeIdDigits   how many digits employee IDs are padded to (NSK0001 is 4)
 *   presence           automatic available/away/offline status (services/presence.js): whether it is
 *                      recorded at all, after how many idle minutes someone shows Away, and how many
 *                      days the detail and the daily totals are kept (PRESENCE_DEFAULTS, PRESENCE_LIMITS)
 *
 * Employee IDs are numbered by models/Counter.js and never reused; changing the short code or the
 * digits changes only the IDs issued afterwards.
 */

import mongoose from 'mongoose';
import {
  COMPANY_LIMITS,
  EMAIL_DOMAIN_PATTERN,
  HEX_COLOR_PATTERN,
  PRESENCE_DEFAULTS,
  PRESENCE_LIMITS,
} from '../constants/validation.js';
import { isValidIanaTimeZone } from './OfficeLocation.js';

export const COMPANY_SETTINGS_KEY = 'company';

/** Settings for a new installation; `name` comes from COMPANY_NAME when the deployment sets it. */
export const DEFAULT_COMPANY_SETTINGS = Object.freeze({
  shortCode: 'NSK',
  emailDomain: null,
  logoUrl: null,
  brandColors: Object.freeze({ primary: '#c75000', accent: '#282828' }),
  timeZone: 'Asia/Kolkata',
  employeeIdDigits: 4,
});

const SHORT_CODE_PATTERN = new RegExp(
  `^[A-Z]{${COMPANY_LIMITS.SHORT_CODE_MIN_LENGTH},${COMPANY_LIMITS.SHORT_CODE_MAX_LENGTH}}$`,
);

const isLogoUrl = (logoUrl) => {
  if (logoUrl === null) return true;
  if (logoUrl.startsWith('/') && !logoUrl.startsWith('//')) return true;
  try {
    return new URL(logoUrl).protocol === 'https:';
  } catch {
    return false;
  }
};

/** A whole number of `unit` in [minimum, maximum], e.g. "Away after must be 1 to 60 minutes". */
const wholeNumberField = (label, unit, defaultValue, [minimum, maximum]) => ({
  type: Number,
  default: defaultValue,
  validate: {
    validator: (value) => Number.isInteger(value) && value >= minimum && value <= maximum,
    message: `${label} must be ${minimum} to ${maximum} ${unit}`,
  },
});

const colorField = (defaultValue) => ({
  type: String,
  lowercase: true,
  trim: true,
  default: defaultValue,
  match: [HEX_COLOR_PATTERN, 'Colour "{VALUE}" must be #RRGGBB'],
});

const companySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, immutable: true, enum: [COMPANY_SETTINGS_KEY] },
    name: {
      type: String,
      required: [true, 'Company name is required'],
      trim: true,
      minlength: COMPANY_LIMITS.NAME_MIN_LENGTH,
      maxlength: COMPANY_LIMITS.NAME_MAX_LENGTH,
    },
    shortCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      default: DEFAULT_COMPANY_SETTINGS.shortCode,
      match: [SHORT_CODE_PATTERN, 'Short code must be 2-6 letters'],
    },
    emailDomain: {
      type: String,
      trim: true,
      lowercase: true,
      default: DEFAULT_COMPANY_SETTINGS.emailDomain,
      maxlength: COMPANY_LIMITS.EMAIL_DOMAIN_MAX_LENGTH,
      validate: {
        validator: (domain) => domain === null || EMAIL_DOMAIN_PATTERN.test(domain),
        message: 'Email domain "{VALUE}" is not a domain such as example.com',
      },
    },
    logoUrl: {
      type: String,
      trim: true,
      default: DEFAULT_COMPANY_SETTINGS.logoUrl,
      maxlength: COMPANY_LIMITS.LOGO_URL_MAX_LENGTH,
      validate: { validator: isLogoUrl, message: 'Logo address must be https:// or start with /' },
    },
    brandColors: {
      primary: colorField(DEFAULT_COMPANY_SETTINGS.brandColors.primary),
      accent: colorField(DEFAULT_COMPANY_SETTINGS.brandColors.accent),
    },
    timeZone: {
      type: String,
      required: true,
      default: DEFAULT_COMPANY_SETTINGS.timeZone,
      validate: { validator: isValidIanaTimeZone, message: 'Time zone "{VALUE}" is not a valid IANA time zone' },
    },
    employeeIdDigits: {
      type: Number,
      required: true,
      default: DEFAULT_COMPANY_SETTINGS.employeeIdDigits,
      validate: {
        validator: (digits) =>
          Number.isInteger(digits) &&
          digits >= COMPANY_LIMITS.EMPLOYEE_ID_MIN_DIGITS &&
          digits <= COMPANY_LIMITS.EMPLOYEE_ID_MAX_DIGITS,
        message: `Employee ID digits must be ${COMPANY_LIMITS.EMPLOYEE_ID_MIN_DIGITS} to ${COMPANY_LIMITS.EMPLOYEE_ID_MAX_DIGITS}`,
      },
    },
    presence: {
      enabled: { type: Boolean, default: true },
      awayAfterMinutes: wholeNumberField('Away after', 'minutes', PRESENCE_DEFAULTS.AWAY_AFTER_MINUTES, [
        PRESENCE_LIMITS.AWAY_AFTER_MIN_MINUTES,
        PRESENCE_LIMITS.AWAY_AFTER_MAX_MINUTES,
      ]),
      detailRetentionDays: wholeNumberField('Detail kept', 'days', PRESENCE_DEFAULTS.DETAIL_RETENTION_DAYS, [
        PRESENCE_LIMITS.DETAIL_RETENTION_MIN_DAYS,
        PRESENCE_LIMITS.DETAIL_RETENTION_MAX_DAYS,
      ]),
      summaryRetentionDays: wholeNumberField('Daily totals kept', 'days', PRESENCE_DEFAULTS.SUMMARY_RETENTION_DAYS, [
        PRESENCE_LIMITS.SUMMARY_RETENTION_MIN_DAYS,
        PRESENCE_LIMITS.SUMMARY_RETENTION_MAX_DAYS,
      ]),
    },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

export default mongoose.model('CompanySettings', companySettingsSchema);
