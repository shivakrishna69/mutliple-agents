/**
 * How the dashboard shows the server's values: words for statuses the API sends as codes, and the
 * full Tailwind class strings for each tone (written out so Tailwind's scanner sees every class).
 * Figures, messages and service names come from the API (GET /api/dashboard/overview and
 * /api/system/health).
 */

/** Today's attendance status (backend services/attendanceToday.js TODAY_STATUSES). */
export const ATTENDANCE_DAY_LABELS = Object.freeze({
  in: 'Punched in',
  out: 'Punched out',
  on_leave: 'On leave',
  no_office: 'No office assigned',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
  not_in: 'Not punched in yet',
});

/** Who is where right now (backend services/presenceActivity.js PRESENCE_DISPLAY_STATUSES), in order. */
export const PRESENCE_DISPLAY = Object.freeze([
  { key: 'available', label: 'Available', dotClassName: 'bg-emerald-500' },
  { key: 'away', label: 'Away', dotClassName: 'bg-amber-400' },
  { key: 'offline', label: 'Offline', dotClassName: 'bg-slate-300' },
  { key: 'on_leave', label: 'On leave', dotClassName: 'bg-violet-400' },
  { key: 'off_work', label: 'Off work', dotClassName: 'bg-slate-200' },
]);

/** A service's state (backend services/systemHealth.js SERVICE_STATES). */
export const SERVICE_STATE_TONES = Object.freeze({
  operational: { dotClassName: 'bg-emerald-500', chipClassName: 'bg-emerald-50 text-emerald-700' },
  degraded: { dotClassName: 'bg-amber-400', chipClassName: 'bg-amber-50 text-amber-800' },
  down: { dotClassName: 'bg-red-500', chipClassName: 'bg-red-50 text-red-700' },
  not_configured: { dotClassName: 'bg-slate-300', chipClassName: 'bg-slate-100 text-slate-600' },
});

/** The icon chips of the stat cards. */
export const STAT_TONES = Object.freeze({
  red: 'bg-red-50 text-red-500',
  blue: 'bg-brand-50 text-brand-600',
  violet: 'bg-violet-50 text-violet-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  slate: 'bg-slate-100 text-slate-600',
});

/** The recent-conversation filters, by the conversation statuses each one covers. */
export const CONVERSATION_FILTERS = Object.freeze([
  { key: 'all', label: 'All', statuses: null },
  { key: 'ai', label: 'With AI', statuses: ['processing-ai', 'unassigned'] },
  { key: 'agent', label: 'With an agent', statuses: ['assigned-agent'] },
  { key: 'escalated', label: 'Escalated', statuses: ['escalated-to-human'] },
]);
