/**
 * Whether someone's presence (available / away / offline) is recorded, and their acknowledgement of
 * the notice that says what is recorded and why.
 *
 * Presence is recorded only while the company has it switched on (company settings `presence`) and
 * only for people who acknowledged the current notice (PRESENCE_NOTICE_VERSION): nobody's activity
 * is kept before they have been told about it.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { PRESENCE_MESSAGES } from '../constants/messages.js';
import { PRESENCE_NOTICE_VERSION } from '../constants/validation.js';
import User from '../models/User.js';
import { getCompanySettings, toPresenceSettings } from './companySettings.js';
import { ServiceError } from './serviceError.js';

/** The company's presence settings. */
export async function loadPresenceSettings() {
  return toPresenceSettings(await getCompanySettings());
}

/**
 * What the signed-in person's app needs: whether to report activity, after how long idle counts as
 * Away, and whether the notice still has to be shown.
 */
export async function getOwnPresenceSetup(userId) {
  const [settings, user] = await Promise.all([
    loadPresenceSettings(),
    User.findById(userId).select('presenceNotice').lean(),
  ]);
  const acknowledgedVersion = user?.presenceNotice?.version ?? null;
  const isAcknowledged = acknowledgedVersion === PRESENCE_NOTICE_VERSION;
  return {
    isTracked: settings.enabled && isAcknowledged,
    enabled: settings.enabled,
    awayAfterMinutes: settings.awayAfterMinutes,
    notice: {
      version: PRESENCE_NOTICE_VERSION,
      acknowledgedVersion,
      acknowledgedAt: user?.presenceNotice?.acknowledgedAt?.toISOString() ?? null,
      isAcknowledged,
    },
  };
}

/**
 * Records that the person read the current notice. Acknowledging an older version is refused, so a
 * page that has been open since the notice changed cannot acknowledge text it never showed.
 * @throws {ServiceError} 409 NOTICE_OUTDATED
 */
export async function acknowledgePresenceNotice({ userId, version, now = new Date() }) {
  if (version !== PRESENCE_NOTICE_VERSION) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'NOTICE_OUTDATED', PRESENCE_MESSAGES.NOTICE_OUTDATED);
  }
  await User.updateOne({ _id: userId }, { $set: { presenceNotice: { version, acknowledgedAt: now } } });
  return getOwnPresenceSetup(userId);
}

/** Whether this person's activity may be recorded now. */
export async function isPresenceRecorded(userId) {
  return (await getOwnPresenceSetup(userId)).isTracked;
}
