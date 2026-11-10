/**
 * A sprint's burndown: story points still open at the end of each day so far (the brand line) against
 * the ideal straight line to zero (dashed, neutral). Hovering or focusing a day shows its numbers; the
 * same numbers are in a table under the chart, for screen readers and for reading exact values.
 */

import { useId, useState } from 'react';
import { formatDate } from '../ui.jsx';
import { idealRemaining, sprintDates } from '../../utils/sprintProgress.js';

const WIDTH = 640;
const HEIGHT = 220;
const PADDING = Object.freeze({ top: 12, right: 16, bottom: 28, left: 36 });
const Y_TICKS = 4;

const shortDate = (calendarDate) => formatDate(`${calendarDate}T00:00:00`, { day: 'numeric', month: 'short' });
const roundOne = (value) => Math.round(value * 10) / 10;

export default function BurndownChart({ sprint }) {
  const { startDate, endDate, burndown } = sprint;
  const { totalPoints, days } = burndown;
  const dates = sprintDates(startDate, endDate);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const tableId = useId();

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const maxPoints = Math.max(totalPoints, 1);
  const step = dates.length > 1 ? plotWidth / (dates.length - 1) : 0;
  const x = (index) => PADDING.left + (dates.length > 1 ? index * step : plotWidth / 2);
  const y = (points) => PADDING.top + plotHeight * (1 - points / maxPoints);
  const actualByDate = new Map(days.map((day) => [day.date, day.remainingPoints]));
  const ideal = (date) => idealRemaining(totalPoints, startDate, endDate, date);
  const actualPath = days
    .map((day, index) => `${index === 0 ? 'M' : 'L'}${x(dates.indexOf(day.date))},${y(day.remainingPoints)}`)
    .join(' ');
  const labelEvery = Math.max(1, Math.ceil(dates.length / 7));
  const hoveredDate = hoveredIndex === null ? null : dates[hoveredIndex];

  return (
    <figure className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-5 rounded bg-brand-600" /> Points still open
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-5 border-t-2 border-dashed border-slate-400" /> Ideal
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`Burndown of ${sprint.name}: ${days.at(-1)?.remainingPoints ?? totalPoints} of ${totalPoints} points still open`}
          aria-describedby={tableId}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {Array.from({ length: Y_TICKS + 1 }, (_, tick) => {
            const points = (maxPoints / Y_TICKS) * tick;
            return (
              <g key={tick}>
                <line
                  x1={PADDING.left}
                  x2={WIDTH - PADDING.right}
                  y1={y(points)}
                  y2={y(points)}
                  className="stroke-slate-100"
                  strokeWidth="1"
                />
                <text
                  x={PADDING.left - 8}
                  y={y(points)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-slate-400 text-[10px]"
                >
                  {roundOne(points)}
                </text>
              </g>
            );
          })}
          {dates.map((date, index) =>
            index % labelEvery === 0 || index === dates.length - 1 ? (
              <text key={date} x={x(index)} y={HEIGHT - 8} textAnchor="middle" className="fill-slate-400 text-[10px]">
                {shortDate(date)}
              </text>
            ) : null,
          )}
          <line
            x1={x(0)}
            y1={y(totalPoints)}
            x2={x(dates.length - 1)}
            y2={y(0)}
            className="stroke-slate-400"
            strokeWidth="2"
            strokeDasharray="5 4"
          />
          {days.length > 0 && (
            <path d={actualPath} fill="none" className="stroke-brand-600" strokeWidth="2" strokeLinejoin="round" />
          )}
          {days.length > 0 && (
            <circle
              cx={x(dates.indexOf(days.at(-1).date))}
              cy={y(days.at(-1).remainingPoints)}
              r="4"
              className="fill-brand-600 stroke-white"
              strokeWidth="2"
            />
          )}
          {hoveredDate && (
            <line
              x1={x(hoveredIndex)}
              x2={x(hoveredIndex)}
              y1={PADDING.top}
              y2={PADDING.top + plotHeight}
              className="stroke-slate-300"
              strokeWidth="1"
            />
          )}
          {dates.map((date, index) => (
            <rect
              key={date}
              x={x(index) - Math.max(step, 8) / 2}
              y={PADDING.top}
              width={Math.max(step, 8)}
              height={plotHeight}
              fill="transparent"
              onMouseEnter={() => setHoveredIndex(index)}
            />
          ))}
        </svg>
        {hoveredDate && (
          <div
            className="pointer-events-none absolute top-0 rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-lg"
            style={{
              left: `${(x(hoveredIndex) / WIDTH) * 100}%`,
              transform: hoveredIndex > dates.length / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
            }}
          >
            <p className="font-semibold">{shortDate(hoveredDate)}</p>
            <p>Open: {actualByDate.has(hoveredDate) ? `${actualByDate.get(hoveredDate)} points` : 'not yet'}</p>
            <p className="text-slate-300">Ideal: {roundOne(ideal(hoveredDate))} points</p>
          </div>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
          Show as a table
        </summary>
        <table id={tableId} className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">Story points still open at the end of each day of {sprint.name}</caption>
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 text-right font-medium">Still open</th>
              <th className="py-1 text-right font-medium">Ideal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {dates.map((date) => (
              <tr key={date}>
                <td className="py-1">{shortDate(date)}</td>
                <td className="py-1 text-right tabular-nums">{actualByDate.get(date) ?? '—'}</td>
                <td className="py-1 text-right tabular-nums">{roundOne(ideal(date))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
