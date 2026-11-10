/**
 * Attendance endpoints (routes/attendanceRoutes.js, mounted at /api/attendance).
 *
 * POST /api/attendance/punch-in
 * -----------------------------
 * Body: { lat, lng, accuracyMeters, deviceFingerprint, macAddress?, workMode?, onDutyReason? }
 * (see validators/attendanceValidators.js)
 *
 * The employee is always the signed-in user: their EmployeeProfile is found by the session's user
 * id. No employee id is accepted from the client, so nobody can punch in for someone else.
 *
 * Verification pipeline, in order (the first failure ends the request):
 *   1. Input        types and ranges of every field                          400
 *   2. Employee     a profile is linked to this account                       404
 *                   employment has not ended                                  403
 *                   their work type allows the work mode (office, home or
 *                   on duty; their usual one when none is sent)              403 WORK_MODE_NOT_ALLOWED
 *   3. Office       a base office is assigned and exists                      409
 *   4. Device       if a MAC address is registered, the request must send
 *                   that same address                                         403 DEVICE_NOT_RECOGNISED
 *   5. Precision    office punches: the location fix is within
 *                   MAX_LOCATION_ACCURACY_METRES                               422
 *   6. Day          today's date in the office time zone, from the server
 *                   clock; one punch-in per day                               409
 *   7. Geofence     office punches: the Haversine distance to the office is within the employee's
 *                   own radius, or else the office's                          403 UNAUTHORIZED_SPATIAL_LOCATION
 *                   home and on-duty punches: the distance is recorded, not enforced
 *   8. Status       Normal / Late / Half_Day from the arrival time against the office shift
 *   9. Persist      the unique { employeeId, date } index makes a racing duplicate a 409
 *
 * Every attempt past input validation is written as an audit event (category "attendance").
 * The raw device fingerprint and MAC address are never logged.
 */

import { createHash } from 'node:crypto';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ATTENDANCE_MESSAGES, REGULARIZATION_MESSAGES } from '../constants/messages.js';
import { ATTENDANCE_FIELD_LIMITS } from '../constants/validation.js';
import Attendance, {
  ATTENDANCE_CHECK_OUT_SOURCES,
  ATTENDANCE_ENTRY_SOURCES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_VERIFICATION_STATUSES,
  ATTENDANCE_WORK_MODES,
} from '../models/Attendance.js';
import { getCompanySettings } from '../services/companySettings.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import { AI_FAILURE_KIND, AiServiceError, requestAttendanceRegularization } from '../services/aiServiceClient.js';
import {
  allowedWorkModes,
  classifyArrival,
  effectiveGeofenceRadiusMeters,
  evaluateGeofence,
  readOfficeLocalClock,
} from '../services/attendancePolicy.js';
import { closeIfOverdue, closePunch } from '../services/attendancePunchOut.js';
import { EMPLOYEE_CONTEXT_UNAVAILABLE, loadEmployeeAgentContext } from '../services/employeeContext.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { validatePunchInInput, validatePunchOutInput } from '../validators/attendanceValidators.js';
import { validateRegularizeRequest } from '../validators/regularizationValidators.js';
import { haversineDistanceMetres } from '../utils/geoDistance.js';
import { logger } from '../utils/logger.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';

/** Stable codes for clients; they branch on these, never on message text. */
export const ATTENDANCE_ERROR_CODES = Object.freeze({
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  EMPLOYMENT_ENDED: 'EMPLOYMENT_ENDED',
  OFFICE_NOT_CONFIGURED: 'OFFICE_NOT_CONFIGURED',
  DEVICE_NOT_RECOGNISED: 'DEVICE_NOT_RECOGNISED',
  LOCATION_TOO_IMPRECISE: 'LOCATION_TOO_IMPRECISE',
  UNAUTHORIZED_SPATIAL_LOCATION: 'UNAUTHORIZED_SPATIAL_LOCATION',
  ALREADY_PUNCHED_IN: 'ALREADY_PUNCHED_IN',
  WORK_MODE_NOT_ALLOWED: 'WORK_MODE_NOT_ALLOWED',
  NOT_PUNCHED_IN: 'NOT_PUNCHED_IN',
  ALREADY_PUNCHED_OUT: 'ALREADY_PUNCHED_OUT',
  PUNCH_OUT_TOO_LATE: 'PUNCH_OUT_TOO_LATE',
});

