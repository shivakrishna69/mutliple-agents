/**
 * The My Access launcher's badges and search (pages/MyAccess.jsx, utils/launcherBadges.js). Stored
 * values are the backend's.
 */

/** A badge shows at most this number; above it, "99+". */
export const LAUNCHER_BADGE_MAX = 99;

/** What a tile's badge counts, for screen readers ("Leave, 3 pending"). */
export const LAUNCHER_BADGE_LABEL = 'pending';

export const LAUNCHER_SEARCH = Object.freeze({
  LABEL: 'Search modules',
  PLACEHOLDER: 'Search modules',
  CLEAR: 'Clear search',
  NO_MATCH: 'No modules match',
  MAX_LENGTH: 60,
});
