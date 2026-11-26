/**
 * Shared pieces of the daily briefing's cards (services/insights/):
 *
 *   card shape   { id, kind, severity, label, title, body, facts[], actions[], at }
 *                  kind      what the card is about (INSIGHT_KINDS)
 *                  severity  urgent | high | normal: the order cards are shown in, urgent first
 *                  label     the short tag above the title ("Revision", "Leave approval")
 *                  facts     short lines under the title, already worded
 *                  actions   what the card offers (INSIGHT_ACTIONS), each with its label and target
 *                  at        the time the card is about (for the order within a severity)
 *   dateRange    "25 Dec" or "25 Dec – 30 Dec", from YYYY-MM-DD calendar dates
 *   sortCards    urgent, then high, then normal; within each, kind order, then oldest first
 *
 * Every text comes from constants/messages.js INSIGHT_MESSAGES.
 */

export const INSIGHT_SEVERITIES = Object.freeze({ URGENT: 'urgent', HIGH: 'high', NORMAL: 'normal' });

export const INSIGHT_KINDS = Object.freeze({
  TASK_REVISION: 'TASK_REVISION',
  LEAVE_APPROVAL: 'LEAVE_APPROVAL',
  TASK_REVIEW: 'TASK_REVIEW',
  TASK_UP_NEXT: 'TASK_UP_NEXT',
  TASK_OVERDUE: 'TASK_OVERDUE',
  TASK_DUE_TODAY: 'TASK_DUE_TODAY',
  SUPPORT_WAITING: 'SUPPORT_WAITING',
  CORRECTIONS_PENDING: 'CORRECTIONS_PENDING',
  OFFERS_PENDING: 'OFFERS_PENDING',
  FORM16_PENDING: 'FORM16_PENDING',
});

/**
 * What a card's buttons do (the frontend acts on the kind):
 *   APPROVE_LEAVE / DECLINE_LEAVE  { requestId, step }: POST /api/leave/requests/:id/approve|reject
 *                                  (a decline needs a reason, asked for on the card)
 *   OPEN_TASK / REVIEW_TASK        { path }: the task on its department board
 *   ASK_NSK                        { prompt }: /ask-nsk with the prompt in the box, not sent
 *   OPEN_PAGE                      { path }
 */
/**
 * Exact counts of what waits on the viewer, by queue (the briefing's `queues`), for badges such as My
 * Access's tiles; a queue the viewer has no part in is 0. Unlike the cards, these are never capped.
 */
export const INSIGHT_QUEUES = Object.freeze({
  LEAVE_DECISIONS: 'LEAVE_DECISIONS',
  ATTENDANCE_CORRECTIONS: 'ATTENDANCE_CORRECTIONS',
  SUPPORT_WAITING: 'SUPPORT_WAITING',
  OFFERS_PENDING: 'OFFERS_PENDING',
  FORM16_PENDING: 'FORM16_PENDING',
});

export const INSIGHT_ACTIONS = Object.freeze({
  APPROVE_LEAVE: 'APPROVE_LEAVE',
  DECLINE_LEAVE: 'DECLINE_LEAVE',
  OPEN_TASK: 'OPEN_TASK',
  REVIEW_TASK: 'REVIEW_TASK',
  ASK_NSK: 'ASK_NSK',
  OPEN_PAGE: 'OPEN_PAGE',
});

const SEVERITY_ORDER = Object.values(INSIGHT_SEVERITIES);
const KIND_ORDER = Object.values(INSIGHT_KINDS);

const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "25 Dec" for a YYYY-MM-DD calendar date. */
export const dayMonth = (calendarDate) => DAY_MONTH.format(new Date(`${calendarDate}T00:00:00Z`));

/** "25 Dec", or "25 Dec – 30 Dec" across days. */
export function dateRange(startDate, endDate = startDate) {
  return startDate === endDate ? dayMonth(startDate) : `${dayMonth(startDate)} – ${dayMonth(endDate)}`;
}

/** @param {object[]} cards */
export function sortCards(cards) {
  return [...cards].sort(
    (first, second) =>
      SEVERITY_ORDER.indexOf(first.severity) - SEVERITY_ORDER.indexOf(second.severity) ||
      KIND_ORDER.indexOf(first.kind) - KIND_ORDER.indexOf(second.kind) ||
      String(first.at ?? '').localeCompare(String(second.at ?? '')),
  );
}