function auditPunchIn(req, outcome, details) {
  recordAuditEvent(req, { category: 'attendance', action: 'punch_in', outcome, ...details });
}

/**
 * A registered MAC address binds attendance to that device; without one, any device may punch and
 * the reported address (if any) is only recorded. Returns why the device is refused, or null.
 */
function unregisteredDeviceReason(employeeProfile, macAddress) {
  const registeredMacAddress = employeeProfile.biometricMetadata?.registeredDeviceMacAddress ?? null;
  if (!registeredMacAddress || macAddress === registeredMacAddress) return null;
  return macAddress ? 'device_mac_mismatch' : 'device_mac_missing';
}

/**
 * The signed-in user's employee profile, when they may record attendance. Otherwise the refusal is
 * audited (with `audit`) and sent, and null is returned. No employee id is taken from the client.
 */
async function findPunchingEmployee(req, res, audit) {
  const employeeProfile = await EmployeeProfile.findOne({ userId: req.user.id })
    .select('organizationData biometricMetadata.allowedGeofenceRadius biometricMetadata.registeredDeviceMacAddress')
    .lean();
  if (!employeeProfile) {
    audit(req, AUDIT_OUTCOMES.REJECTED, { reason: 'profile_not_found' });
    sendCodedError(req, res, HTTP_STATUS.NOT_FOUND, {
      code: ATTENDANCE_ERROR_CODES.PROFILE_NOT_FOUND,
      message: ATTENDANCE_MESSAGES.PROFILE_NOT_FOUND,
    });
    return null;
  }
  if (employeeProfile.organizationData.employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) {
    audit(req, AUDIT_OUTCOMES.DENIED, { employeeId: employeeProfile._id.toString(), reason: 'employment_ended' });
    sendCodedError(req, res, HTTP_STATUS.FORBIDDEN, {
      code: ATTENDANCE_ERROR_CODES.EMPLOYMENT_ENDED,
      message: ATTENDANCE_MESSAGES.EMPLOYMENT_ENDED,
    });
    return null;
  }
  return employeeProfile;
}

function sendDeviceNotRecognised(req, res) {
  return sendCodedError(req, res, HTTP_STATUS.FORBIDDEN, {
    code: ATTENDANCE_ERROR_CODES.DEVICE_NOT_RECOGNISED,
    message: ATTENDANCE_MESSAGES.DEVICE_NOT_RECOGNISED,
  });
}

/** Metres rounded to one decimal place, for storage and responses. */
function roundMetres(distanceMeters) {
  return Math.round(distanceMeters * 10) / 10;
}

function toAttendanceSummary(attendanceRecord) {
  return {
    id: attendanceRecord._id.toString(),
    employeeId: attendanceRecord.employeeId.toString(),
    officeLocationId: attendanceRecord.officeLocationId?.toString() ?? null,
    verificationStatus: attendanceRecord.verificationStatus ?? null,
    date: attendanceRecord.date,
    timeZone: attendanceRecord.timeZone,
    checkInTime: attendanceRecord.checkInTime.toISOString(),
    checkOutTime: attendanceRecord.checkOutTime ? attendanceRecord.checkOutTime.toISOString() : null,
    checkOutSource: attendanceRecord.checkOutSource ?? null,
    workedMinutes: attendanceRecord.workedMinutes ?? null,
    workMode: attendanceRecord.workMode ?? null,
    onDutyReason: attendanceRecord.onDutyReason ?? null,
    checkInCoordinates: {
      lat: attendanceRecord.checkInCoordinates.lat,
      lng: attendanceRecord.checkInCoordinates.lng,
      accuracyMeters: attendanceRecord.checkInCoordinates.accuracyMeters,
    },
    calculationStatus: attendanceRecord.calculationStatus,
    lateByMinutes: attendanceRecord.lateByMinutes,
    geofence: {
      enforced: attendanceRecord.geofence.enforced,
      distanceMeters: attendanceRecord.geofence.distanceMeters,
      allowedRadiusMeters: attendanceRecord.geofence.allowedRadiusMeters,
    },
  };
}

