/**
 * Phone numbers as people type them, read into international (E.164) form, e.g. "+919876543210",
 * and the list of countries the sign-up screen's picker offers.
 *
 *   "+91 98765 43210", "0091-9876543210"   written with a country code: that country, whatever was picked
 *   "98765 43210", "09876543210"           a national number of the picked country (India by default)
 *   "919876543210"                         the picked country's code without "+"
 *
 * Whether a number can exist is decided by libphonenumber-js with its full metadata (number
 * lengths and prefixes per country), so landlines and every country's numbers are read correctly.
 * Before that, the typed text must look like a phone number: digits, spaces, dashes, dots and
 * brackets, with at most one "+" before every digit, and no longer than PHONE_SETTINGS.MAX_INPUT_LENGTH.
 */

import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/max';

import { PHONE_SETTINGS } from '../constants/validation.js';

const ALLOWED_INPUT = /^[+\d\s().-]+$/;
const SUPPORTED_COUNTRIES = new Set(getCountries());

/** True for a two-letter country code (ISO 3166-1 alpha-2, e.g. "IN") that phone numbers are known for. */
export function isSupportedPhoneCountry(countryCode) {
  return typeof countryCode === 'string' && SUPPORTED_COUNTRIES.has(countryCode);
}

/**
 * @param {unknown} rawPhoneNumber
 * @param {string} [countryCode]  the country picked beside the number (default PHONE_SETTINGS.DEFAULT_COUNTRY)
 * @returns {string|null}  the E.164 form, or null when it is not a phone number that can exist
 */
export function normalizePhoneNumber(rawPhoneNumber, countryCode = PHONE_SETTINGS.DEFAULT_COUNTRY) {
  if (typeof rawPhoneNumber !== 'string' || !isSupportedPhoneCountry(countryCode)) return null;
  const typed = rawPhoneNumber.trim();
  if (typed.length === 0 || typed.length > PHONE_SETTINGS.MAX_INPUT_LENGTH || !ALLOWED_INPUT.test(typed)) return null;
  // A "+" is only meaningful once, before every digit (an opening bracket may come first: "(+91)").
  const plusIndex = typed.indexOf('+');
  if (plusIndex !== -1 && (typed.indexOf('+', plusIndex + 1) !== -1 || !/^[\s(]*$/.test(typed.slice(0, plusIndex)))) {
    return null;
  }

  const parsed = parsePhoneNumberFromString(typed, countryCode);
  if (!parsed?.isValid()) return null;
  return PHONE_SETTINGS.E164_PATTERN.test(parsed.number) ? parsed.number : null;
}

let phoneCountries = null;

/**
 * Every country a number can be picked for, by English name: `{ code: 'IN', name: 'India',
 * callingCode: '91' }`. Names come from the runtime's own region names (Intl.DisplayNames).
 * @returns {ReadonlyArray<{ code: string, name: string, callingCode: string }>}
 */
export function listPhoneCountries() {
  if (!phoneCountries) {
    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    phoneCountries = Object.freeze(
      [...SUPPORTED_COUNTRIES]
        .map((code) =>
          Object.freeze({ code, name: regionNames.of(code) ?? code, callingCode: getCountryCallingCode(code) }),
        )
        .sort((first, second) => first.name.localeCompare(second.name, 'en')),
    );
  }
  return phoneCountries;
}
