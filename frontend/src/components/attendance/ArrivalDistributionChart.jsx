/**
 * When people arrive: punch-ins over the last 7 days per half-hour slot, in office time
 * (GET /api/attendance/analytics `arrivals`), with the busiest slot named and each day's median
 * arrival listed. One series, one colour; a table holds the counts per slot and day.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDate } from '../ui.jsx';
import { peakSlot } from '../../utils/attendanceCharts.js';
import { CHART_INK, SERIES_COLOR } from './chartTheme.js';

const dayLabel = (calendarDate) => formatDate(`${calendarDate}T00:00:00`, { weekday: 'short', day: 'numeric' });

function SlotTooltip({ active, payload, dates }) {
  if (!active || !payload?.length) return null;
  const slot = payload[0].payload;
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
      <p className="font-semibold text-slate-900">
        {slot.start}: {slot.total} {slot.total === 1 ? 'arrival' : 'arrivals'}
      </p>
      <ul className="mt-1 text-slate-600">
        {slot.counts.map((count, index) =>
          count > 0 ? <li key={dates[index]}>{`${dayLabel(dates[index])}: ${count}`}</li> : null,
        )}
      </ul>
    </div>
  );
}

export default function ArrivalDistributionChart({ arrivals }) {
  const { slots, dates, medians, slotMinutes } = arrivals;
  if (slots.length === 0) return <p className="text-sm text-slate-500">No punch-ins in the last 7 days.</p>;
  const peak = peakSlot(slots);
  return (
    <figure className="space-y-4">
      <p className="text-sm text-slate-600">
        Busiest: <span className="font-semibold text-slate-900">{peak.start}</span> ({peak.total} arrivals in{' '}
        {slotMinutes} minutes, over the week)
      </p>
      <div className="h-56" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 224 }}>
          <BarChart data={slots} margin={{ top: 8, right: 8, bottom: 4, left: -16 }} barCategoryGap={2}>
            <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
            <XAxis
              dataKey="start"
              tick={{ fill: CHART_INK.muted, fontSize: 11 }}
              axisLine={{ stroke: CHART_INK.axis }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: CHART_INK.muted, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<SlotTooltip dates={dates} />} cursor={{ fill: '#f1f5f9' }} />
            <Bar dataKey="total" fill={SERIES_COLOR} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul aria-label="Median arrival by day" className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-7">
        {medians.map((day) => (
          <li key={day.date} className="rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200">
            <span className="block text-slate-500">{dayLabel(day.date)}</span>
            <span className="block font-semibold text-slate-900 tabular-nums">{day.median ?? '—'}</span>
            <span className="block text-slate-500">
              {day.count} {day.count === 1 ? 'arrival' : 'arrivals'}
            </span>
          </li>
        ))}
      </ul>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
          Show as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Arrivals per {slotMinutes}-minute slot and day</caption>
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 font-medium">From</th>
                {dates.map((date) => (
                  <th key={date} className="py-1 text-right font-medium">
                    {dayLabel(date)}
                  </th>
                ))}
                <th className="py-1 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {slots.map((slot) => (
                <tr key={slot.start}>
                  <td className="py-1">{slot.start}</td>
                  {slot.counts.map((count, index) => (
                    <td key={dates[index]} className="py-1 text-right tabular-nums">
                      {count}
                    </td>
                  ))}
                  <td className="py-1 text-right font-semibold tabular-nums">{slot.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