/**
 * The punch-in of an employee without a base office: recorded with its location, in the company's
 * time zone, as LOCATION_LOGGED_UNASSIGNED. No radius or shift applies, so it is never refused for
 * where it was made and is never late (HR reviews these entries; assigning an office starts the
 * checks on the next punch).
 */
async function punchInWithoutOffice(req, res, punch) {
  const { employeeId, workMode, onDutyReason, reading, deviceFingerprint, macAddress, registeredMacAddress } = punch;
  const { timeZone } = await getCompanySettings();
  const punchedAt = new Date();
  const { calendarDate } = readOfficeLocalClock(punchedAt, timeZone);
  if (await Attendance.exists({ employeeId, date: calendarDate })) {
    return sendCodedError(req, res, HTTP_STATUS.CONFLICT, {
      code: ATTENDANCE_ERROR_CODES.ALREADY_PUNCHED_IN,
      message: ATTENDANCE_MESSAGES.ALREADY_PUNCHED_IN,
    });
  }
  let attendanceRecord;
  try {
    attendanceRecord = await Attendance.create({
      employeeId,
      officeLocationId: null,
      verificationStatus: ATTENDANCE_VERIFICATION_STATUSES.LOCATION_LOGGED_UNASSIGNED,
      date: calendarDate,
      timeZone,
      checkInTime: punchedAt,
      workMode,
      onDutyReason,
      checkInCoordinates: reading,
      geofence: { enforced: false, distanceMeters: null, allowedRadiusMeters: null },
      deviceFingerprint: createHash('sha256').update(deviceFingerprint, 'utf8').digest('hex'),
      checkInMacAddress: macAddress,
      calculationStatus: ATTENDANCE_STATUSES.NORMAL,
      lateByMinutes: 0,
    });
  } catch (persistError) {
    if (isDuplicateKeyError(persistError)) {
      return sendCodedError(req, res, HTTP_STATUS.CONFLICT, {
        code: ATTENDANCE_ERROR_CODES.ALREADY_PUNCHED_IN,
        message: ATTENDANCE_MESSAGES.ALREADY_PUNCHED_IN,
      });
    }
    throw persistError;
  }
  auditPunchIn(req, AUDIT_OUTCOMES.ALLOWED, {
    employeeId,
    attendanceId: attendanceRecord._id.toString(),
    date: calendarDate,
    workMode,
    verificationStatus: ATTENDANCE_VERIFICATION_STATUSES.LOCATION_LOGGED_UNASSIGNED,
    accuracyMeters: reading.accuracyMeters,
    deviceCheck: registeredMacAddress ? 'registered_mac_matched' : 'no_registered_device',
  });
  return sendSuccess(res, HTTP_STATUS.CREATED, ATTENDANCE_MESSAGES.PUNCHED_IN_UNASSIGNED, {
    attendance: toAttendanceSummary(attendanceRecord),
  });
}

/**
 * POST /api/attendance/punch-in
 * Responses:
 *   201 { message, data: { attendance } }
 *   400 invalid input (details per field)
 *   401 no session / 403 bad CSRF   (protect)
 *   403 { error: { code: EMPLOYMENT_ENDED | WORK_MODE_NOT_ALLOWED | DEVICE_NOT_RECOGNISED
 *                       | UNAUTHORIZED_SPATIAL_LOCATION, context? } }
 *   404 { error: { code: PROFILE_NOT_FOUND } }
 *   409 { error: { code: ALREADY_PUNCHED_IN } }
 *
 * Without a base office the punch is not refused: the location is recorded, the date is the
 * company's, nothing is checked against a radius or a shift, and the entry is marked
 * LOCATION_LOGGED_UNASSIGNED for HR to review (punchInWithoutOffice).
 *   422 { error: { code: LOCATION_TOO_IMPRECISE, context } }
 *   429 too many attempts (rate limiter) / 500 unexpected (central error handler)
 */
