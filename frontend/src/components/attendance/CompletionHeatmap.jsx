/**
 * Each person's month, day by day (GET /api/attendance/analytics `people`): one square per day
 * coloured by its status (on time, late, absent, on leave, holiday, weekly off, not yet), and their
 * completion (days present ÷ days expected) as a bar with the figure beside it. The legend names
 * every colour; each square's status is in its title and accessible name, and the totals per person
 * are plain text, so nothing depends on colour alone.
 */

import { formatDate } from '../ui.jsx';
import { DAY_STATUS_DISPLAY, SERIES_COLOR, formatShare } from './chartTheme.js';

const LEGEND_ORDER = Object.freeze(['on_time', 'late', 'absent', 'leave', 'holiday', 'weekly_off', 'upcoming']);

export default function CompletionHeatmap({ people }) {
  if (people.length === 0) return <p className="text-sm text-slate-500">Nobody to show for this month.</p>;
  const dates = people[0].days.map((day) => day.date);
  return (
    <div className="space-y-3">
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        {LEGEND_ORDER.map((status) => (
          <li key={status} className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-sm ring-1 ring-slate-300/60"
              style={{ background: DAY_STATUS_DISPLAY[status].color }}
              aria-hidden="true"
            />
            {DAY_STATUS_DISPLAY[status].label}
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[44rem] border-separate border-spacing-y-1 text-xs">
          <caption className="sr-only">Attendance per person and day, with completion</caption>
          <thead className="text-slate-500">
            <tr>
              <th scope="col" className="sticky left-0 bg-white pr-3 text-left font-medium">
                Person
              </th>
              <th scope="col" className="text-left font-medium">
                {formatDate(`${dates[0]}T00:00:00`, { month: 'long', year: 'numeric' })}
              </th>
              <th scope="col" className="w-40 pl-3 text-left font-medium">
                Completion
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.employeeId}>
                <th scope="row" className="sticky left-0 bg-white pr-3 text-left font-normal">
                  <span className="block truncate text-sm text-slate-800">{person.name}</span>
                  <span className="block truncate text-slate-500">{person.department?.name ?? '—'}</span>
                </th>
                <td>
                  <ol className="flex gap-0.5" aria-label={`${person.name}, day by day`}>
                    {person.days.map((day) => {
                      const display = DAY_STATUS_DISPLAY[day.status] ?? DAY_STATUS_DISPLAY.upcoming;
                      const label = `${formatDate(`${day.date}T00:00:00`, { day: 'numeric', month: 'short' })}: ${display.label}`;
                      return (
                        <li
                          key={day.date}
                          title={label}
                          aria-label={label}
                          className="h-4 w-3.5 shrink-0 rounded-[3px] ring-1 ring-slate-300/40"
                          style={{ background: display.color }}
                        />
                      );
                    })}
                  </ol>
                </td>
                <td className="pl-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.round((person.completion ?? 0) * 100)}%`, background: SERIES_COLOR }}
                      />
                    </div>
                    <span className="w-10 text-right font-semibold text-slate-900 tabular-nums">
                      {formatShare(person.completion)}
                    </span>
                  </div>
                  <span className="text-slate-500">
                    {person.presentDays} of {person.expectedDays} days · {person.lateDays} late
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
