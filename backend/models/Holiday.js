/**
 * Holiday model: a day off for the whole company or for some offices, set by HR.
 *
 *   officeLocationIds ──► OfficeLocation._id (many-to-many)
 *       Empty = every office (a national holiday). Otherwise only the listed offices, which is how
 *       state or city holidays are kept (for example a festival observed in one state only).
 *
 * `date` is a calendar day ("YYYY-MM-DD") in each office's own time zone, the same form as
 * Attendance.date. services/workCalendar.js combines holidays with each office's weekly offs.
 *
 * Two holidays may not cover the same date for the same office; services/workCalendar.js checks
 * this before saving. Without multi-document transactions two simultaneous saves could both pass;
 * a duplicate would only name the day twice, never change which days are working days.
 */

import mongoose from 'mongoose';
import { WORK_CALENDAR_LIMITS } from '../constants/validation.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';

const { ObjectId } = mongoose.Schema.Types;

const holidaySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Holiday name is required'],
      trim: true,
      minlength: WORK_CALENDAR_LIMITS.HOLIDAY_NAME_MIN_LENGTH,
      maxlength: WORK_CALENDAR_LIMITS.HOLIDAY_NAME_MAX_LENGTH,
    },
    date: {
      type: String,
      required: [true, 'Holiday date is required'],
      validate: { validator: isRealCalendarDate, message: 'Holiday date must be a real calendar day as YYYY-MM-DD' },
    },
    // Empty = every office.
    officeLocationIds: {
      type: [{ type: ObjectId, ref: 'OfficeLocation' }],
      default: [],
      validate: {
        validator: (officeIds) =>
          officeIds.length <= WORK_CALENDAR_LIMITS.MAX_OFFICES_PER_HOLIDAY &&
          new Set(officeIds.map(String)).size === officeIds.length,
        message: `A holiday can list at most ${WORK_CALENDAR_LIMITS.MAX_OFFICES_PER_HOLIDAY} distinct offices`,
      },
    },
    createdByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    updatedByUserId: { type: ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Calendar ranges ("holidays between two dates") and the per-date clash check.
holidaySchema.index({ date: 1 });

export default mongoose.model('Holiday', holidaySchema);
