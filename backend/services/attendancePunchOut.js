/**
 * Closing punches: the employee's own punch-out (controllers/attendanceController.js), and the
 * automatic one for punches still open after the shift (closeForgottenPunchOuts, run by
 * services/attendanceScheduler.js). When a punch is closed automatically is decided by
 * automaticPunchOut (services/attendancePolicy.js).
 *
 * A punch is closed by one update conditional on it still being open, so the employee and the job
 * (or two servers) closing it at the same moment close it once.
 */

import Attendance, { ATTENDANCE_CHECK_OUT_SOURCES, ATTENDANCE_ENTRY_SOURCES } from '../models/Attendance.js';
import OfficeLocation from '../models/OfficeLocation.js';
import { automaticPunchOut, workedMinutesBetween } from './attendancePolicy.js';

/**
 * Closes an open punch. Returns the closed record, or null when it was already closed.
 * @param {{ _id: object, checkInTime: Date }} punch
 * @param {{ checkOutTime: Date, source: string, coordinates?: object|null, distanceMeters?: number|null }} closing
 */
export async function closePunch(punch, { checkOutTime, source, coordinates = null, distanceMeters = null }) {
  return Attendance.findOneAndUpdate(
    { _id: punch._id, checkOutTime: null },
    {
      $set: {
        checkOutTime,
        checkOutSource: source,
        checkOutCoordinates: coordinates,
        checkOutDistanceMeters: distanceMeters,
        workedMinutes: workedMinutesBetween(punch.checkInTime, checkOutTime),
      },
    },
    { new: true },
  ).lean();
}

/** Closes, at its automatic check-out time, a punch whose deadline has passed. Null otherwise. */
export async function closeIfOverdue(punch, office, now) {
  const { closeAt, deadline } = automaticPunchOut(punch, office);
  if (now < deadline) return null;
  return closePunch(punch, { checkOutTime: closeAt, source: ATTENDANCE_CHECK_OUT_SOURCES.AUTO_CLOSED });
}

/**
 * Closes every punch still open past its deadline.
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ closedCount: number }>}
 */
export async function closeForgottenPunchOuts({ now = new Date() } = {}) {
  const openPunches = await Attendance.find({
    checkOutTime: null,
    entrySource: ATTENDANCE_ENTRY_SOURCES.DEVICE_PUNCH,
  })
    .select('date checkInTime officeLocationId')
    .lean();
  if (openPunches.length === 0) return { closedCount: 0 };

  const officeIds = openPunches.map((punch) => punch.officeLocationId).filter(Boolean);
  const offices = await OfficeLocation.find({ _id: { $in: officeIds } })
    .select('timeZone workday.shiftEndLocalTime workday.autoPunchOutAfterMinutes')
    .lean();
  const officeById = new Map(offices.map((office) => [office._id.toString(), office]));

  let closedCount = 0;
  for (const punch of openPunches) {
    // A punch made without a base office (officeLocationId null) closes on its own time limit.
    const office = punch.officeLocationId ? officeById.get(punch.officeLocationId.toString()) : null;
    if (punch.officeLocationId && !office) continue;
    if (await closeIfOverdue(punch, office, now)) closedCount += 1;
  }
  return { closedCount };
}
