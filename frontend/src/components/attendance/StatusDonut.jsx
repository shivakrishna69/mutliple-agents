/**
 * Today's attendance at a glance: a donut of who is in on time, late, on leave, or not in yet, from
 * the Today board's counts (GET /api/attendance/today). The total sits in the middle; every slice is
 * also listed with its count and share, so no figure depends on colour or on hovering.
 *
 * "Not in yet" is a working day without a punch-in: absent once the day is over, possibly just not
 * arrived while it is still on. People on a holiday, a weekly off or without an office are left out.
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { todaySlices } from '../../utils/attendanceCharts.js';
import { CHART_INK, formatShare } from './chartTheme.js';

function SliceTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const slice = payload[0].payload;
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
      <p className="font-semibold text-slate-900">{slice.label}</p>
      <p className="text-slate-600">
        {slice.value} of {total} ({formatShare(total ? slice.value / total : 0)})
      </p>
    </div>
  );
}

export default function StatusDonut({ counts }) {
  const slices = todaySlices(counts);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <figure className="grid items-center gap-6 sm:grid-cols-[minmax(0,14rem)_1fr]">
      <div className="relative mx-auto aspect-square w-full max-w-56" aria-hidden="true">
        {total > 0 && (
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 224, height: 224 }}>
            <PieChart>
              <Pie
                data={slices.filter((slice) => slice.value > 0)}
                dataKey="value"
                nameKey="label"
                innerRadius="62%"
                outerRadius="100%"
                paddingAngle={2}
                stroke={CHART_INK.surface}
                strokeWidth={2}
                isAnimationActive={false}
              >
                {slices
                  .filter((slice) => slice.value > 0)
                  .map((slice) => (
                    <Cell key={slice.key} fill={slice.color} />
                  ))}
              </Pie>
              <Tooltip content={<SliceTooltip total={total} />} />
            </PieChart>
          </ResponsiveContainer>
        )}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold text-slate-900 tabular-nums">{total}</span>
          <span className="text-xs text-slate-500">working today</span>
        </div>
      </div>
      <figcaption>
        <ul aria-label="Attendance today" className="space-y-2">
          {slices.map((slice) => (
            <li key={slice.key} className="flex items-center gap-3 text-sm">
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: slice.color }} aria-hidden="true" />
              <span className="flex-1 text-slate-700">{slice.label}</span>
              <span className="font-semibold text-slate-900 tabular-nums">{slice.value}</span>
              <span className="w-12 text-right text-slate-500 tabular-nums">
                {formatShare(total ? slice.value / total : 0)}
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
