/**
 * Request validation for attendance punches. Pure functions, no I/O.
 *
 * POST /api/attendance/punch-in and /punch-out bodies share the device report:
 *   lat                number, −90..90                 (JSON number only; "12.9" strings are refused,
 *   lng                number, −180..180                so a client bug cannot be silently coerced)
 *   accuracyMeters     number, > 0                      the browser Geolocation `coords.accuracy`
 *   deviceFingerprint  string, 16–256 printable ASCII   a stable per-device identifier from the client
 *   macAddress         string, optional                 MAC-48 with ":" or "-" separators
 * The punch-in adds:
 *   workMode           "office" | "home" | "on_duty", optional (the employee's usual mode when absent;
 *                      whether they may use it is decided by the punch-in, from their work type)
 *   onDutyReason       string, required with "on_duty" and refused otherwise
 *
 * (0, 0) is refused: devices report "Null Island" when they have no fix. Range checks here reject
 * malformed input (400); whether an accurate-enough fix is inside the geofence is decided later.
 */

import { ATTENDANCE_MESSAGES } from '../constants/messages.js';
import { ATTENDANCE_FIELD_LIMITS, MAC_ADDRESS_PATTERN } from '../constants/validation.js';
import { ATTENDANCE_WORK_MODES } from '../models/Attendance.js';
import { PLACEHOLDER_MAC_ADDRESS, normalizeMacAddress } from '../models/EmployeeProfile.js';
import { isNullIsland, isValidLatitude, isValidLongitude } from '../utils/geoDistance.js';

/** Printable ASCII without spaces, the safe alphabet for an opaque identifier. */
const PRINTABLE_TOKEN_PATTERN = /^[\x21-\x7E]+$/;

function isPlainObject(candidateValue) {
  return typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
}

const bodyNotObject = () => ({
  isValid: false,
  validationErrors: [{ field: 'body', message: ATTENDANCE_MESSAGES.BODY_MUST_BE_OBJECT }],
});

/** The location and device fields both punches send; problems are added to `validationErrors`. */
function readDeviceReport(requestBody, validationErrors) {
  const { lat, lng, accuracyMeters, deviceFingerprint, macAddress } = requestBody;

  const locationErrorCount = validationErrors.length;
  if (!isValidLatitude(lat)) validationErrors.push({ field: 'lat', message: ATTENDANCE_MESSAGES.LATITUDE_INVALID });
  if (!isValidLongitude(lng)) validationErrors.push({ field: 'lng', message: ATTENDANCE_MESSAGES.LONGITUDE_INVALID });
  if (validationErrors.length === locationErrorCount && isNullIsland({ lat, lng })) {
    validationErrors.push({ field: 'lat', message: ATTENDANCE_MESSAGES.LOCATION_MISSING });
  }

  const isValidAccuracy =
    typeof accuracyMeters === 'number' &&
    Number.isFinite(accuracyMeters) &&
    accuracyMeters > 0 &&
    accuracyMeters <= ATTENDANCE_FIELD_LIMITS.MAX_REPORTED_ACCURACY_METRES;
  if (!isValidAccuracy)
    validationErrors.push({ field: 'accuracyMeters', message: ATTENDANCE_MESSAGES.ACCURACY_INVALID });

  const isValidFingerprint =
    typeof deviceFingerprint === 'string' &&
    deviceFingerprint.length >= ATTENDANCE_FIELD_LIMITS.DEVICE_FINGERPRINT_MIN_LENGTH &&
    deviceFingerprint.length <= ATTENDANCE_FIELD_LIMITS.DEVICE_FINGERPRINT_MAX_LENGTH &&
    PRINTABLE_TOKEN_PATTERN.test(deviceFingerprint);
  if (!isValidFingerprint)
    validationErrors.push({ field: 'deviceFingerprint', message: ATTENDANCE_MESSAGES.FINGERPRINT_INVALID });

  let normalizedMacAddress = null;
  if (macAddress !== undefined && macAddress !== null) {
    normalizedMacAddress = typeof macAddress === 'string' ? normalizeMacAddress(macAddress) : null;
    if (!normalizedMacAddress || !MAC_ADDRESS_PATTERN.test(normalizedMacAddress)) {
      validationErrors.push({ field: 'macAddress', message: ATTENDANCE_MESSAGES.MAC_ADDRESS_INVALID });
    } else if (normalizedMacAddress === PLACEHOLDER_MAC_ADDRESS) {
      validationErrors.push({ field: 'macAddress', message: ATTENDANCE_MESSAGES.MAC_ADDRESS_PLACEHOLDER });
    }
  }

  return { lat, lng, accuracyMeters, deviceFingerprint, macAddress: normalizedMacAddress };
}

/**
 * POST /api/attendance/punch-in
 * @returns {{ isValid: true, sanitizedInput: { lat, lng, accuracyMeters, deviceFingerprint, macAddress,
 *           workMode, onDutyReason } } | { isValid: false, validationErrors: Array<{ field, message }> }}
 */
export function validatePunchInInput(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObject();
  const validationErrors = [];
  const deviceReport = readDeviceReport(requestBody, validationErrors);

  const { workMode = null, onDutyReason } = requestBody;
  if (workMode !== null && !Object.values(ATTENDANCE_WORK_MODES).includes(workMode)) {
    validationErrors.push({ field: 'workMode', message: ATTENDANCE_MESSAGES.WORK_MODE_INVALID });
  }
  const reason = typeof onDutyReason === 'string' ? onDutyReason.trim() : '';
  if (workMode === ATTENDANCE_WORK_MODES.ON_DUTY) {
    const isValidReason =
      reason.length >= ATTENDANCE_FIELD_LIMITS.ON_DUTY_REASON_MIN_LENGTH &&
      reason.length <= ATTENDANCE_FIELD_LIMITS.ON_DUTY_REASON_MAX_LENGTH;
    if (!isValidReason)
      validationErrors.push({ field: 'onDutyReason', message: ATTENDANCE_MESSAGES.ON_DUTY_REASON_INVALID });
  } else if (onDutyReason !== undefined && onDutyReason !== null) {
    validationErrors.push({ field: 'onDutyReason', message: ATTENDANCE_MESSAGES.ON_DUTY_REASON_UNEXPECTED });
  }

  if (validationErrors.length > 0) return { isValid: false, validationErrors };
  return {
    isValid: true,
    sanitizedInput: {
      ...deviceReport,
      workMode,
      onDutyReason: workMode === ATTENDANCE_WORK_MODES.ON_DUTY ? reason : null,
    },
  };
}

/**
 * POST /api/attendance/punch-out
 * @returns {{ isValid: true, sanitizedInput: { lat, lng, accuracyMeters, deviceFingerprint, macAddress } }
 *         | { isValid: false, validationErrors: Array<{ field, message }> }}
 */
export function validatePunchOutInput(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObject();
  const validationErrors = [];
  const deviceReport = readDeviceReport(requestBody, validationErrors);
  if (validationErrors.length > 0) return { isValid: false, validationErrors };
  return { isValid: true, sanitizedInput: deviceReport };
}
