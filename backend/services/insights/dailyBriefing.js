/**
 * The daily briefing (GET /api/insights/daily-briefing): what needs this person today, as cards,
 * built from deterministic queries only (services/insights/: leave approvals, tasks, operations), in
 * the order they should be handled.
 *
 *   {
 *     generatedAt,
 *     today,          YYYY-MM-DD in the company's time zone
 *     headline,       "1 revision needed · 2 overdue · 1 leave request to approve", or ALL_CLEAR
 *     counts: { total, urgent, high, byKind: { [kind]: n } },
 *     cards: [ ... ]  services/insights/insightFormat.js has the shape; urgent first
 *   }
 *
 * Cached per person (services/insights/insightsCache.js); a leave or task change they are part of
 * clears it. A builder that fails is logged and left out, so one broken area never hides the rest.
 */

import { INSIGHT_MESSAGES } from '../../constants/messages.js';
import { logger } from '../../utils/logger.js';
import { companyToday } from '../companyToday.js';
import { INSIGHT_KINDS, INSIGHT_SEVERITIES, sortCards } from './insightFormat.js';
import { readCachedBriefing, storeCachedBriefing } from './insightsCache.js';
import { buildLeaveCards } from './leaveInsights.js';
import { buildOperationsCards } from './operationsInsights.js';
import { buildTaskCards } from './taskInsights.js';

/** Which kinds count towards each part of the headline. */
const HEADLINE_KINDS = Object.freeze({
  revisions: [INSIGHT_KINDS.TASK_REVISION],
  overdue: [INSIGHT_KINDS.TASK_OVERDUE],
  leaveApprovals: [INSIGHT_KINDS.LEAVE_APPROVAL],
  reviews: [INSIGHT_KINDS.TASK_REVIEW],
  upNext: [INSIGHT_KINDS.TASK_UP_NEXT],
  dueToday: [INSIGHT_KINDS.TASK_DUE_TODAY],
  operations: [
    INSIGHT_KINDS.SUPPORT_WAITING,
    INSIGHT_KINDS.CORRECTIONS_PENDING,
    INSIGHT_KINDS.OFFERS_PENDING,
    INSIGHT_KINDS.FORM16_PENDING,
  ],
});

/** The one-line summary of the cards. */
export function headlineOf(byKind) {
  const parts = Object.entries(HEADLINE_KINDS)
    .map(([part, kinds]) => [part, kinds.reduce((sum, kind) => sum + (byKind[kind] ?? 0), 0)])
    .filter(([, count]) => count > 0)
    .map(([part, count]) => INSIGHT_MESSAGES.HEADLINE_PARTS[part](count));
  return parts.length > 0 ? parts.join(INSIGHT_MESSAGES.HEADLINE_SEPARATOR) : INSIGHT_MESSAGES.ALL_CLEAR;
}

async function safely(area, viewer, build) {
  try {
    return await build();
  } catch (buildError) {
    logger.error('Briefing area could not be built', { area, userId: viewer.id, error: buildError.message });
    return [];
  }
}

/**
 * Builds the briefing without the cache.
 * @param {{ id: string, role: string }} viewer
 * @param {{ now?: Date }} [options]
 */
export async function buildDailyBriefing(viewer, { now = new Date() } = {}) {
  const today = await companyToday(now);
  const groups = await Promise.all([
    safely('leave', viewer, () => buildLeaveCards(viewer, { now })),
    safely('tasks', viewer, () => buildTaskCards(viewer, { today })),
    safely('operations', viewer, () => buildOperationsCards(viewer, { now })),
  ]);
  const cards = sortCards(groups.flat());
  const byKind = {};
  for (const card of cards) byKind[card.kind] = (byKind[card.kind] ?? 0) + 1;
  return {
    generatedAt: now.toISOString(),
    today,
    headline: headlineOf(byKind),
    counts: {
      total: cards.length,
      urgent: cards.filter((card) => card.severity === INSIGHT_SEVERITIES.URGENT).length,
      high: cards.filter((card) => card.severity === INSIGHT_SEVERITIES.HIGH).length,
      byKind,
    },
    cards,
  };
}

/** The briefing, from the cache when it is still fresh. */
export async function getDailyBriefing(viewer) {
  const cached = await readCachedBriefing(viewer.id);
  if (cached) return cached;
  const briefing = await buildDailyBriefing(viewer);
  await storeCachedBriefing(viewer.id, briefing);
  return briefing;
}
