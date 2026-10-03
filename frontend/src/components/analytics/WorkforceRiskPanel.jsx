/**
 * Predictive analytics: attrition risk and burnout per employee (GET /api/analytics/workforce-risk,
 * HR and admins only; every read is audited by the backend).
 *
 * Colour bands come from the response's `thresholds` (safe < elevatedFrom <= elevated < criticalFrom
 * <= critical), never hard-coded, so a policy change on the backend is reflected here.
 * "Unscored" employees (no model run yet) are grey and never drawn as safe/green.
 *
 * Layout: band summary tiles, a risk matrix (attrition × burnout scatter with band zones), and a
 * sortable, filterable table with a bar per metric.
 */

import { useMemo, useState } from 'react';
import { requestWorkforceRisk } from '../../api/workforceApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { ChartIcon } from '../Icons.jsx';
import { Badge, Card, EmptyState, LoadingBlock, Notice, SelectInput, StatTile, formatDateTime } from '../ui.jsx';

export const RISK_BAND_DISPLAY = Object.freeze({
  critical: { label: 'Critical', tone: 'rose', dotClassName: 'fill-rose-500', barClassName: 'from-rose-500 to-pink-500' },
  elevated: { label: 'Elevated', tone: 'amber', dotClassName: 'fill-amber-500', barClassName: 'from-amber-400 to-orange-500' },
  safe: { label: 'Safe', tone: 'emerald', dotClassName: 'fill-emerald-500', barClassName: 'from-emerald-400 to-teal-500' },
  unscored: { label: 'Unscored', tone: 'slate', dotClassName: 'fill-slate-400', barClassName: 'from-slate-300 to-slate-400' },
});

