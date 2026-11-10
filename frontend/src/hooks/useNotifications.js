/**
 * The signed-in person's in-app notifications, kept current live:
 *
 *   const { notifications, unreadCount, isLoading, error, markRead, markAllRead } = useNotifications();
 *
 *   - Loaded from GET /api/notifications on mount (hooks/useApiResource.js).
 *   - New ones arrive on the socket (NOTIFICATION_CREATED) and go to the top at once.
 *   - After the socket reconnects the list is loaded again, since events sent while it was
 *     disconnected are not replayed.
 *   - markRead(id) and markAllRead() update the list straight away and tell the backend; a failure
 *     reloads the list so it never shows a state the server does not have.
 *
 * Call it once, in the app shell: each call opens its own socket.
 */

import { useCallback, useEffect, useRef } from 'react';
import { requestAllNotificationsRead, requestNotificationRead, requestNotifications } from '../api/notificationsApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { SOCKET_CONNECTION_STATUS } from '../constants/socketEvents.js';
import { useApiResource } from './useApiResource.js';
import { useSocket } from './useSocket.js';

const EMPTY = Object.freeze({ notifications: [], unreadCount: 0 });

export function useNotifications() {
  const { csrfToken } = useAuth();
  const resource = useApiResource((signal) => requestNotifications(signal), []);
  const { setData, reload } = resource;
  const { notifications, unreadCount } = resource.data ?? EMPTY;

  const { connectionStatus } = useSocket({
    onNotificationCreated: (notification) =>
      setData((current) => {
        const { notifications: existing, unreadCount: count } = current ?? EMPTY;
        return {
          notifications: [notification, ...existing.filter((candidate) => candidate.id !== notification.id)],
          unreadCount: notification.readAt ? count : count + 1,
        };
      }),
  });

  // A reconnect may have missed notifications: load them again (not on the first connection).
  const hasConnected = useRef(false);
  useEffect(() => {
    if (connectionStatus !== SOCKET_CONNECTION_STATUS.CONNECTED) return;
    if (hasConnected.current) reload();
    hasConnected.current = true;
  }, [connectionStatus, reload]);

  const markRead = useCallback(
    async (notificationId) => {
      const target = notifications.find((notification) => notification.id === notificationId);
      if (!target || target.readAt) return;
      const readAt = new Date().toISOString();
      setData((current) => ({
        notifications: current.notifications.map((notification) =>
          notification.id === notificationId ? { ...notification, readAt } : notification,
        ),
        unreadCount: Math.max(0, current.unreadCount - 1),
      }));
      try {
        await requestNotificationRead(notificationId, csrfToken);
      } catch {
        reload();
      }
    },
    [notifications, setData, csrfToken, reload],
  );

  const markAllRead = useCallback(async () => {
    const readAt = new Date().toISOString();
    setData((current) => ({
      notifications: (current ?? EMPTY).notifications.map((notification) => ({
        ...notification,
        readAt: notification.readAt ?? readAt,
      })),
      unreadCount: 0,
    }));
    try {
      await requestAllNotificationsRead(csrfToken);
    } catch {
      reload();
    }
  }, [setData, csrfToken, reload]);

  return { notifications, unreadCount, isLoading: resource.isLoading, error: resource.error, markRead, markAllRead };
}
