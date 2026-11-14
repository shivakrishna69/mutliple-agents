/**
 * Attendance charts for HR, administrators and team leads, over the people the Today board shows
 * them (the backend decides who that is; anyone else gets 403 and sees nothing here):
 *
 *   full      (Attendance → Team insights) today's donut, departments this month, arrivals over the
 *             last 7 days, and each person's month day by day with their completion
 *   compact   (dashboard, analytics hub) departments this month and arrivals over the last 7 days
 *
 * A month can be chosen (this month or earlier); the Today board is passed in when the page already
 * has it, so it is not asked for twice.
 */

import { useState } from 'react';
import { requestAttendanceAnalytics, requestTodayBoard } from '../../api/workforceApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { localToday } from '../../utils/dates.js';
import { Card, LoadingBlock, Notice } from '../ui.jsx';
import ArrivalDistributionChart from './ArrivalDistributionChart.jsx';
import CompletionHeatmap from './CompletionHeatmap.jsx';
import DepartmentCompletionChart from './DepartmentCompletionChart.jsx';
import StatusDonut from './StatusDonut.jsx';

const FORBIDDEN_STATUS = 403;

function MonthPicker({ month, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      <span className="font-medium">Month</span>
      <input
        type="month"
        value={month}
        max={localToday().slice(0, 7)}
        onChange={(changeEvent) => changeEvent.target.value && onChange(changeEvent.target.value)}
        className="rounded-lg border-0 bg-white py-1.5 pl-3 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500"
      />
    </label>
  );
}

export default function AttendanceInsights({ variant = 'full', todayBoard = null }) {
  const isFull = variant === 'full';
  const [month, setMonth] = useState(() => localToday().slice(0, 7));
  const analytics = useApiResource((signal) => requestAttendanceAnalytics({ month }, signal), [month]);
  const loadedToday = useApiResource((signal) => requestTodayBoard({}, signal), [], {
    enabled: isFull && !todayBoard,
  });
  const today = todayBoard ?? loadedToday.data;

  if (analytics.error?.status === FORBIDDEN_STATUS) return null;
  if (analytics.error) return <Notice tone="error" title={analytics.error.message} />;
  if (!analytics.data) return <LoadingBlock label="Loading attendance analytics…" />;
  const { people, departments, arrivals } = analytics.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {analytics.data.scope === 'direct_reports' ? 'Your team' : 'Everyone'} · {people.length} people
        </p>
        <MonthPicker month={month} onChange={setMonth} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {isFull && (
          <Card title="Today" subtitle="Who is in, late, on leave or not in yet">
            {today ? <StatusDonut counts={today.counts} /> : <LoadingBlock label="Loading today…" />}
          </Card>
        )}
        <Card title="Check-in completion by department" subtitle="Days present of days expected, this month">
          <DepartmentCompletionChart departments={departments} />
        </Card>
        <Card
          title="Arrival times"
          subtitle="Punch-ins over the last 7 days, per half hour"
          className={isFull ? '' : 'lg:col-span-1'}
        >
          <ArrivalDistributionChart arrivals={arrivals} />
        </Card>
      </div>
      {isFull && (
        <Card title="Each person this month" subtitle="Day by day, with their check-in completion">
          <CompletionHeatmap people={people} />
        </Card>
      )}
    </div>
  );
}
