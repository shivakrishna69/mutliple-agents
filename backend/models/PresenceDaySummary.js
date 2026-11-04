/**
 * PresenceDaySummary: one employee's presence totals for one day (services/presenceMetrics.js),
 * written each night for the day before (services/presenceJobs.js). They outlive the intervals
 * they come from (company presence.detailRetentionDays) and are kept for summaryRetentionDays.
 * Rewriting a day replaces its totals, so the nightly job may run any number of times.
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const minutesField = { type: Number, min: 0, required: true };

const presenceDaySummarySchema = new mongoose.Schema(
  {
    // ──► EmployeeProfile._id and its User._id
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    // "YYYY-MM-DD" in `timeZone`, the employee's office's (or the company's) zone.
    date: { type: String, required: true, immutable: true },
    timeZone: { type: String, required: true },
    availableMinutes: minutesField,
    awayMinutes: minutesField,
    onlineMinutes: minutesField,
    offlineDuringShiftMinutes: { type: Number, min: 0, default: null },
    firstSeenAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    // From attendance (services/attendanceToday.js): the day's status and the minutes punched in.
    attendanceStatus: { type: String, required: true },
    workedMinutes: { type: Number, min: 0, default: null },
  },
  { timestamps: true },
);

presenceDaySummarySchema.index({ employeeId: 1, date: 1 }, { unique: true });
// Everyone's day, and deleting old days.
presenceDaySummarySchema.index({ date: 1 });

export default mongoose.model('PresenceDaySummary', presenceDaySummarySchema);
