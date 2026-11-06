/**
 * Numbers on the dashboard. The server sends shares as fractions (0..1) and durations in
 * milliseconds, or null when there is nothing to measure; null is shown as "—".
 */

export const NOTHING_TO_MEASURE = '—';

/** 0.984 -> "98.4%", 0.25 -> "25%". */
export function formatShare(share) {
  if (share === null || share === undefined) return NOTHING_TO_MEASURE;
  const percent = Math.round(share * 1000) / 10;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/** A change in a share, in percentage points: -0.75 -> "−75 pts", 0.031 -> "+3.1 pts". */
export function formatShareChange(change) {
  if (change === null || change === undefined || change === 0) return null;
  const points = Math.round(Math.abs(change) * 1000) / 10;
  return `${change > 0 ? '+' : '−'}${points} pts`;
}

/** 240 -> "240ms", 1200 -> "1.2s", 42000 -> "42s", 125000 -> "2m 5s". */
export function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return NOTHING_TO_MEASURE;
  const magnitude = Math.abs(milliseconds);
  if (magnitude < 1000) return `${Math.round(magnitude)}ms`;
  if (magnitude < 10_000) return `${(magnitude / 1000).toFixed(1)}s`;
  if (magnitude < 60_000) return `${Math.round(magnitude / 1000)}s`;
  const minutes = Math.floor(magnitude / 60_000);
  const seconds = Math.round((magnitude % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** A change in a duration: -400 -> "−400ms" (faster), 32000 -> "+32s" (slower). */
export function formatDurationChange(change) {
  if (change === null || change === undefined || change === 0) return null;
  return `${change > 0 ? '+' : '−'}${formatDuration(Math.abs(change))}`;
}

/** "Good morning" / "Good afternoon" / "Good evening" for the hour of the browser's clock. */
export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "2026-11-06" -> "6 Nov" (a calendar date, read without time-zone shifts). */
export function formatCalendarDate(calendarDate, options = { day: 'numeric', month: 'short' }) {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, options);
}

/** 135 -> "2h 15m". */
export function formatMinutes(totalMinutes) {
  if (totalMinutes === null || totalMinutes === undefined) return NOTHING_TO_MEASURE;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago", "yesterday"; empty for an invalid timestamp. */
export function formatRelativeTime(isoTimestamp) {
  const timestampMs = isoTimestamp ? new Date(isoTimestamp).getTime() : Number.NaN;
  if (Number.isNaN(timestampMs)) return '';
  const elapsedSeconds = Math.round((timestampMs - Date.now()) / 1000);
  for (const [unitName, unitSeconds] of [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]) {
    if (Math.abs(elapsedSeconds) >= unitSeconds) {
      return relativeTimeFormatter.format(Math.round(elapsedSeconds / unitSeconds), unitName);
    }
  }
  return 'just now';
}

/** "Ada Lovelace" -> "AL"; a single word gives one letter; no name gives "?". */
export function initialsOf(fullName) {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  const initials = parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : (parts[0]?.[0] ?? '?');
  return initials.toUpperCase();
}

/** An instant as the browser's local time of day: "09:42". */
export function formatClockTime(isoTimestamp) {
  if (!isoTimestamp) return NOTHING_TO_MEASURE;
  return new Date(isoTimestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
