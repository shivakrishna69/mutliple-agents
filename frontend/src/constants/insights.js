/**
 * The daily briefing's values and the labels of its frame (components/insights/). The cards' own
 * texts (titles, facts, action labels) are the backend's (backend/constants/messages.js
 * INSIGHT_MESSAGES); the kinds, severities, actions and queues mirror
 * backend/services/insights/insightFormat.js.
 */

import { ROUTE_PATHS } from './routes.js';

export const INSIGHT_SEVERITIES = Object.freeze({ URGENT: 'urgent', HIGH: 'high', NORMAL: 'normal' });

/** The panel's groups, most pressing first. */
export const INSIGHT_GROUPS = Object.freeze([
  { severity: INSIGHT_SEVERITIES.URGENT, label: 'Urgent' },
  { severity: INSIGHT_SEVERITIES.HIGH, label: 'High priority' },
  { severity: INSIGHT_SEVERITIES.NORMAL, label: 'Also today' },
]);

export const INSIGHT_ACTIONS = Object.freeze({
  APPROVE_LEAVE: 'APPROVE_LEAVE',
  DECLINE_LEAVE: 'DECLINE_LEAVE',
  OPEN_TASK: 'OPEN_TASK',
  REVIEW_TASK: 'REVIEW_TASK',
  ASK_NSK: 'ASK_NSK',
  OPEN_PAGE: 'OPEN_PAGE',
});

/** Which briefing queue (exact counts) each My Access tile's badge shows. */
export const QUEUE_BADGE_PATHS = Object.freeze({
  [ROUTE_PATHS.LEAVE]: 'LEAVE_DECISIONS',
  [ROUTE_PATHS.ATTENDANCE]: 'ATTENDANCE_CORRECTIONS',
  [ROUTE_PATHS.CONSOLE]: 'SUPPORT_WAITING',
  [ROUTE_PATHS.CA_PORTAL]: 'FORM16_PENDING',
});

/** How long an Approve can still be undone before it is sent. */
export const APPROVE_UNDO_MS = 5_000;
/** Several changes in a burst (one INSIGHTS_CHANGED each) load the briefing once. */
export const INSIGHTS_RELOAD_DEBOUNCE_MS = 400;

export const INSIGHT_LABELS = Object.freeze({
  MARK: '✦',
  OPEN_BRIEFING: 'Open briefing',
  PANEL_TITLE: 'Today’s briefing',
  CLOSE: 'Close briefing',
  URGENT: 'urgent',
  PILL: (total, urgent) =>
    `Briefing: ${total} ${total === 1 ? 'item' : 'items'}${urgent > 0 ? `, ${urgent} urgent` : ''}`,
  UNDO: 'Undo',
  APPROVING: 'Approving…',
  DECLINE_REASON: 'Reason for declining',
  DECLINE_HINT: 'Required: the employee sees this reason',
  CONFIRM_DECLINE: 'Decline request',
  CANCEL: 'Cancel',
  EMPTY: 'You are all caught up.',
});