export async function punchIn(req, res, next) {
  try {
    // ---- 1. Input -----------------------------------------------------------------------------
    const inputValidation = validatePunchInInput(req.body);
    if (!inputValidation.isValid) {
      return sendError(
        req,
        res,
        HTTP_STATUS.BAD_REQUEST,
        inputValidation.validationErrors[0].message,
        inputValidation.validationErrors,
      );
    }
    const { lat, lng, accuracyMeters, deviceFingerprint, macAddress, onDutyReason } = inputValidation.sanitizedInput;
    const punchPoint = { lat, lng };

    // ---- 2. Employee --------------------------------------------------------------------------
    const employeeProfile = await findPunchingEmployee(req, res, auditPunchIn);
    if (!employeeProfile) return undefined;
    const employeeId = employeeProfile._id.toString();
    const { workLocationType, officeLocationId } = employeeProfile.organizationData;
    // Where they are working today: their work type decides which modes they may choose.
    const permittedWorkModes = allowedWorkModes(workLocationType);
    const workMode = inputValidation.sanitizedInput.workMode ?? permittedWorkModes[0];
    if (!permittedWorkModes.includes(workMode)) {
      auditPunchIn(req, AUDIT_OUTCOMES.DENIED, { employeeId, reason: 'work_mode_not_allowed', workMode });
      return sendCodedError(req, res, HTTP_STATUS.FORBIDDEN, {
        code: ATTENDANCE_ERROR_CODES.WORK_MODE_NOT_ALLOWED,
        message: ATTENDANCE_MESSAGES.WORK_MODE_NOT_ALLOWED,
        context: { workMode, allowedWorkModes: permittedWorkModes },
      });
    }
    const isGeofenceEnforced = workMode === ATTENDANCE_WORK_MODES.OFFICE;

    // ---- 3. Device ----------------------------------------------------------------------------
    const deviceProblem = unregisteredDeviceReason(employeeProfile, macAddress);
    if (deviceProblem) {
      auditPunchIn(req, AUDIT_OUTCOMES.DENIED, { employeeId, reason: deviceProblem });
      return sendDeviceNotRecognised(req, res);
    }
    const registeredMacAddress = employeeProfile.biometricMetadata?.registeredDeviceMacAddress ?? null;

    // ---- 4. Office ----------------------------------------------------------------------------
    const office = officeLocationId ? await OfficeLocation.findById(officeLocationId).lean() : null;
    if (!office) {
      return punchInWithoutOffice(req, res, {
        employeeId,
        workMode,
        onDutyReason,
        reading: { lat, lng, accuracyMeters },
        deviceFingerprint,
        macAddress,
        registeredMacAddress,
      });
    }

    // ---- 5. Precision -------------------------------------------------------------------------
    // Only an office punch is placed against a radius; elsewhere the reading is recorded as it is.
    if (isGeofenceEnforced && accuracyMeters > ATTENDANCE_FIELD_LIMITS.MAX_LOCATION_ACCURACY_METRES) {
      auditPunchIn(req, AUDIT_OUTCOMES.REJECTED, { employeeId, reason: 'location_too_imprecise', accuracyMeters });
      return sendCodedError(req, res, HTTP_STATUS.UNPROCESSABLE_CONTENT, {
        code: ATTENDANCE_ERROR_CODES.LOCATION_TOO_IMPRECISE,
        message: ATTENDANCE_MESSAGES.LOCATION_TOO_IMPRECISE,
        context: { accuracyMeters, maxAccuracyMeters: ATTENDANCE_FIELD_LIMITS.MAX_LOCATION_ACCURACY_METRES },
      });
    }

    // ---- 6. Day -------------------------------------------------------------------------------
    // Server time, in the office's zone: the client clock plays no part in the date or lateness.
    const punchedAt = new Date();
    const { calendarDate, minutesSinceMidnight } = readOfficeLocalClock(punchedAt, office.timeZone);
    if (await Attendance.exists({ employeeId, date: calendarDate })) {
      return sendCodedError(req, res, HTTP_STATUS.CONFLICT, {
        code: ATTENDANCE_ERROR_CODES.ALREADY_PUNCHED_IN,
        message: ATTENDANCE_MESSAGES.ALREADY_PUNCHED_IN,
      });
    }

    // ---- 7. Geofence --------------------------------------------------------------------------
    const allowedRadiusMeters = isGeofenceEnforced
      ? effectiveGeofenceRadiusMeters(office, employeeProfile.biometricMetadata?.allowedGeofenceRadius)
      : null;
    // Home and on-duty punches are measured too (with an infinite radius), so the record shows how
    // far from the office they were made.
    const { distanceMeters, isInsideGeofence } = evaluateGeofence(
      punchPoint,
      office.coordinates,
      isGeofenceEnforced ? allowedRadiusMeters : Number.POSITIVE_INFINITY,
    );
    const roundedDistanceMeters = roundMetres(distanceMeters);
    if (!isInsideGeofence) {
      auditPunchIn(req, AUDIT_OUTCOMES.DENIED, {
        employeeId,
        reason: 'outside_geofence',
        distanceMeters: roundedDistanceMeters,
        allowedRadiusMeters,
        accuracyMeters,
        officeLocationId: office._id.toString(),
      });
      return sendCodedError(req, res, HTTP_STATUS.FORBIDDEN, {
        code: ATTENDANCE_ERROR_CODES.UNAUTHORIZED_SPATIAL_LOCATION,
        message: ATTENDANCE_MESSAGES.UNAUTHORIZED_SPATIAL_LOCATION,
        context: { distanceMeters: Math.round(distanceMeters), allowedRadiusMeters, officeName: office.name },
      });
    }

    // ---- 8. Status ----------------------------------------------------------------------------
    const { calculationStatus, lateByMinutes } = classifyArrival(minutesSinceMidnight, office.workday);

    // ---- 9. Persist ---------------------------------------------------------------------------
    let attendanceRecord;
    try {
      attendanceRecord = await Attendance.create({
        employeeId,
        officeLocationId: office._id,
        date: calendarDate,
        timeZone: office.timeZone,
        checkInTime: punchedAt,
        workMode,
        onDutyReason,
        checkInCoordinates: { lat, lng, accuracyMeters },
        geofence: { enforced: isGeofenceEnforced, distanceMeters: roundedDistanceMeters, allowedRadiusMeters },
        verificationStatus: isGeofenceEnforced
          ? ATTENDANCE_VERIFICATION_STATUSES.GEOFENCE_VERIFIED
          : ATTENDANCE_VERIFICATION_STATUSES.LOCATION_LOGGED,
        deviceFingerprint: createHash('sha256').update(deviceFingerprint, 'utf8').digest('hex'),
        checkInMacAddress: macAddress,
        calculationStatus,
        lateByMinutes,
      });
    } catch (persistError) {
      // A concurrent punch-in for the same day won the unique index.
      if (isDuplicateKeyError(persistError)) {
        return sendCodedError(req, res, HTTP_STATUS.CONFLICT, {
          code: ATTENDANCE_ERROR_CODES.ALREADY_PUNCHED_IN,
          message: ATTENDANCE_MESSAGES.ALREADY_PUNCHED_IN,
        });
      }
      throw persistError;
    }

    auditPunchIn(req, AUDIT_OUTCOMES.ALLOWED, {
      employeeId,
      attendanceId: attendanceRecord._id.toString(),
      date: calendarDate,
      calculationStatus,
      lateByMinutes,
      workMode,
      geofenceEnforced: isGeofenceEnforced,
      distanceMeters: roundedDistanceMeters,
      allowedRadiusMeters,
      accuracyMeters,
      deviceCheck: registeredMacAddress ? 'registered_mac_matched' : 'no_registered_device',
    });
    return sendSuccess(res, HTTP_STATUS.CREATED, ATTENDANCE_MESSAGES.PUNCHED_IN, {
      attendance: toAttendanceSummary(attendanceRecord),
    });
  } catch (error) {
    return next(error);
  }
}

