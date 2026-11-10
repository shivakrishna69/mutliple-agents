/**
 * The signed-in person's in-app notifications (backend/controllers/notificationController.js):
 *   GET  /api/notifications                  newest first, with the unread count
 *   POST /api/notifications/:id/read
 *   POST /api/notifications/read-all
 * Each returns the response's `data`; failures throw ApiError (api/httpClient.js).
 */

import { sendApiRequest } from './httpClient.js';

export async function requestNotifications(callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath: '/api/notifications', callerSignal });
  return responseData;
}

export async function requestNotificationRead(notificationId, csrfToken) {
  const { responseData } = await sendApiRequest({
    method: 'POST',
    endpointPath: `/api/notifications/${encodeURIComponent(notificationId)}/read`,
    csrfToken,
  });
  return responseData;
}

export async function requestAllNotificationsRead(csrfToken) {
  const { responseData } = await sendApiRequest({
    method: 'POST',
    endpointPath: '/api/notifications/read-all',
    csrfToken,
  });
  return responseData;
}
