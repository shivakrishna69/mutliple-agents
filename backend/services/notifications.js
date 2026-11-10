/**
 * In-app notifications (models/Notification.js): stored, then pushed to the person's open sessions.
 *
 *   notifyUsers(userIds, build)        one notification per person; `build(userId)` gives its content.
 *                                      Never throws: a notification is a courtesy, and failing to
 *                                      store one must not undo the work it reports (logged instead)
 *   listNotifications(userId, opts)    newest first, with the unread count
 *   markNotificationRead(userId, id)   only the person's own; 404 otherwise
 *   markAllNotificationsRead(userId)
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { NOTIFICATION_MESSAGES } from '../constants/messages.js';
import { NOTIFICATION_SETTINGS } from '../constants/validation.js';
import Notification from '../models/Notification.js';
import { logger } from '../utils/logger.js';
import { emitNotification } from '../utils/socketManager.js';
import { ServiceError } from './serviceError.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function toNotificationSummary(notification) {
  return {
    id: notification._id.toString(),
    type: notification.type,
    title: notification.title,
    body: notification.body,
    link: notification.link ?? null,
    data: notification.data ?? {},
    readAt: notification.readAt ?? null,
    createdAt: notification.createdAt,
  };
}

/**
 * @param {Array<string|object>} userIds
 * @param {(userId: string) => { type: string, title: string, body: string, link?: string|null, data?: object }} build
 * @returns {Promise<number>} how many were stored
 */
export async function notifyUsers(userIds, build) {
  const recipients = [...new Set(userIds.filter(Boolean).map(String))];
  let stored = 0;
  for (const userId of recipients) {
    try {
      const content = build(userId);
      const notification = await Notification.create({
        userId,
        type: content.type,
        title: content.title,
        body: content.body,
        link: content.link ?? null,
        data: content.data ?? {},
        expiresAt: new Date(Date.now() + NOTIFICATION_SETTINGS.RETENTION_DAYS * DAY_MS),
      });
      stored += 1;
      emitNotification(userId, toNotificationSummary(notification));
    } catch (notifyError) {
      logger.error('Notification could not be stored', {
        userId,
        error: { name: notifyError.name, message: notifyError.message },
      });
    }
  }
  return stored;
}

export async function listNotifications(userId, { unreadOnly = false } = {}) {
  const filter = { userId, ...(unreadOnly ? { readAt: null } : {}) };
  const [notifications, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(NOTIFICATION_SETTINGS.LISTED).lean(),
    Notification.countDocuments({ userId, readAt: null }),
  ]);
  return { notifications: notifications.map(toNotificationSummary), unreadCount };
}

export async function markNotificationRead(userId, notificationId) {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    [{ $set: { readAt: { $ifNull: ['$readAt', '$$NOW'] } } }],
    { new: true },
  ).lean();
  if (!notification) throw new ServiceError(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', NOTIFICATION_MESSAGES.NOT_FOUND);
  return toNotificationSummary(notification);
}

export async function markAllNotificationsRead(userId) {
  const { modifiedCount } = await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
  return { marked: modifiedCount };
}
