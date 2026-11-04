/**
 * PresenceInterval: one stretch of time a person was available or away in the app, written by
 * services/presence.js as their status changes. Offline is the absence of an open interval, so it
 * is never stored; a day's offline time is what the intervals leave uncovered.
 *
 *   state       available (used the computer within the company's away-after minutes, app open) or
 *               away (idle that long, or the screen locked)
 *   startedAt   when the state began
 *   lastSeenAt  the latest report while it lasted (a report about every minute); if reports stop
 *               without a disconnect (a crashed server, a frozen tab), the interval is closed here
 *   endedAt     when it ended; null while it lasts
 *   isOpen      true while it lasts. At most one open interval per person (a partial unique index),
 *               so two servers seeing the same change cannot both open one.
 *
 * Kept for the company's presence.detailRetentionDays after they end (services/presenceJobs.js);
 * daily totals outlive them in PresenceDaySummary.
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const PRESENCE_STATES = Object.freeze({ AVAILABLE: 'available', AWAY: 'away' });

const presenceIntervalSchema = new mongoose.Schema({
  // ──► User._id: everyone signed in has presence, with or without an employee profile.
  userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
  state: { type: String, enum: Object.values(PRESENCE_STATES), required: true, immutable: true },
  startedAt: { type: Date, required: true, immutable: true },
  lastSeenAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  isOpen: { type: Boolean, required: true },
});

presenceIntervalSchema.index(
  { userId: 1 },
  { name: 'one_open_interval_per_user', unique: true, partialFilterExpression: { isOpen: true } },
);
// A person's intervals over a day, and everyone's current status.
presenceIntervalSchema.index({ userId: 1, startedAt: 1 });
// Open intervals whose reports stopped; and the deletion of old ones.
presenceIntervalSchema.index({ isOpen: 1, lastSeenAt: 1 });
presenceIntervalSchema.index({ endedAt: 1 });

export default mongoose.model('PresenceInterval', presenceIntervalSchema);
