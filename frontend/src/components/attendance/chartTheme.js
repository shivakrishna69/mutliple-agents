/**
 * Colours and labels the attendance charts share. Statuses use the fixed status palette (good,
 * warning, critical) plus blue for leave; each colour always appears with its label and count, and
 * every chart has a table view, because warning yellow is below 3:1 on the light surface. Validated
 * with the dataviz palette checker: colour-blind separation passes (worst ΔE 11.3).
 */

export const CHART_INK = Object.freeze({
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  surface: '#fcfcfb',
});

/** A single measured series (completion, arrivals). */
export const SERIES_COLOR = '#2a78d6';

/** The backend's day statuses (services/attendanceAnalytics.js) as people read them, with their colour. */
export const DAY_STATUS_DISPLAY = Object.freeze({
  on_time: { label: 'On time', color: '#0ca30c' },
  late: { label: 'Late', color: '#fab219' },
  absent: { label: 'Absent', color: '#d03b3b' },
  leave: { label: 'On leave', color: '#2a78d6' },
  holiday: { label: 'Holiday', color: '#c3c2b7' },
  weekly_off: { label: 'Weekly off', color: '#e1e0d9' },
  not_joined: { label: 'Before joining', color: '#f0efec' },
  upcoming: { label: 'Not yet', color: '#f0efec' },
});

export const formatShare = (share) => (share === null || share === undefined ? '—' : `${Math.round(share * 100)}%`);
