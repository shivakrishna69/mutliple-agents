/**
 * The figures the attendance charts draw (components/attendance/), from the backend's answers:
 * GET /api/attendance/today (counts) and GET /api/attendance/analytics (departments, arrivals).
 */

import { DAY_STATUS_DISPLAY } from '../components/attendance/chartTheme.js';

/** The donut's slices from the board's counts (in and out are both "in"; late includes half days). */
export function todaySlices(counts) {
  const arrived = (counts.in ?? 0) + (counts.out ?? 0);
  const late = Math.min(counts.late ?? 0, arrived);
  return [
    {
      key: 'on_time',
      label: DAY_STATUS_DISPLAY.on_time.label,
      color: DAY_STATUS_DISPLAY.on_time.color,
      value: arrived - late,
    },
    { key: 'late', label: DAY_STATUS_DISPLAY.late.label, color: DAY_STATUS_DISPLAY.late.color, value: late },
    {
      key: 'leave',
      label: DAY_STATUS_DISPLAY.leave.label,
      color: DAY_STATUS_DISPLAY.leave.color,
      value: counts.on_leave ?? 0,
    },
    { key: 'absent', label: 'Not in yet', color: DAY_STATUS_DISPLAY.absent.color, value: counts.not_in ?? 0 },
  ];
}

const NO_DEPARTMENT = 'No department';

/**
 * Bars in percent, most complete first. A department with nothing expected yet is drawn at 0 and
 * labelled "—" rather than left without a bar.
 */
export function departmentBars(departments) {
  return departments
    .map((entry) => {
      const percent = entry.completion === null ? null : Math.round(entry.completion * 100);
      return {
        name: entry.department?.name ?? NO_DEPARTMENT,
        percent,
        drawnPercent: percent ?? 0,
        label: percent === null ? '—' : `${percent}%`,
        ...entry,
      };
    })
    .sort((first, second) => (second.percent ?? -1) - (first.percent ?? -1));
}

/** The busiest slot (the first when tied), or null without arrivals. */
export function peakSlot(slots) {
  return slots.reduce((best, slot) => (best === null || slot.total > best.total ? slot : best), null);
}
