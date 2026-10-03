/**
 * Attendance model: one employee's attendance for one local calendar day.
 *
 * Relationship vectors
 * --------------------
 *   Attendance.employeeId        ──► EmployeeProfile._id  (many-to-one, required, immutable)
 *   Attendance.officeLocationId  ──► OfficeLocation._id   (the office whose geofence, time zone and
 *                                                          shift rules the punch was judged by)
 *   One record per employee per date: the unique { employeeId, date } index makes a second
 *   punch-in for the same day fail atomically, even when two requests race.
 *
 * Time fields
 * -----------
 *   date          "YYYY-MM-DD" in the office's time zone (recorded in `timeZone`) at the moment of
 *                 punch-in. A string, not a Date: it is a calendar day, not an instant, and must not
 *                 shift when read from a server in another zone.
 *   checkInTime   server clock at punch-in (an instant, stored in UTC). Never taken from the client.
 *   checkOutTime  server clock at punch-out; null until then; must be after checkInTime.
 *
 * Location and device evidence
 * ----------------------------
 *   checkInCoordinates / checkOutCoordinates  { lat, lng, accuracyMeters } as reported by the device
 *   geofence                                  what was verified at punch-in: whether the geofence
 *                                             applied, the computed Haversine distance to the office,
 *                                             and the radius allowed at that time (kept even if the
 *                                             radius changes later, so the decision stays explainable)
 *   deviceFingerprint                         SHA-256 (hex) of the client's device fingerprint. Only
 *                                             the hash is stored: it still detects a change of device
 *                                             (same input, same hash) without keeping a raw device
 *                                             identifier. `select: false`.
 *   checkInMacAddress                         the MAC address the client reported, normalised, or null.
 *                                             `select: false`.
 *
 * Location and device values are client-reported and can be forged by a modified client; they
 * deter casual misuse and leave evidence for review, they do not prove presence. Treat a pattern of
 * anomalies (identical coordinates every day, fingerprint changes) as a signal for HR review.
 *
 * Entry sources
 * -------------
 *   entrySource "device_punch"     created by POST /api/attendance/punch-in: coordinates, geofence
 *                                  evidence and the device fingerprint are required.
 *   entrySource "regularization"   created for a day the employee forgot to punch in: by the
 *                                  regularization agent after activity evidence proved they worked
 *                                  (regularization.method "automatic_evidence",
 *                                  regularizedBySystem true), or by a manager approving a review
 *                                  (method "manager_approved", approvedByUserId set). There is no
 *                                  device or location evidence, so those fields must be null and the
 *                                  `regularization` audit block is required instead.
 *   The unique { employeeId, date } index applies to both, so a day can never be both punched and
 *   regularized, or regularized twice.
 *
 * Status
 * ------
 *   calculationStatus  Normal | Late | Half_Day, decided at punch-in from arrival time against the
 *                      office shift (see controllers/attendanceController.js). 'Absent' is the status
 *                      of a day with no punch-in; it is never produced by a punch.
 *   lateByMinutes      minutes after the shift start (0 when on time or early).
 */

import mongoose from 'mongoose';
import { ATTENDANCE_FIELD_LIMITS, CALENDAR_DATE_PATTERN, MAC_ADDRESS_PATTERN } from '../constants/validation.js';
import { isNullIsland, isValidLatitude, isValidLongitude } from '../utils/geoDistance.js';
import { isValidIanaTimeZone } from './OfficeLocation.js';

const { ObjectId } = mongoose.Schema.Types;

/** Allowed values for `calculationStatus`. */
export const ATTENDANCE_STATUSES = Object.freeze({
  NORMAL: 'Normal',
  LATE: 'Late',
  HALF_DAY: 'Half_Day',
  ABSENT: 'Absent',
});

/** How the entry was created; see "Entry sources" above. */
export const ATTENDANCE_ENTRY_SOURCES = Object.freeze({
  DEVICE_PUNCH: 'device_punch',
  REGULARIZATION: 'regularization',
});

/** How a regularization was approved. */
export const REGULARIZATION_METHODS = Object.freeze({
  AUTOMATIC_EVIDENCE: 'automatic_evidence',
  MANAGER_APPROVED: 'manager_approved',
});

/** True when "YYYY-MM-DD" names a real calendar day (rejects 2026-02-30). */
export function isRealCalendarDate(calendarDate) {
  if (typeof calendarDate !== 'string' || !CALENDAR_DATE_PATTERN.test(calendarDate)) return false;
  const [year, month, day] = calendarDate.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return utcDate.getUTCFullYear() === year && utcDate.getUTCMonth() === month - 1 && utcDate.getUTCDate() === day;
}

/** A device-reported position. `_id: false`: it is a value, not an entity. */
const coordinatesSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true, validate: { validator: isValidLatitude, message: 'Latitude must be between -90 and 90' } },
    lng: { type: Number, required: true, validate: { validator: isValidLongitude, message: 'Longitude must be between -180 and 180' } },
    accuracyMeters: {
      type: Number,
      required: true,
      min: [0, 'Accuracy cannot be negative'],
      max: [ATTENDANCE_FIELD_LIMITS.MAX_LOCATION_ACCURACY_METRES, `Accuracy must be within ${ATTENDANCE_FIELD_LIMITS.MAX_LOCATION_ACCURACY_METRES} m`],
    },
  },
  { _id: false },
);
coordinatesSchema.pre('validate', function rejectNullIsland() {
  if (isNullIsland(this)) this.invalidate('lat', 'Coordinates (0, 0) are a missing-location placeholder');
});

/** What the punch-in geofence check found; device punches only. */
const geofenceEvidenceSchema = new mongoose.Schema(
  {
    enforced: { type: Boolean, required: true },
    distanceMeters: { type: Number, min: 0, required: true },
    allowedRadiusMeters: { type: Number, min: 0, default: null },
  },
  { _id: false },
);

