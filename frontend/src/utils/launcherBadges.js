/**
 * The My Access launcher's live counts and search (pages/MyAccess.jsx).
 *
 *   badgesFromQueues   pending counts for the tiles that have one, from the daily briefing's exact
 *                      queues (GET /api/insights/daily-briefing, loaded once by the app shell and kept
 *                      current live), so the launcher makes no requests of its own; a queue missing
 *                      from the briefing (its area could not be read) shows no badge
 *       Leave                leave requests and leave changes waiting for this person's decision
 *       Attendance           attendance corrections waiting for this person's review
 *       Support Console      escalated chats nobody has claimed yet
 *       Form 16 / CA Portal  eligible employees still waiting for this year's Form 16
 *   badgeText          what a badge shows: nothing at 0, "99+" above LAUNCHER_BADGE_MAX
 *   filterTiles        the tiles whose label, keywords or address contain the search text
 */

import { QUEUE_BADGE_PATHS } from '../constants/insights.js';
import { LAUNCHER_BADGE_MAX } from '../constants/launcher.js';

/**
 * { [tile path]: count } for the tiles with a badge and a count above 0.
 * @param {Record<string, number>|null|undefined} queues  the briefing's `queues`
 */
export function badgesFromQueues(queues) {
  if (!queues) return {};
  return Object.fromEntries(
    Object.entries(QUEUE_BADGE_PATHS)
      .map(([path, queue]) => [path, queues[queue]])
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
