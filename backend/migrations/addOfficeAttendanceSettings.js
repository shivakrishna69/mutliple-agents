/**
 * Gives offices created before these settings existed the defaults (constants/validation.js
 * ATTENDANCE_DEFAULTS): a punch-in radius and the delay after which a forgotten punch-out is closed.
 * HR can change both per office afterwards. Values already set are not touched.
 */

import { ATTENDANCE_DEFAULTS } from '../constants/validation.js';
import OfficeLocation from '../models/OfficeLocation.js';

export default Object.freeze({
  name: 'add-office-attendance-settings',
  async run() {
    const [radiusResult, autoPunchOutResult] = await Promise.all([
      OfficeLocation.updateMany(
        { geofenceRadiusMeters: { $exists: false } },
        { $set: { geofenceRadiusMeters: ATTENDANCE_DEFAULTS.OFFICE_GEOFENCE_RADIUS_METRES } },
      ),
      OfficeLocation.updateMany(
        { 'workday.autoPunchOutAfterMinutes': { $exists: false } },
        { $set: { 'workday.autoPunchOutAfterMinutes': ATTENDANCE_DEFAULTS.AUTO_PUNCH_OUT_AFTER_MINUTES } },
      ),
    ]);
    return { changedCount: radiusResult.modifiedCount + autoPunchOutResult.modifiedCount };
  },
});