function MetricBar({ value, band }) {
  if (value === null || value === undefined) return <span className="text-xs text-slate-400">not scored</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full bg-gradient-to-r ${RISK_BAND_DISPLAY[band].barClassName}`} style={{ width: `${value}%` }} />
      </div>
      <span className="w-10 text-right text-sm font-semibold text-slate-800 tabular-nums">{Math.round(value)}</span>
    </div>
  );
}

/** Scatter of scored employees: x = attrition risk, y = burnout, with the band zones shaded. */
function RiskMatrix({ employees, thresholds }) {
  const [hoveredEmployee, setHoveredEmployee] = useState(null);
  const plotSize = 300;
  const toX = (value) => (value / 100) * plotSize;
  const toY = (value) => plotSize - (value / 100) * plotSize;
  const scoredEmployees = employees.filter((employee) => employee.overallBand !== 'unscored');
  const elevatedFrom = thresholds.elevatedFrom;
  const criticalFrom = thresholds.criticalFrom;

  return (
    <div className="relative">
      <svg viewBox={`-36 -10 ${plotSize + 50} ${plotSize + 46}`} className="w-full" role="img" aria-label="Risk matrix: attrition risk against burnout">
        <rect x="0" y="0" width={plotSize} height={plotSize} className="fill-rose-50" />
        <rect x="0" y={toY(criticalFrom)} width={toX(criticalFrom)} height={plotSize - toY(criticalFrom)} className="fill-amber-50" />
        <rect x="0" y={toY(elevatedFrom)} width={toX(elevatedFrom)} height={plotSize - toY(elevatedFrom)} className="fill-emerald-50" />
        {[0, 25, 50, 75, 100].map((tickValue) => (
          <g key={tickValue}>
            <line x1={toX(tickValue)} y1="0" x2={toX(tickValue)} y2={plotSize} className="stroke-white" strokeWidth="1" />
            <line x1="0" y1={toY(tickValue)} x2={plotSize} y2={toY(tickValue)} className="stroke-white" strokeWidth="1" />
            <text x={toX(tickValue)} y={plotSize + 14} textAnchor="middle" className="fill-slate-400 text-[9px]">
              {tickValue}
            </text>
            <text x="-8" y={toY(tickValue) + 3} textAnchor="end" className="fill-slate-400 text-[9px]">
              {tickValue}
            </text>
          </g>
        ))}
        <text x={plotSize / 2} y={plotSize + 32} textAnchor="middle" className="fill-slate-500 text-[10px] font-semibold">
          Attrition risk →
        </text>
        <text x={-26} y={plotSize / 2} textAnchor="middle" transform={`rotate(-90 -26 ${plotSize / 2})`} className="fill-slate-500 text-[10px] font-semibold">
          Burnout →
        </text>
        {scoredEmployees.map((employee) => (
          <circle
            key={employee.employeeId}
            cx={toX(employee.attritionRiskIndex)}
            cy={toY(employee.currentBurnoutScore)}
            r={hoveredEmployee?.employeeId === employee.employeeId ? 7 : 5}
            className={`${RISK_BAND_DISPLAY[employee.overallBand].dotClassName} cursor-pointer stroke-white transition-all`}
            strokeWidth="1.5"
            tabIndex={0}
            onMouseEnter={() => setHoveredEmployee(employee)}
            onFocus={() => setHoveredEmployee(employee)}
            onMouseLeave={() => setHoveredEmployee(null)}
            onBlur={() => setHoveredEmployee(null)}
          >
            <title>{`${employee.name}: attrition ${employee.attritionRiskIndex}, burnout ${employee.currentBurnoutScore}`}</title>
          </circle>
        ))}
      </svg>
      {hoveredEmployee && (
        <div className="pointer-events-none absolute top-2 right-2 rounded-xl bg-slate-900/90 px-3 py-2 text-xs text-white shadow-lg">
          <p className="font-semibold">{hoveredEmployee.name}</p>
          <p className="text-slate-300">
            Attrition {Math.round(hoveredEmployee.attritionRiskIndex)} · Burnout {Math.round(hoveredEmployee.currentBurnoutScore)}
          </p>
        </div>
      )}
    </div>
  );
}

export default function WorkforceRiskPanel() {
  const [filters, setFilters] = useState({ band: '', sortBy: 'attrition', departmentId: '' });
  const { data, error, isLoading } = useApiResource((signal) => requestWorkforceRisk({ ...filters, limit: 500 }, signal), [filters.band, filters.sortBy, filters.departmentId]);
  // Department options come from the unfiltered roster, so choosing one does not hide the others.
  const rosterResource = useApiResource((signal) => requestWorkforceRisk({ limit: 500 }, signal), []);
  const departmentOptions = useMemo(() => {
    const departmentsById = new Map();
    for (const employee of rosterResource.data?.employees ?? []) {
      if (employee.departmentId) departmentsById.set(employee.departmentId, employee.departmentName ?? 'Unnamed department');
    }
    return [{ value: '', label: 'All departments' }, ...[...departmentsById].map(([departmentId, departmentName]) => ({ value: departmentId, label: departmentName }))];
  }, [rosterResource.data]);

  if (isLoading && !data) return <LoadingBlock label="Loading workforce risk…" />;
  if (error) return <Notice tone="error" title={error.status === 403 ? 'Workforce analytics are available to HR and administrators only.' : error.message} />;
  if (!data) return null;

  const { summary, employees, thresholds } = data;
  const overall = summary.overall;
  const updateFilter = (filterName) => (changeEvent) => setFilters({ ...filters, [filterName]: changeEvent.target.value });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Critical" value={overall.critical ?? 0} hint={`Score ≥ ${thresholds.criticalFrom}`} accent="rose" />
        <StatTile label="Elevated" value={overall.elevated ?? 0} hint={`${thresholds.elevatedFrom} – ${thresholds.criticalFrom - 1}`} accent="amber" />
        <StatTile label="Safe" value={overall.safe ?? 0} hint={`Below ${thresholds.elevatedFrom}`} accent="emerald" />
        <StatTile label="Unscored" value={overall.unscored ?? 0} hint={summary.lastScoredAt ? `Last model run ${formatDateTime(summary.lastScoredAt)}` : 'No model run yet'} accent="slate" />
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Risk matrix" subtitle="Each dot is an employee; the worse metric sets the colour." className="xl:col-span-2">
          {employees.some((employee) => employee.overallBand !== 'unscored') ? (
            <RiskMatrix employees={employees} thresholds={thresholds} />
          ) : (
            <EmptyState Icon={ChartIcon} title="No scores yet" description="Scores appear after the analytics model's next run." />
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Avg. attrition risk</p>
              <p className="text-lg font-bold">{summary.averageAttritionRiskIndex ?? '—'}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Avg. burnout</p>
              <p className="text-lg font-bold">{summary.averageBurnoutScore ?? '—'}</p>
            </div>
          </div>
        </Card>

        <Card
          title="Employees"
          subtitle={`${employees.length} of ${summary.currentEmployees} current employees`}
          className="xl:col-span-3"
          bodyClassName="p-0"
          actions={
            <div className="flex flex-wrap gap-2">
              <SelectInput label="Department" value={filters.departmentId} onChange={updateFilter('departmentId')} options={departmentOptions} className="w-44" />
              <SelectInput
                label="Band"
                value={filters.band}
                onChange={updateFilter('band')}
                options={[{ value: '', label: 'All bands' }, ...Object.entries(RISK_BAND_DISPLAY).map(([bandId, bandDisplay]) => ({ value: bandId, label: bandDisplay.label }))]}
                className="w-36"
              />
              <SelectInput label="Sort by" value={filters.sortBy} onChange={updateFilter('sortBy')} options={[{ value: 'attrition', label: 'Attrition' }, { value: 'burnout', label: 'Burnout' }]} className="w-32" />
            </div>
          }
        >
          {employees.length === 0 ? (
            <div className="p-6">
              <EmptyState Icon={ChartIcon} title="No employees match these filters" />
            </div>
          ) : (
            <div className="max-h-[32rem] overflow-auto scroll-thin">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white/95 text-left text-xs tracking-wide text-slate-500 uppercase backdrop-blur">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Employee</th>
                    <th className="px-3 py-3 font-semibold">Attrition</th>
                    <th className="px-3 py-3 font-semibold">Burnout</th>
                    <th className="px-5 py-3 font-semibold">Band</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {employees.map((employee) => (
                    <tr key={employee.employeeId} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900">{employee.name ?? 'Unnamed'}</p>
                        <p className="text-xs text-slate-500">
                          {employee.designation} · {employee.departmentName ?? '—'}
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <MetricBar value={employee.attritionRiskIndex} band={employee.attritionBand} />
                      </td>
                      <td className="px-3 py-3">
                        <MetricBar value={employee.currentBurnoutScore} band={employee.burnoutBand} />
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={RISK_BAND_DISPLAY[employee.overallBand].tone}>{RISK_BAND_DISPLAY[employee.overallBand].label}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