// =================================================================================================
// POST /api/attendance/punch-out
// =================================================================================================

function auditPunchOut(req, outcome, details) {
  recordAuditEvent(req, { category: 'attendance', action: 'punch_out', outcome, ...details });
}

/**
 * POST /api/attendance/punch-out
 * Body: { lat, lng, accuracyMeters, deviceFingerprint, macAddress? }
 *
 * Closes the signed-in employee's open punch-in at the server's clock. Where they punch out is
 * recorded (and its distance from the office), never checked: leaving work is not refused for being
 * elsewhere. A registered device is required as for punching in.
 *
 *   1. Input, 2. Employee, 3. Device      as for the punch-in
 *   4. Open punch   their latest punch-in is still open      409 NOT_PUNCHED_IN | ALREADY_PUNCHED_OUT
 *   5. Deadline     its automatic punch-out has not passed   409 PUNCH_OUT_TOO_LATE (it is closed at
 *                   (services/attendancePolicy.js)              the shift end, as the job would)
 *   6. Persist      closed only if still open (a racing punch-out or the job: 409 ALREADY_PUNCHED_OUT)
 *
 * Responses: 200 { message, data: { attendance } } with checkOutTime and workedMinutes; the errors
 * above; 400/401/403/404/429 as for the punch-in.
 */
