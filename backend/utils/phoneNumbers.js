/**
 * Reading a phone number as people type it into international (E.164) form, e.g. "+919876543210".
 *
 *   "+91 98765 43210", "0091-9876543210"   international: kept, with its own country code
 *   "98765 43210", "09876543210"           a national number of PHONE_SETTINGS.DEFAULT_COUNTRY_CODE
 *   "919876543210"                         the default country code without "+"
 *
 * National numbers are recognised for the default country India: 10 digits starting 6-9 (mobile
 * numbers), optionally after a trunk "0". Anything else must be written with its country code.
 * The result is checked against PHONE_SETTINGS.E164_PATTERN.
 */

import { PHONE_SETTINGS } from '../constants/validation.js';

const ALLOWED_INPUT = /^[+\d\s().-]+$/;
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * @param {unknown} rawPhoneNumber
 * @returns {string|null}  the E.164 form, or null when it is not a phone number we can read
 */
export function normalizePhoneNumber(rawPhoneNumber) {
  if (typeof rawPhoneNumber !== 'string') return null;
  const typed = rawPhoneNumber.trim();
  if (typed.length === 0 || typed.length > PHONE_SETTINGS.MAX_INPUT_LENGTH || !ALLOWED_INPUT.test(typed)) return null;
  // A "+" is only meaningful once, before every digit (an opening bracket may come first: "(+91)").
  const plusIndex = typed.indexOf('+');
  const hasPlus = plusIndex !== -1;
  if (hasPlus && (typed.indexOf('+', plusIndex + 1) !== -1 || !/^[\s(]*$/.test(typed.slice(0, plusIndex)))) return null;

  const digits = typed.replace(/\D/g, '');
  let international;
  if (hasPlus) international = digits;
  else if (digits.startsWith('00')) international = digits.slice(2);
  else if (PHONE_SETTINGS.DEFAULT_COUNTRY_CODE === '91' && INDIAN_MOBILE.test(digits)) international = `91${digits}`;
  else if (PHONE_SETTINGS.DEFAULT_COUNTRY_CODE === '91' && /^0[6-9]\d{9}$/.test(digits))
    international = `91${digits.slice(1)}`;
  else if (digits.startsWith(PHONE_SETTINGS.DEFAULT_COUNTRY_CODE)) international = digits;
  else return null;

  const normalized = `+${international}`;
  return PHONE_SETTINGS.E164_PATTERN.test(normalized) ? normalized : null;
}
