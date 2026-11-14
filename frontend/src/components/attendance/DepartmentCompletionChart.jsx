/**
 * Check-in completion by department for the month so far: days present ÷ days expected
 * (GET /api/attendance/analytics `departments`). One series, so one colour; each bar carries its
 * percentage, the tooltip the days behind it, and the same figures are in a table under the chart.
 * Departments with nothing expected yet (everyone without an office, say) show "—".
 */

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { departmentBars } from '../../utils/attendanceCharts.js';
import { CHART_INK, SERIES_COLOR, formatShare } from './chartTheme.js';

function DepartmentTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const bar = payload[0].payload;
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
      <p className="font-semibold text-slate-900">{bar.name}</p>
      <p className="text-slate-600">
        {formatShare(bar.completion)}: {bar.presentDays} of {bar.expectedDays} days · {bar.headcount} people ·{' '}
        {bar.lateDays} late
      </p>
    </div>
  );
}

export default function DepartmentCompletionChart({ departments }) {
  const bars = departmentBars(departments);
  if (bars.length === 0) return <p className="text-sm text-slate-500">No departments to compare yet.</p>;
  const height = Math.max(160, bars.length * 44);
  return (
    <figure className="space-y-3">
      <div style={{ height }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
          <BarChart
            data={bars}
            layout="vertical"
            margin={{ top: 4, right: 48, bottom: 4, left: 8 }}
            barCategoryGap={10}
          >
            <CartesianGrid horizontal={false} stroke={CHART_INK.grid} />
            <XAxis
              type="number"
              domain={[0, 100]}
              tickFormatter={(value) => `${value}%`}
              tick={{ fill: CHART_INK.muted, fontSize: 11 }}
              axisLine={{ stroke: CHART_INK.axis }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={120}
              tick={{ fill: CHART_INK.secondary, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<DepartmentTooltip />} cursor={{ fill: '#f1f5f9' }} />
            <Bar dataKey="drawnPercent" fill={SERIES_COLOR} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              <LabelList dataKey="label" position="right" fill={CHART_INK.primary} fontSize={12} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
          Show as a table
        </summary>
        <table className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">Check-in completion by department</caption>
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-medium">Department</th>
              <th className="py-1 text-right font-medium">Completion</th>
              <th className="py-1 text-right font-medium">Days present / expected</th>
              <th className="py-1 text-right font-medium">Late days</th>
              <th className="py-1 text-right font-medium">People</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {bars.map((bar) => (
              <tr key={bar.name}>
                <td className="py-1">{bar.name}</td>
                <td className="py-1 text-right tabular-nums">{formatShare(bar.completion)}</td>
                <td className="py-1 text-right tabular-nums">
                  {bar.presentDays} / {bar.expectedDays}
                </td>
                <td className="py-1 text-right tabular-nums">{bar.lateDays}</td>
                <td className="py-1 text-right tabular-nums">{bar.headcount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