export async function punchOut(req, res, next) {
  try {
    const inputValidation = validatePunchOutInput(req.body);
    if (!inputValidation.isValid) {
      return sendError(
        req,
        res,
        HTTP_STATUS.BAD_REQUEST,
        inputValidation.validationErrors[0].message,
        inputValidation.validationErrors,
      );
    }
    const { lat, lng, accuracyMeters, macAddress } = inputValidation.sanitizedInput;

    const employeeProfile = await findPunchingEmployee(req, res, auditPunchOut);
    if (!employeeProfile) return undefined;
    const employeeId = employeeProfile._id.toString();

    const deviceProblem = unregisteredDeviceReason(employeeProfile, macAddress);
    if (deviceProblem) {
      auditPunchOut(req, AUDIT_OUTCOMES.DENIED, { employeeId, reason: deviceProblem });
      return sendDeviceNotRecognised(req, res);
    }

    const latestPunch = await Attendance.findOne({ employeeId, entrySource: ATTENDANCE_ENTRY_SOURCES.DEVICE_PUNCH })
      .sort({ date: -1 })
      .lean();
    const now = new Date();
    if (!latestPunch || latestPunch.checkOutTime) {
      const isClosedToday =
        latestPunch && latestPunch.date === readOfficeLocalClock(now, latestPunch.timeZone).calendarDate;
      return sendCodedError(req, res, HTTP_STATUS.CONFLICT, {
        code: isClosedToday ? ATTENDANCE_ERROR_CODES.ALREADY_PUNCHED_OUT : ATTENDANCE_ERROR_CODES.NOT_PUNCHED_IN,
        message: isClosedToday ? ATTENDANCE_MESSAGES.ALREADY_PUNCHED_OUT : ATTENDANCE_MESSAGES.NOT_PUNCHED_IN,
      });
    }

    const office = latestPunch.officeLocationId
      ? await OfficeLocation.findById(latestPunch.officeLocationId).lean()
      : null;
    // A punch made without a base office has its own time limit (automaticPunchOut with no office).
    const hasDeadline = Boolean(office) || !latestPunch.officeLocationId;
    if (hasDeadline && (await closeIfOverdue(latestPunch, office, now))) {
      auditPunchOut(req, AUDIT_OUTCOMES.REJECTED, { employeeId, reason: 'deadline_passed', date: latestPunch.date });
      return sendCodedError(req, res, HTTP_STATUS.CONFLICT, {
        code: ATTENDANCE_ERROR_CODES.PUNCH_OUT_TOO_LATE,
        message: ATTENDANCE_MESSAGES.PUNCH_OUT_TOO_LATE,
      });
    }

    const distanceMeters = office ? roundMetres(haversineDistanceMetres({ lat, lng }, office.coordinates)) : null;
    const closedPunch = await closePunch(latestPunch, {
      checkOutTime: now,
      source: ATTENDANCE_CHECK_OUT_SOURCES.DEVICE,
      coordinates: { lat, lng, accuracyMeters },
      distanceMeters,
    });
    if (!closedPunch) {
      return sendCodedError(req, res, HTTP_STATUS.CONFLICT, {
        code: ATTENDANCE_ERROR_CODES.ALREADY_PUNCHED_OUT,
        message: ATTENDANCE_MESSAGES.ALREADY_PUNCHED_OUT,
      });
    }

    auditPunchOut(req, AUDIT_OUTCOMES.ALLOWED, {
      employeeId,
      attendanceId: closedPunch._id.toString(),
      date: closedPunch.date,
      workedMinutes: closedPunch.workedMinutes,
      distanceMeters,
      accuracyMeters,
    });
    return sendSuccess(res, HTTP_STATUS.OK, ATTENDANCE_MESSAGES.PUNCHED_OUT, {
      attendance: toAttendanceSummary(closedPunch),
    });
  } catch (error) {
    return next(error);
  }
}

