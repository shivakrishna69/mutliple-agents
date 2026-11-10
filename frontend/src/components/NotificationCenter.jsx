/**
 * The bell in the top bar: the unread count as a badge, and a panel with the person's notifications
 * (hooks/useNotifications.js, kept current live). Opening one marks it read and goes where it points
 * (an app path from the backend, such as a department's Questions Inbox or the person's conversation).
 *
 * Keyboard and screen readers: the button says how many are unread and whether the panel is open;
 * Escape or a click outside closes it; each notification is a button.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useNotifications } from '../hooks/useNotifications.js';
import { BellIcon } from './Icons.jsx';
import { formatDateTime } from './ui.jsx';

const MAX_BADGE = 9;

/** Navigation state that makes the target page load again even when it is the one already open. */
const freshNavigationState = () => ({ refreshedAt: Date.now() });

export default function NotificationCenter({ tone = 'light' }) {
  const { notifications, unreadCount, isLoading, error, markRead, markAllRead } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnOutsideClick = (pointerEvent) => {
      if (!containerRef.current?.contains(pointerEvent.target)) setIsOpen(false);
    };
    const closeOnEscape = (keyEvent) => {
      if (keyEvent.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  function open(notification) {
    markRead(notification.id);
    setIsOpen(false);
    if (notification.link) navigate(notification.link, { state: freshNavigationState() });
  }

  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';
  const buttonTone =
    tone === 'dark'
      ? 'text-slate-300 hover:bg-white/10 hover:text-white'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-label={label}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={`relative rounded-full p-2 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${buttonTone}`}
      >
        <BellIcon className="h-5 w-5" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white"
            aria-hidden="true"
          >
            {unreadCount > MAX_BADGE ? `${MAX_BADGE}+` : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-slate-200"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs font-semibold text-brand-600 hover:text-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto scroll-thin">
            {isLoading && <p className="px-4 py-6 text-center text-sm text-slate-500">Loading…</p>}
            {error && <p className="px-4 py-6 text-center text-sm text-rose-600">{error.message}</p>}
            {!isLoading && !error && notifications.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-slate-500">Nothing new. You're all caught up.</p>
            )}
            <ul className="divide-y divide-slate-100">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    onClick={() => open(notification)}
                    className={`flex w-full gap-3 px-4 py-3 text-left transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none ${notification.readAt ? '' : 'bg-brand-50/40'}`}
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${notification.readAt ? 'bg-transparent' : 'bg-brand-600'}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-900">
                        {notification.title}
                        {!notification.readAt && <span className="sr-only"> (unread)</span>}
                      </span>
                      <span className="mt-0.5 block text-sm text-slate-600">{notification.body}</span>
                      <span className="mt-1 block text-xs text-slate-400">
                        {formatDateTime(notification.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