/** Audit trail of a regularized day; regularization entries only. */
const regularizationAuditSchema = new mongoose.Schema(
  {
    method: { type: String, enum: Object.values(REGULARIZATION_METHODS), required: true },
    // true: approved by the regularization agent on activity evidence; false: a manager approved it.
    regularizedBySystem: { type: Boolean, required: true },
    // ──► User._id of the approving manager (manager_approved only).
    approvedByUserId: { type: ObjectId, ref: 'User', default: null },
    // ──► RegularizationReview._id when the entry came from a reviewed request.
    reviewId: { type: ObjectId, ref: 'RegularizationReview', default: null },
    evidenceEventCount: { type: Number, min: 0, default: 0 },
    reason: { type: String, trim: true, maxlength: 300, default: null },
    // The agent conversation that requested it, for tracing (e.g. "attendance:<employeeId>").
    sourceThreadId: { type: String, maxlength: 200, default: null },
    regularizedAt: { type: Date, required: true },
  },
  { _id: false },
);

const attendanceSchema = new mongoose.Schema(
  {
    entrySource: {
      type: String,
      enum: { values: Object.values(ATTENDANCE_ENTRY_SOURCES), message: 'entrySource "{VALUE}" is not valid' },
      default: ATTENDANCE_ENTRY_SOURCES.DEVICE_PUNCH,
      required: true,
      immutable: true,
    },
    // ──► EmployeeProfile._id
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    // ──► OfficeLocation._id
    officeLocationId: { type: ObjectId, ref: 'OfficeLocation', required: true, immutable: true },
    date: {
      type: String,
      required: true,
      immutable: true,
      validate: { validator: isRealCalendarDate, message: 'date must be a real calendar day as YYYY-MM-DD' },
    },
    timeZone: {
      type: String,
      required: true,
      immutable: true,
      validate: { validator: isValidIanaTimeZone, message: 'timeZone must be a valid IANA time zone' },
    },
    checkInTime: { type: Date, required: true, immutable: true },
    checkOutTime: {
      type: Date,
      default: null,
      validate: {
        validator(checkOutTime) {
          return checkOutTime === null || checkOutTime > this.checkInTime;
        },
        message: 'checkOutTime must be after checkInTime',
      },
    },
    // Device punches only (required for them by enforceEntrySourceConsistency below).
    checkInCoordinates: { type: coordinatesSchema, default: null, immutable: true },
    checkOutCoordinates: { type: coordinatesSchema, default: null },
    geofence: { type: geofenceEvidenceSchema, default: null, immutable: true },
    deviceFingerprint: {
      type: String,
      default: null,
      select: false,
      immutable: true,
      validate: { validator: (fingerprintHash) => fingerprintHash === null || /^[0-9a-f]{64}$/.test(fingerprintHash), message: 'deviceFingerprint must be a SHA-256 hex digest' },
    },
    checkInMacAddress: {
      type: String,
      default: null,
      select: false,
      immutable: true,
      validate: { validator: (macAddress) => macAddress === null || MAC_ADDRESS_PATTERN.test(macAddress), message: 'checkInMacAddress is not a valid MAC-48 address' },
    },
    calculationStatus: {
      type: String,
      enum: { values: Object.values(ATTENDANCE_STATUSES), message: 'calculationStatus "{VALUE}" is not valid' },
      required: true,
    },
    lateByMinutes: { type: Number, min: 0, default: 0 },
    // Regularization entries only.
    regularization: { type: regularizationAuditSchema, default: null, immutable: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.deviceFingerprint;
        delete ret.checkInMacAddress;
        delete ret.__v;
        return ret;
      },
    },
  },
);

/** Enforces the field rules of each entry source (see "Entry sources" above). */
attendanceSchema.pre('validate', function enforceEntrySourceConsistency() {
  if (this.entrySource === ATTENDANCE_ENTRY_SOURCES.DEVICE_PUNCH) {
    if (!this.checkInCoordinates) this.invalidate('checkInCoordinates', 'A device punch requires check-in coordinates');
    if (!this.geofence) this.invalidate('geofence', 'A device punch requires its geofence evidence');
    if (!this.deviceFingerprint) this.invalidate('deviceFingerprint', 'A device punch requires a device fingerprint');
    if (this.regularization) this.invalidate('regularization', 'A device punch cannot carry a regularization record');
    return;
  }
  if (!this.regularization) {
    this.invalidate('regularization', 'A regularization entry requires its regularization record');
    return;
  }
  if (this.checkInCoordinates || this.geofence || this.deviceFingerprint || this.checkInMacAddress) {
    this.invalidate('entrySource', 'A regularization entry cannot carry device or location evidence');
  }
  const { method, regularizedBySystem, approvedByUserId } = this.regularization;
  if (method === REGULARIZATION_METHODS.AUTOMATIC_EVIDENCE && (!regularizedBySystem || approvedByUserId)) {
    this.invalidate('regularization.regularizedBySystem', 'An automatic regularization is made by the system, without an approving user');
  }
  if (method === REGULARIZATION_METHODS.MANAGER_APPROVED && (regularizedBySystem || !approvedByUserId)) {
    this.invalidate('regularization.approvedByUserId', 'A manager-approved regularization requires the approving user');
  }
});

// One record per employee per day; also serves "my attendance history, newest first".
attendanceSchema.index({ employeeId: 1, date: -1 }, { unique: true });
// Daily reports: everyone's status for one date ("who was late today").
attendanceSchema.index({ date: 1, calculationStatus: 1 });

const Attendance = mongoose.model('Attendance', attendanceSchema);

export default Attendance;
