/**
 * The company's identity (models/CompanySettings.js): its name and branding, its mail domain, and
 * the employee IDs issued under its short code.
 *
 * The document is created at startup (ensureCompanySettings) with the deployment's COMPANY_NAME, or
 * the product default; after that administrators change it through the API, and emails, the app
 * and new employee IDs read it from here.
 */

import { PRESENCE_DEFAULTS } from '../constants/validation.js';
import CompanySettings, { COMPANY_SETTINGS_KEY } from '../models/CompanySettings.js';
import Counter, { COUNTER_NAMES } from '../models/Counter.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { assertCurrentVersion, saveVersioned } from './serviceError.js';

/** The name of a new installation when the deployment does not set COMPANY_NAME. */
export const DEFAULT_COMPANY_NAME = 'NSK Software Technologies';

export function toCompanySettingsSummary(settings) {
  return {
    name: settings.name,
    shortCode: settings.shortCode,
    emailDomain: settings.emailDomain,
    logoUrl: settings.logoUrl,
    ...toCompanyContactLinks(settings),
    brandColors: { primary: settings.brandColors.primary, accent: settings.brandColors.accent },
    timeZone: settings.timeZone,
    employeeIdDigits: settings.employeeIdDigits,
    presence: toPresenceSettings(settings),
    version: settings.__v,
  };
}

/** The presence settings; defaults fill in for a document saved before they existed. */
export function toPresenceSettings(settings) {
  const presence = settings.presence ?? {};
  return {
    enabled: presence.enabled ?? true,
    awayAfterMinutes: presence.awayAfterMinutes ?? PRESENCE_DEFAULTS.AWAY_AFTER_MINUTES,
    detailRetentionDays: presence.detailRetentionDays ?? PRESENCE_DEFAULTS.DETAIL_RETENTION_DAYS,
    summaryRetentionDays: presence.summaryRetentionDays ?? PRESENCE_DEFAULTS.SUMMARY_RETENTION_DAYS,
  };
}

/** Where people reach the company and read what they agree to; null when not set. */
function toCompanyContactLinks(settings) {
  return {
    supportEmail: settings.supportEmail ?? null,
    termsUrl: settings.termsUrl ?? null,
    privacyUrl: settings.privacyUrl ?? null,
    websiteUrl: settings.websiteUrl ?? null,
  };
}

/**
 * What anyone may see, signed in or not: the sign-in pages show the company's name and logo, its
 * support address, links to its terms and privacy policy, and its own website ("Back to Home").
 */
export function toCompanyBranding(settings) {
  return {
    name: settings.name,
    shortCode: settings.shortCode,
    logoUrl: settings.logoUrl,
    ...toCompanyContactLinks(settings),
    brandColors: { primary: settings.brandColors.primary, accent: settings.brandColors.accent },
  };
}

/** Creates the settings document if there is none; an existing one is left exactly as it is. */
export async function ensureCompanySettings({ initialName = DEFAULT_COMPANY_NAME } = {}) {
  try {
    return await CompanySettings.findOneAndUpdate(
      { key: COMPANY_SETTINGS_KEY },
      { $setOnInsert: { key: COMPANY_SETTINGS_KEY, name: initialName } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
  } catch (upsertError) {
    // Two instances starting at once: the other one created it.
    if (!isDuplicateKeyError(upsertError)) throw upsertError;
    return CompanySettings.findOne({ key: COMPANY_SETTINGS_KEY });
  }
}

export async function getCompanySettings() {
  return (await CompanySettings.findOne({ key: COMPANY_SETTINGS_KEY })) ?? ensureCompanySettings();
}

/** An administrator's changes, refused when based on an older version. */
export async function updateCompanySettings({ changes, version, actorUserId }) {
  const settings = await getCompanySettings();
  assertCurrentVersion(settings, version);
  const { brandColors = {}, presence = {}, ...otherChanges } = changes;
  settings.set({ ...otherChanges, updatedByUserId: actorUserId });
  // A grouped setting may change without the others in its group.
  for (const [colorName, color] of Object.entries(brandColors)) settings.set(`brandColors.${colorName}`, color);
  for (const [settingName, value] of Object.entries(presence)) settings.set(`presence.${settingName}`, value);
  await saveVersioned(settings);
  return toCompanySettingsSummary(settings);
}

/** "NSK" + 42 at 4 digits -> "NSK0042". Longer numbers are kept whole, never cut. */
export function formatEmployeeCode({ shortCode, employeeIdDigits }, sequenceNumber) {
  return `${shortCode}${String(sequenceNumber).padStart(employeeIdDigits, '0')}`;
}

/** The next employee ID. One atomic increment, so concurrent callers never get the same number. */
export async function issueEmployeeCode() {
  const [settings, counter] = await Promise.all([
    getCompanySettings(),
    Counter.findOneAndUpdate({ _id: COUNTER_NAMES.EMPLOYEE_CODE }, { $inc: { seq: 1 } }, { upsert: true, new: true }),
  ]);
  return formatEmployeeCode(settings, counter.seq);
}

/** The company name and the app's address, for emails. */
export async function loadEmailContext(config) {
  const settings = await getCompanySettings();
  return { companyName: settings.name, appPublicUrl: config.appPublicUrl };
}