// =================================================================================================
// POST /api/attendance/regularize
// =================================================================================================

/** Why the employee cannot use regularization, mapped to the response the client receives. */
const CONTEXT_UNAVAILABLE_RESPONSES = Object.freeze({
  [EMPLOYEE_CONTEXT_UNAVAILABLE.NO_PROFILE]: {
    httpStatus: HTTP_STATUS.NOT_FOUND,
    code: ATTENDANCE_ERROR_CODES.PROFILE_NOT_FOUND,
    message: ATTENDANCE_MESSAGES.PROFILE_NOT_FOUND,
  },
  [EMPLOYEE_CONTEXT_UNAVAILABLE.EMPLOYMENT_ENDED]: {
    httpStatus: HTTP_STATUS.FORBIDDEN,
    code: ATTENDANCE_ERROR_CODES.EMPLOYMENT_ENDED,
    message: ATTENDANCE_MESSAGES.EMPLOYMENT_ENDED,
  },
  [EMPLOYEE_CONTEXT_UNAVAILABLE.OFFICE_NOT_CONFIGURED]: {
    httpStatus: HTTP_STATUS.CONFLICT,
    code: ATTENDANCE_ERROR_CODES.OFFICE_NOT_CONFIGURED,
    message: ATTENDANCE_MESSAGES.OFFICE_NOT_CONFIGURED,
  },
});

/**
 * POST /api/attendance/regularize
 * Body: { message: string (1-2000), startNew?: boolean }
 *
 * The signed-in employee talks to the attendance regularization agent ("I forgot to clock in
 * yesterday because my laptop broke"). Pipeline:
 *   1. Validate the body                                                           400
 *   2. Load the caller's EmployeeProfile, OfficeLocation and name from MongoDB
 *      (services/employeeContext.js): no profile 404, employment ended 403,
 *      no office/shift 409. Only current employees (and managers, who are
 *      employees too) get past this step.
 *   3. Send { thread_id: "attendance:<employeeId>", message, employee_context, start_new } to the
 *      ai-service (POST /ai/attendance/regularize). The thread is per employee, so a follow-up
 *      message answers the agent's pending question.
 *   4. Return the agent's outcome. Approvals have already been written to Attendance by the agent
 *      (through /api/internal), and escalations stored as a RegularizationReview.
 *
 * Responses:
 *   200 { message, data: { regularization: { outcome, reply, awaitingInput, approval, managerReview } } }
 *       outcome: approved | awaiting_employee_input | routed_to_manager | out_of_scope
 *   400 / 403 / 404 / 409 as above; 401/403 from protect (session, CSRF); 429 rate limit
 *   503 the agent is unavailable; 504 it did not answer within AI_SERVICE_TIMEOUT_MS
 */
