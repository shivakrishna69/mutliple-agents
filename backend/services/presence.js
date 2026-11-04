/**
 * Presence: whether each person is available, away or offline, set automatically from the app,
 * never by the person.
 *
 * Signals
 *   Each open copy of the app reports its device's activity over its socket
 *   (utils/realtime/presenceHandlers.js): "active" (keyboard or mouse used within the company's
 *   presence.awayAfterMinutes) or "idle" (not used for that long, or the screen locked), when it
 *   changes and every PRESENCE_TIMING.REPORT_INTERVAL_SECONDS. Nothing else is reported: no keys,
 *   no screens, no sites or programs.
 *
 * A person's status (combineDeviceActivity)
 *   available   any of their devices is active
 *   away        all of them are idle
 *   offline     none is connected (a closed app, a sleeping laptop: the socket's heartbeat notices
 *               within about 45 seconds), or reports stopped for PRESENCE_TIMING.STALE_AFTER_SECONDS
 *
 * Each change is stored as an interval (models/PresenceInterval.js) and published to the person,
 * HR and administrators, and the person's manager (utils/realtime/presenceHandlers.js). Only people
 * whose presence is recorded (services/presenceSettings.js) are tracked at all.
 */

import mongoose from 'mongoose';
import EmployeeProfile from '../models/EmployeeProfile.js';
import PresenceInterval, { PRESENCE_STATES } from '../models/PresenceInterval.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';

export const PRESENCE_TIMING = Object.freeze({
  // How often an open app reports while nothing changes.
  REPORT_INTERVAL_SECONDS: 60,
  // An open interval with no report for this long is closed (three missed reports).
  STALE_AFTER_SECONDS: 180,
});

/** What a device reports. */
export const DEVICE_ACTIVITY = Object.freeze({ ACTIVE: 'active', IDLE: 'idle' });

export const PRESENCE_STATUSES = Object.freeze({ ...PRESENCE_STATES, OFFLINE: 'offline' });

/** A person's status from what each of their connected devices last reported. */
export function combineDeviceActivity(deviceActivities) {
  if (deviceActivities.length === 0) return PRESENCE_STATUSES.OFFLINE;
  return deviceActivities.includes(DEVICE_ACTIVITY.ACTIVE) ? PRESENCE_STATUSES.AVAILABLE : PRESENCE_STATUSES.AWAY;
}

/**
 * Records a person's status at `now`. The same status extends the open interval; another closes it
 * and, unless offline, opens a new one.
 * @returns {Promise<{ changed: boolean, status: string, since: Date|null }>}
 */
export async function recordPresence({ userId, status, now = new Date() }) {
  const openInterval = await PresenceInterval.findOne({ userId, isOpen: true }).lean();
  if (openInterval?.state === status) {
    await PresenceInterval.updateOne({ _id: openInterval._id, isOpen: true }, { $max: { lastSeenAt: now } });
    return { changed: false, status, since: openInterval.startedAt };
  }
  if (!openInterval && status === PRESENCE_STATUSES.OFFLINE) return { changed: false, status, since: null };

  if (openInterval) {
    await PresenceInterval.updateOne(
      { _id: openInterval._id, isOpen: true },
      { $set: { isOpen: false, endedAt: now } },
    );
  }
  if (status === PRESENCE_STATUSES.OFFLINE) return { changed: true, status, since: now };
  try {
    await PresenceInterval.create({ userId, state: status, startedAt: now, lastSeenAt: now, isOpen: true });
  } catch (creationError) {
    // Another server recorded the same change at the same moment, and published it.
    if (!isDuplicateKeyError(creationError)) throw creationError;
    return { changed: false, status, since: now };
  }
  return { changed: true, status, since: now };
}

/**
 * A change as it is published (utils/realtime/presenceHandlers.js emitPresenceChange), and who
 * receives it besides the person, HR and administrators: their manager.
 * @returns {Promise<{ update: { userId, employeeId, status, since }, reportingManagerId: string|null }>}
 */
export async function describePresenceChange(userId, { status, since }) {
  const profile = await EmployeeProfile.findOne({ userId }).select('_id organizationData.reportingManagerId').lean();
  return {
    update: {
      userId: userId.toString(),
      employeeId: profile?._id.toString() ?? null,
      status,
      since: since?.toISOString() ?? null,
    },
    reportingManagerId: profile?.organizationData?.reportingManagerId?.toString() ?? null,
  };
}

/**
 * Each person's status now, from their open interval, and when they were last seen.
 * @param {string[]} userIds
 * @returns {Promise<Map<string, { status: string, since: Date|null, lastSeenAt: Date|null }>>}
 */
export async function loadCurrentPresence(userIds) {
  const [openIntervals, lastEnded] = await Promise.all([
    PresenceInterval.find({ userId: { $in: userIds }, isOpen: true })
      .select('userId state startedAt lastSeenAt')
      .lean(),
    PresenceInterval.aggregate([
      { $match: { userId: { $in: userIds.map((userId) => new mongoose.Types.ObjectId(userId)) }, isOpen: false } },
      { $group: { _id: '$userId', lastSeenAt: { $max: '$endedAt' } } },
    ]),
  ]);
  const lastSeenByUserId = new Map(lastEnded.map((entry) => [entry._id.toString(), entry.lastSeenAt]));
  const openByUserId = new Map(openIntervals.map((interval) => [interval.userId.toString(), interval]));
  return new Map(
    userIds.map((userId) => {
      const openInterval = openByUserId.get(userId);
      return [
        userId,
        openInterval
          ? { status: openInterval.state, since: openInterval.startedAt, lastSeenAt: openInterval.lastSeenAt }
          : { status: PRESENCE_STATUSES.OFFLINE, since: null, lastSeenAt: lastSeenByUserId.get(userId) ?? null },
      ];
    }),
  );
}

/**
 * Closes open intervals whose reports stopped (a server that died, a frozen tab) at their last
 * report: those people are now offline.
 * @returns {Promise<{ closed: { userId: string, since: Date }[] }>}  to publish
 */
export async function closeStalePresence({ now = new Date() } = {}) {
  const staleBefore = new Date(now.getTime() - PRESENCE_TIMING.STALE_AFTER_SECONDS * 1000);
  const staleIntervals = await PresenceInterval.find({ isOpen: true, lastSeenAt: { $lt: staleBefore } })
    .select('userId lastSeenAt')
    .lean();
  const closed = [];
  for (const interval of staleIntervals) {
    const { modifiedCount } = await PresenceInterval.updateOne(
      { _id: interval._id, isOpen: true },
      { $set: { isOpen: false, endedAt: interval.lastSeenAt } },
    );
    if (modifiedCount > 0) closed.push({ userId: interval.userId.toString(), since: interval.lastSeenAt });
  }
  return { closed };
}
