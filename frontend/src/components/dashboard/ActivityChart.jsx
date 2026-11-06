/**
 * The dashboard's activity chart: AI replies (a blue line over a soft blue area) and agent replies
 * (a dashed grey line) per local hour or day, as the server counts them
 * (GET /api/dashboard/overview support.activity). Drawn as SVG, with smooth curves through the
 * points; the figures are also in a visually hidden table for screen readers.
 */

import { useId } from 'react';
import { formatCalendarDate } from '../../utils/dashboardFormat.js';

const WIDTH = 600;
const HEIGHT = 190;
const TOP = 14;
const BOTTOM = 8;
const AXIS_LABELS = 5;

/** A smooth path through the points (Catmull-Rom turned into cubic Bézier segments). */
function smoothPath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[index + 2] ?? next;
    const control1 = { x: current.x + (next.x - previous.x) / 6, y: current.y + (next.y - previous.y) / 6 };
    const control2 = { x: next.x - (afterNext.x - current.x) / 6, y: next.y - (afterNext.y - current.y) / 6 };
    path += ` C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${next.x} ${next.y}`;
  }
  return path;
}

const axisLabelOf = (point, unit) => (unit === 'hour' ? point.label : formatCalendarDate(point.key));

/** @param {{ activity: { unit: 'hour'|'day', points: { key: string, label: string, ai: number, agent: number }[] } }} props */
export default function ActivityChart({ activity }) {
  const gradientId = useId();
  const { unit, points } = activity;
  const highest = Math.max(1, ...points.map((point) => Math.max(point.ai, point.agent)));
  const step = points.length > 1 ? WIDTH / (points.length - 1) : 0;
  const yOf = (count) => TOP + (HEIGHT - TOP - BOTTOM) * (1 - count / highest);
  const line = (series) => points.map((point, index) => ({ x: index * step, y: yOf(point[series]) }));
  const aiLine = smoothPath(line('ai'));
  const agentLine = smoothPath(line('agent'));
  const labelEvery = Math.max(1, Math.ceil(points.length / AXIS_LABELS));
  const labelled = points
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index % labelEvery === 0 || index === points.length - 1);

  const isEmpty = points.every((point) => point.ai === 0 && point.agent === 0);

  return (
    <figure className="relative">
      {isEmpty && (
        <p className="absolute inset-x-0 top-14 text-center text-sm text-slate-400">No replies in this period yet.</p>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block h-44 w-full overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1f5bff" stopOpacity="0.22" />
            <stop offset="1" stopColor="#1f5bff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${aiLine} L ${WIDTH} ${HEIGHT} L 0 ${HEIGHT} Z`} fill={`url(#${gradientId})`} />
        <path
          d={agentLine}
          fill="none"
          stroke="#cbd5e1"
          strokeWidth="2"
          strokeDasharray="3 5"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={aiLine}
          fill="none"
          stroke="#1f5bff"
          strokeWidth="3"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="relative mt-3 h-4 text-[11px] text-slate-400 tabular-nums" aria-hidden="true">
        {labelled.map(({ point, index }) => (
          <span
            key={point.key}
            className={`absolute whitespace-nowrap ${
              index === 0 ? '' : index === points.length - 1 ? '-translate-x-full' : '-translate-x-1/2'
            }`}
            style={{ left: `${points.length > 1 ? (index / (points.length - 1)) * 100 : 0}%` }}
          >
            {axisLabelOf(point, unit)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Replies by the AI and by agents, per {unit}</caption>
        <thead>
          <tr>
            <th scope="col">{unit === 'hour' ? 'Hour' : 'Day'}</th>
            <th scope="col">AI</th>
            <th scope="col">Agents</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.key}>
              <th scope="row">{axisLabelOf(point, unit)}</th>
              <td>{point.ai}</td>
              <td>{point.agent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
