/**
 * The My Access launcher's live counts and search (pages/MyAccess.jsx).
 *
 *   loadLauncherBadges   pending counts for the tiles that have one, read from endpoints the pages
 *                        already use; a count is left out when its request fails or the person may
 *                        not read it, so its badge simply does not show
 *       Leave                leave requests and leave changes waiting for this person's decision
 *       Attendance           attendance corrections waiting for this person's review
 *       Support Console      escalated chats nobody has claimed yet (among the latest 100 the list
 *                            returns, so a busy queue shows "99+")
 *       Form 16 / CA Portal  eligible employees still waiting for this year's Form 16
 *   badgeText            what a badge shows: nothing at 0, "99+" above LAUNCHER_BADGE_MAX
 *   filterTiles          the tiles whose label, keywords or address contain the search text
 */

import { requestRegularizationReviews } from '../api/workforceApi.js';
import { requestApprovalQueue } from '../api/leaveApi.js';
import { requestConversationList } from '../api/conversationsApi.js';
import { requestCaEmployees } from '../api/taxApi.js';
import { APPROVAL_QUEUES } from '../constants/leave.js';
import { CONVERSATION_WAITING_STATUS, LAUNCHER_BADGE_MAX, REVIEW_PENDING_STATUS } from '../constants/launcher.js';
import { ROUTE_PATHS } from '../constants/routes.js';

/** Where each count comes from, by the tile it belongs to. */
const BADGE_SOURCES = Object.freeze({
  [ROUTE_PATHS.LEAVE]: async (signal) => {
    const [requests, changes] = await Promise.all([
      requestApprovalQueue(APPROVAL_QUEUES.REQUESTS, signal),
      requestApprovalQueue(APPROVAL_QUEUES.CHANGES, signal),
    ]);
    return requests.requests.length + changes.requests.length;
  },
  [ROUTE_PATHS.ATTENDANCE]: async (signal) =>
    (await requestRegularizationReviews(REVIEW_PENDING_STATUS, signal)).reviews.length,
  [ROUTE_PATHS.CONSOLE]: async (signal) =>
    (await requestConversationList({ signal })).filter(
      (conversation) => conversation.status === CONVERSATION_WAITING_STATUS && !conversation.assignedAgentId,
    ).length,
  [ROUTE_PATHS.CA_PORTAL]: async (signal) => (await requestCaEmployees({}, signal)).summary.pending,
});

/** The tile addresses that can carry a badge. */
export const BADGE_PATHS = Object.freeze(Object.keys(BADGE_SOURCES));

/**
 * Pending counts for the given tile addresses: { [path]: count }. Only the tiles the person sees are
 * asked for; a failed or refused request leaves its tile out.
 * @param {string[]} paths
 * @param {AbortSignal} [signal]
 */
export async function loadLauncherBadges(paths, signal) {
  const wanted = paths.filter((path) => BADGE_SOURCES[path]);
  const results = await Promise.allSettled(wanted.map((path) => BADGE_SOURCES[path](signal)));
  return Object.fromEntries(
    wanted
      .map((path, index) => [path, results[index].status === 'fulfilled' ? results[index].value : null])
      .filter(([, count]) => Number.isInteger(count) && count > 0),
  );
}

/** "3", "99+", or null when there is nothing to show. */
export function badgeText(count) {
  if (!Number.isInteger(count) || count <= 0) return null;
  return count > LAUNCHER_BADGE_MAX ? `${LAUNCHER_BADGE_MAX}+` : String(count);
}

/**
 * The tiles matching `query` (case-insensitive) in their label, their keywords or their address.
 * @param {{ label: string, path: string, keywords?: string[] }[]} tiles
 */
export function filterTiles(tiles, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return tiles;
  return tiles.filter((tile) =>
    [tile.label, tile.path.replace(/[/-]+/g, ' '), ...(tile.keywords ?? [])].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
}
