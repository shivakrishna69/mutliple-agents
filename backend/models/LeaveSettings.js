/**
 * LeaveSettings: the company's leave settings, one document (key "company"), created with the
 * defaults below on first use and changed by HR.
 *
 *   leaveYearStartMonth   month (1-12) the leave year starts in; April matches the Indian financial
 *                         year. It cannot change once leave has been recorded, because every ledger
 *                         entry and balance is filed under a leave year.
 *   defaultTimeZone       IANA zone that decides "today" for employees without a base office; an
 *                         employee with an office uses the office's zone.
 */

import mongoose from 'mongoose';
import { isValidIanaTimeZone } from './OfficeLocation.js';

export const LEAVE_SETTINGS_KEY = 'company';

/** Settings for a new installation; HR changes them through the API. */
export const DEFAULT_LEAVE_SETTINGS = Object.freeze({
  leaveYearStartMonth: 4,
  defaultTimeZone: 'Asia/Kolkata',
});

const leaveSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, immutable: true, enum: [LEAVE_SETTINGS_KEY] },
    leaveYearStartMonth: {
      type: Number,
      required: true,
      default: DEFAULT_LEAVE_SETTINGS.leaveYearStartMonth,
      validate: {
        validator: (month) => Number.isInteger(month) && month >= 1 && month <= 12,
        message: 'Leave year start month must be 1 (January) to 12 (December)',
      },
    },
    defaultTimeZone: {
      type: String,
      required: true,
      default: DEFAULT_LEAVE_SETTINGS.defaultTimeZone,
      validate: { validator: isValidIanaTimeZone, message: 'Time zone "{VALUE}" is not a valid IANA time zone' },
    },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

export default mongoose.model('LeaveSettings', leaveSettingsSchema);