export async function regularizeAttendance(req, res, next) {
  try {
    const inputValidation = validateRegularizeRequest(req.body);
    if (!inputValidation.isValid) {
      return sendError(
        req,
        res,
        HTTP_STATUS.BAD_REQUEST,
        inputValidation.validationErrors[0].message,
        inputValidation.validationErrors,
      );
    }
    const { message, startNew } = inputValidation.sanitizedInput;

    const contextLookup = await loadEmployeeAgentContext(req.user.id);
    if (!contextLookup.isAvailable) {
      const unavailableResponse = CONTEXT_UNAVAILABLE_RESPONSES[contextLookup.unavailableReason];
      recordAuditEvent(req, {
        category: 'attendance',
        action: 'regularize_request',
        outcome: AUDIT_OUTCOMES.REJECTED,
        reason: contextLookup.unavailableReason,
      });
      return sendCodedError(req, res, unavailableResponse.httpStatus, {
        code: unavailableResponse.code,
        message: unavailableResponse.message,
      });
    }
    const { employeeContext } = contextLookup;
    const threadId = `attendance:${employeeContext.employee_id}`;

    let agentResult;
    try {
      agentResult = await requestAttendanceRegularization(
        { thread_id: threadId, message, employee_context: employeeContext, start_new: startNew },
        { config: req.app.locals.config, requestId: req.id },
      );
    } catch (agentError) {
      if (!(agentError instanceof AiServiceError)) throw agentError;
      logger.error('Attendance regularization agent call failed', {
        requestId: req.id,
        employeeId: employeeContext.employee_id,
        failureKind: agentError.failureKind,
        detail: agentError.detail,
        httpStatus: agentError.httpStatus,
        durationMs: agentError.durationMs,
      });
      recordAuditEvent(req, {
        category: 'attendance',
        action: 'regularize_request',
        outcome: AUDIT_OUTCOMES.FAILED,
        employeeId: employeeContext.employee_id,
        reason: agentError.failureKind,
      });
      const isTimeout = agentError.failureKind === AI_FAILURE_KIND.TIMEOUT;
      return sendError(
        req,
        res,
        isTimeout ? HTTP_STATUS.GATEWAY_TIMEOUT : HTTP_STATUS.SERVICE_UNAVAILABLE,
        isTimeout ? REGULARIZATION_MESSAGES.AI_TIMEOUT : REGULARIZATION_MESSAGES.AI_UNAVAILABLE,
      );
    }

    recordAuditEvent(req, {
      category: 'attendance',
      action: 'regularize_request',
      outcome: AUDIT_OUTCOMES.ALLOWED,
      employeeId: employeeContext.employee_id,
      agentOutcome: agentResult.outcome,
      attendanceId: agentResult.approval?.attendanceId ?? null,
      reviewId: agentResult.managerReview?.reviewId ?? null,
      durationMs: agentResult.durationMs,
    });
    return sendSuccess(res, HTTP_STATUS.OK, REGULARIZATION_MESSAGES.AGENT_REPLIED, {
      regularization: {
        outcome: agentResult.outcome,
        reply: agentResult.reply,
        awaitingInput: agentResult.awaitingInput,
        approval: agentResult.approval,
        managerReview: agentResult.managerReview,
      },
    });
  } catch (error) {
    return next(error);
  }
}
