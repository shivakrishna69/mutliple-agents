/**
 * The signed-in person's in-app notifications (services/notifications.js), mounted at
 * /api/notifications. Everyone signed in; each person sees only their own.
 *
 *   GET  /?unread=true        newest first (at most NOTIFICATION_SETTINGS.LISTED), with the unread count
 *   POST /:notificationId/read
 *   POST /read-all
 */

import { NOTIFICATION_MESSAGES } from '../constants/messages.js';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../services/notifications.js';
import { validateNotificationQuery } from '../validators/agentChatValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const notificationHandler = createWorkforceHandlerFactory({
  auditCategory: 'notifications',
  restrictedMessage: NOTIFICATION_MESSAGES.NOT_FOUND,
  inputInvalidMessage: NOTIFICATION_MESSAGES.INPUT_INVALID,
});
const OWN_READ = Object.freeze({ isWrite: false });
// Marking as read changes nothing anyone else sees; it is not audited.
const OWN_UPDATE = Object.freeze({ isWrite: false });

export const getNotifications = notificationHandler('list_notifications', OWN_READ, async (req) => {
  const validation = validateNotificationQuery(req.query);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  return {
    message: NOTIFICATION_MESSAGES.RETRIEVED,
    data: await listNotifications(req.user.id, validation.sanitizedInput),
  };
});

export const postNotificationRead = notificationHandler('read_notification', OWN_UPDATE, async (req) => {
  const invalid = idParamErrors(req.params, 'notificationId');
  if (invalid) return { validationErrors: invalid };
  return {
    message: NOTIFICATION_MESSAGES.MARKED_READ,
    data: { notification: await markNotificationRead(req.user.id, req.params.notificationId) },
  };
});

export const postAllNotificationsRead = notificationHandler('read_all_notifications', OWN_UPDATE, async (req) => ({
  message: NOTIFICATION_MESSAGES.ALL_MARKED_READ,
  data: await markAllNotificationsRead(req.user.id),
}));
