/**
 * OfficeLocation model: a physical work site, the reference point for attendance geofencing and
 * the source of the local working-day rules.
 *
 * Relationship vectors
 * --------------------
 *   EmployeeProfile.organizationData.officeLocationId ──► OfficeLocation._id  (many-to-one)
 *       The employee's base office. On-site and hybrid employees must punch in within their
 *       geofence radius (EmployeeProfile.biometricMetadata.allowedGeofenceRadius) of
 *       `coordinates`. Remote employees still have a base office, because its `timeZone` and
 *       `workday` define their attendance date and lateness.
 *   Attendance.officeLocationId ──► OfficeLocation._id   (the office the punch was checked against)
 *
 * Time
 * ----
 *   `timeZone` is an IANA zone ("Asia/Kolkata"). Attendance dates and lateness are computed in the
 *   office's local time from the server clock, never from the client's clock, so a punch cannot be
 *   backdated by changing the phone's time. Shifts that cross midnight are not modelled: a shift
 *   starts and is judged on the same local calendar day.
 *
 *   workday.shiftStartLocalTime   "HH:MM", when the working day starts
 *   workday.shiftEndLocalTime     "HH:MM", when it ends (later than the start); together they bound
 *                                 the hours in which activity can prove work and in which a
 *                                 regularized punch-in may fall
 *   workday.lateGraceMinutes      arriving up to this many minutes after the start is still Normal
 *   workday.halfDayAfterMinutes   arriving more than this many minutes after the start is Half_Day;
 *                                 between the grace period and this, the punch is Late
 */

import mongoose from 'mongoose';
import { ATTENDANCE_FIELD_LIMITS, DEPARTMENT_CODE_PATTERN, LOCAL_TIME_PATTERN } from '../constants/validation.js';
import { isNullIsland, isValidLatitude, isValidLongitude } from '../utils/geoDistance.js';

/** True when `timeZone` is an IANA zone this runtime knows ("Asia/Kolkata", "UTC"). */
export function isValidIanaTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const officeLocationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Office name is required'],
      trim: true,
      minlength: 1,
      maxlength: ATTENDANCE_FIELD_LIMITS.OFFICE_NAME_MAX_LENGTH,
    },
    code: {
      type: String,
      required: [true, 'Office code is required'],
      unique: true,
      trim: true,
      uppercase: true,
      match: [DEPARTMENT_CODE_PATTERN, 'Office code "{VALUE}" must be 2–20 letters, digits, "-" or "_"'],
    },
    // Centre of the geofence, WGS-84 degrees.
    coordinates: {
      lat: {
        type: Number,
        required: [true, 'Office latitude is required'],
        validate: { validator: isValidLatitude, message: 'Office latitude must be between -90 and 90' },
      },
      lng: {
        type: Number,
        required: [true, 'Office longitude is required'],
        validate: { validator: isValidLongitude, message: 'Office longitude must be between -180 and 180' },
      },
    },
    timeZone: {
      type: String,
      required: [true, 'Office time zone is required'],
      validate: { validator: isValidIanaTimeZone, message: 'Time zone "{VALUE}" is not a valid IANA time zone' },
    },
    workday: {
      shiftStartLocalTime: {
        type: String,
        required: [true, 'Shift start time is required'],
        match: [LOCAL_TIME_PATTERN, 'Shift start time must be HH:MM (24-hour)'],
      },
      shiftEndLocalTime: {
        type: String,
        required: [true, 'Shift end time is required'],
        match: [LOCAL_TIME_PATTERN, 'Shift end time must be HH:MM (24-hour)'],
      },
      lateGraceMinutes: {
        type: Number,
        default: 15,
        min: [0, 'Late grace cannot be negative'],
        max: [ATTENDANCE_FIELD_LIMITS.LATE_GRACE_MAX_MINUTES, `Late grace cannot exceed ${ATTENDANCE_FIELD_LIMITS.LATE_GRACE_MAX_MINUTES} minutes`],
        validate: { validator: Number.isInteger, message: 'Late grace must be a whole number of minutes' },
      },
      halfDayAfterMinutes: {
        type: Number,
        default: 240,
        min: [1, 'Half-day threshold must be at least 1 minute'],
        max: [ATTENDANCE_FIELD_LIMITS.HALF_DAY_AFTER_MAX_MINUTES, `Half-day threshold cannot exceed ${ATTENDANCE_FIELD_LIMITS.HALF_DAY_AFTER_MAX_MINUTES} minutes`],
        validate: { validator: Number.isInteger, message: 'Half-day threshold must be a whole number of minutes' },
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

officeLocationSchema.pre('validate', function enforceOfficeConsistency() {
  if (this.coordinates && isNullIsland(this.coordinates)) {
    this.invalidate('coordinates', 'Office coordinates (0, 0) are a missing-location placeholder, not a real site');
  }
  if (this.workday?.shiftStartLocalTime && this.workday?.shiftEndLocalTime && this.workday.shiftEndLocalTime <= this.workday.shiftStartLocalTime) {
    // "HH:MM" strings compare correctly as text. Shifts crossing midnight are not supported.
    this.invalidate('workday.shiftEndLocalTime', 'The shift must end later on the same day than it starts');
  }
  if (this.workday && this.workday.halfDayAfterMinutes <= this.workday.lateGraceMinutes) {
    this.invalidate('workday.halfDayAfterMinutes', 'The half-day threshold must be later than the late grace period');
  }
});

const OfficeLocation = mongoose.model('OfficeLocation', officeLocationSchema);

export default OfficeLocation;
