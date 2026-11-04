/**
 * Offices (models/OfficeLocation.js): HR creates and edits them, including their weekly offs, and
 * assigns each employee a base office. Field values are validated by the model; this service adds
 * the rules that need the database: unique codes, version checks, and not removing an office that
 * employees, attendance history or holidays still refer to.
 *
 * Permission checks are made by the controller; these functions assume the caller is allowed.
 */

import Attendance from '../models/Attendance.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import Holiday from '../models/Holiday.js';
import OfficeLocation from '../models/OfficeLocation.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { OFFICE_MESSAGES } from '../constants/messages.js';
import { ATTENDANCE_DEFAULTS } from '../constants/validation.js';
import { effectiveGeofenceRadiusMeters } from './attendancePolicy.js';
import { assertCurrentVersion, employeeNotFound, saveVersioned, ServiceError } from './serviceError.js';

export const officeNotFound = () =>
  new ServiceError(HTTP_STATUS.NOT_FOUND, 'OFFICE_NOT_FOUND', OFFICE_MESSAGES.OFFICE_NOT_FOUND);
const codeTaken = () => new ServiceError(HTTP_STATUS.CONFLICT, 'OFFICE_CODE_TAKEN', OFFICE_MESSAGES.OFFICE_CODE_TAKEN);

export function toOfficeSummary(office) {
  const workday = office.workday ?? {};
  return {
    id: office._id.toString(),
    name: office.name,
    code: office.code,
    coordinates: { lat: office.coordinates.lat, lng: office.coordinates.lng },
    timeZone: office.timeZone,
    geofenceRadiusMeters: effectiveGeofenceRadiusMeters(office, null),
    workday: {
      shiftStartLocalTime: workday.shiftStartLocalTime,
      shiftEndLocalTime: workday.shiftEndLocalTime,
      lateGraceMinutes: workday.lateGraceMinutes,
      halfDayAfterMinutes: workday.halfDayAfterMinutes,
      autoPunchOutAfterMinutes: workday.autoPunchOutAfterMinutes ?? ATTENDANCE_DEFAULTS.AUTO_PUNCH_OUT_AFTER_MINUTES,
      weeklyOffRules: (workday.weeklyOffRules ?? []).map((rule) => ({
        weekday: rule.weekday,
        occurrencesInMonth: [...rule.occurrencesInMonth],
      })),
    },
    version: office.__v,
  };
}

const saveOffice = (office) => saveVersioned(office, { onDuplicateKey: codeTaken });

export async function listOffices() {
  const offices = await OfficeLocation.find({}).sort({ name: 1 });
  return offices.map(toOfficeSummary);
}

export async function getOffice(officeLocationId) {
  const office = await OfficeLocation.findById(officeLocationId);
  if (!office) throw officeNotFound();
  return toOfficeSummary(office);
}

/** Weekly offs default to the model's DEFAULT_WEEKLY_OFF_RULES when none are given. */
export async function createOffice(fields) {
  const office = new OfficeLocation(fields);
  await saveOffice(office);
  return toOfficeSummary(office);
}

/** `changes` holds only the fields to change; `coordinates` and `workday` are merged field by field. */
export async function updateOffice({ officeLocationId, changes, version }) {
  const office = await OfficeLocation.findById(officeLocationId);
  if (!office) throw officeNotFound();
  assertCurrentVersion(office, version);
  const { coordinates, workday, ...topLevelChanges } = changes;
  office.set(topLevelChanges);
  if (coordinates) office.set({ coordinates: { ...office.coordinates.toObject(), ...coordinates } });
  if (workday) {
    for (const [workdayField, value] of Object.entries(workday)) office.set(`workday.${workdayField}`, value);
  }
  await saveOffice(office);
  return toOfficeSummary(office);
}

/** Refused while employees, attendance history or holidays refer to the office. */
export async function deleteOffice(officeLocationId) {
  const office = await OfficeLocation.findById(officeLocationId);
  if (!office) throw officeNotFound();
  const [employeeCount, attendanceCount, holidayCount] = await Promise.all([
    EmployeeProfile.countDocuments({ 'organizationData.officeLocationId': office._id }),
    Attendance.countDocuments({ officeLocationId: office._id }),
    Holiday.countDocuments({ officeLocationIds: office._id }),
  ]);
  if (employeeCount + attendanceCount + holidayCount > 0) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'OFFICE_IN_USE', OFFICE_MESSAGES.OFFICE_IN_USE);
  }
  await office.deleteOne();
  return toOfficeSummary(office);
}

/**
 * Sets (or clears, with null) an employee's base office. Saved through the document, because the
 * profile's reference checks run in document middleware that query updates skip.
 */
export async function assignEmployeeOffice({ employeeId, officeLocationId }) {
  const profile = await EmployeeProfile.findById(employeeId);
  if (!profile) throw employeeNotFound();
  if (officeLocationId && !(await OfficeLocation.exists({ _id: officeLocationId }))) throw officeNotFound();
  profile.organizationData.officeLocationId = officeLocationId;
  await profile.save();
  return { employeeId: profile._id.toString(), officeLocationId };
}

/**
 * Sets an employee's own punch-in radius, which replaces their office's (someone working from a
 * large campus, or a site with poor GPS). null goes back to the office's radius. Range checks are
 * the model's.
 */
export async function setEmployeeGeofenceRadius({ employeeId, geofenceRadiusMeters }) {
  const profile = await EmployeeProfile.findById(employeeId).select('+biometricMetadata.allowedGeofenceRadius');
  if (!profile) throw employeeNotFound();
  profile.set('biometricMetadata.allowedGeofenceRadius', geofenceRadiusMeters);
  await profile.save();
  return { employeeId: profile._id.toString(), geofenceRadiusMeters };
}
