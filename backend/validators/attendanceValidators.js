/**
 * Request validation for attendance punches. Pure functions, no I/O.
 *
 * POST /api/attendance/punch-in body:
 *   lat                number, −90..90                 (JSON number only; "12.9" strings are refused,
 *   lng                number, −180..180                so a client bug cannot be silently coerced)
 *   accuracyMeters     number, > 0                      the browser Geolocation `coords.accuracy`
 *   deviceFingerprint  string, 16–256 printable ASCII   a stable per-device identifier from the client
 *   macAddress         string, optional                 MAC-48 with ":" or "-" separators
 *
 * (0, 0) is refused: devices report "Null Island" when they have no fix. Range checks here reject
 * malformed input (400); whether an accurate-enough fix is inside the geofence is decided later.
 */

import { ATTENDANCE_MESSAGES } from '../constants/messages.js';
import { ATTENDANCE_FIELD_LIMITS, MAC_ADDRESS_PATTERN } from '../constants/validation.js';
import { PLACEHOLDER_MAC_ADDRESS, normalizeMacAddress } from '../models/EmployeeProfile.js';
import { isNullIsland, isValidLatitude, isValidLongitude } from '../utils/geoDistance.js';

/** Printable ASCII without spaces, the safe alphabet for an opaque identifier. */
const PRINTABLE_TOKEN_PATTERN = /^[\x21-\x7E]+$/;
/** Sanity ceiling for a reported accuracy; anything larger is not a location at all. */
const ACCURACY_SANITY_MAX_METRES = 100_000;

function isPlainObject(candidateValue) {
  return typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
}

/**
 * @returns {{ isValid: true, sanitizedInput: { lat, lng, accuracyMeters, deviceFingerprint, macAddress } }
 *         | { isValid: false, validationErrors: Array<{ field, message }> }}
 */
export function validatePunchInInput(requestBody) {
  if (!isPlainObject(requestBody)) {
    return { isValid: false, validationErrors: [{ field: 'body', message: ATTENDANCE_MESSAGES.BODY_MUST_BE_OBJECT }] };
  }
  const { lat, lng, accuracyMeters, deviceFingerprint, macAddress } = requestBody;
  const validationErrors = [];

  if (!isValidLatitude(lat)) validationErrors.push({ field: 'lat', message: ATTENDANCE_MESSAGES.LATITUDE_INVALID });
  if (!isValidLongitude(lng)) validationErrors.push({ field: 'lng', message: ATTENDANCE_MESSAGES.LONGITUDE_INVALID });
  if (validationErrors.length === 0 && isNullIsland({ lat, lng })) {
    validationErrors.push({ field: 'lat', message: ATTENDANCE_MESSAGES.LOCATION_MISSING });
  }

  const isValidAccuracy = typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters) && accuracyMeters > 0 && accuracyMeters <= ACCURACY_SANITY_MAX_METRES;
  if (!isValidAccuracy) validationErrors.push({ field: 'accuracyMeters', message: ATTENDANCE_MESSAGES.ACCURACY_INVALID });

  const isValidFingerprint =
    typeof deviceFingerprint === 'string' &&
    deviceFingerprint.length >= ATTENDANCE_FIELD_LIMITS.DEVICE_FINGERPRINT_MIN_LENGTH &&
    deviceFingerprint.length <= ATTENDANCE_FIELD_LIMITS.DEVICE_FINGERPRINT_MAX_LENGTH &&
    PRINTABLE_TOKEN_PATTERN.test(deviceFingerprint);
  if (!isValidFingerprint) validationErrors.push({ field: 'deviceFingerprint', message: ATTENDANCE_MESSAGES.FINGERPRINT_INVALID });

  let normalizedMacAddress = null;
  if (macAddress !== undefined && macAddress !== null) {
    normalizedMacAddress = typeof macAddress === 'string' ? normalizeMacAddress(macAddress) : null;
    if (!normalizedMacAddress || !MAC_ADDRESS_PATTERN.test(normalizedMacAddress)) {
      validationErrors.push({ field: 'macAddress', message: ATTENDANCE_MESSAGES.MAC_ADDRESS_INVALID });
    } else if (normalizedMacAddress === PLACEHOLDER_MAC_ADDRESS) {
      validationErrors.push({ field: 'macAddress', message: ATTENDANCE_MESSAGES.MAC_ADDRESS_PLACEHOLDER });
    }
  }

  if (validationErrors.length > 0) return { isValid: false, validationErrors };
  return { isValid: true, sanitizedInput: { lat, lng, accuracyMeters, deviceFingerprint, macAddress: normalizedMacAddress } };
}
