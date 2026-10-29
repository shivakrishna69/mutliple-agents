/**
 * The employee's month at a glance: working days, weekly offs and holidays of their base office,
 * with their own leave marked (approved, or waiting for approval).
 *
 *   GET /api/work-calendar/days?from=&to=   their office's calendar (no office: the backend says so)
 *   GET /api/leave/requests                 their requests; cancelled and declined ones are left out
 */

import { useState } from 'react';
import { requestOwnLeaveRequests } from '../../api/leaveApi.js';
import { requestCalendarDays } from '../../api/workplaceApi.js';
import { REQUEST_STATUS_DISPLAY } from '../../constants/leave.js';
import { WEEKDAY_NAMES, WEEKDAYS_FROM_MONDAY } from '../../constants/workplace.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { currentLocalMonth, localToday } from '../../utils/dates.js';
import { Badge, Button, Card, LoadingBlock, MONTH_NAMES, Notice } from '../ui.jsx';

const SHOWN_STATUSES = Object.freeze(['APPROVED', 'PENDING']);
const DAY_STYLES = Object.freeze({
  working: 'bg-white',
  weekly_off: 'bg-slate-100 text-slate-500',
  holiday: 'bg-rose-50 text-rose-800',
});

/** "2026-11" -> { firstDate, lastDate } of that month. */
function monthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { firstDate: `${month}-01`, lastDate: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function shiftMonth(month, step) {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + step, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** date -> the request (approved or pending) that takes it, from its priced days and border charges. */
function leaveByDate(requests) {
  const byDate = new Map();
  for (const request of requests.filter((candidate) => SHOWN_STATUSES.includes(candidate.status))) {
    for (const day of [...request.days, ...request.borderCharges]) {
      if (day.chargedDays > 0 || day.kind === 'working') byDate.set(day.date, request);
    }
  }
  return byDate;
}

export default function LeaveCalendarPanel() {
  const [month, setMonth] = useState(currentLocalMonth());
  const { firstDate, lastDate } = monthRange(month);
  const daysResource = useApiResource(
    (signal) => requestCalendarDays({ from: firstDate, to: lastDate }, signal),
    [firstDate, lastDate],
  );
  const requestsResource = useApiResource((signal) => requestOwnLeaveRequests({}, signal), []);
  const today = localToday();
  const [year, monthNumber] = month.split('-').map(Number);
  const leaveOnDate = leaveByDate(requestsResource.data?.requests ?? []);
  const days = daysResource.data?.days ?? [];
  // Blank cells before the 1st, so columns line up Monday to Sunday.
  const leadingBlanks = days.length
    ? WEEKDAYS_FROM_MONDAY.indexOf(new Date(`${days[0].date}T00:00:00Z`).getUTCDay())
    : 0;

  return (
    <Card
      title={`${MONTH_NAMES[monthNumber - 1]} ${year}`}
      subtitle={daysResource.data ? `Working days at ${daysResource.data.office.name}` : 'Your office calendar'}
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setMonth(shiftMonth(month, -1))}
            aria-label="Previous month"
          >
            ←
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setMonth(currentLocalMonth())}>
            This month
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
            →
          </Button>
        </div>
      }
    >
      {daysResource.error && <Notice tone="warning" title={daysResource.error.message} />}
      {daysResource.isLoading && !daysResource.data && <LoadingBlock label="Loading the calendar…" />}
      {daysResource.data && (
        <>
          <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-semibold text-slate-500 uppercase">
            {WEEKDAYS_FROM_MONDAY.map((weekday) => (
              <div key={weekday} className="py-1">
                {WEEKDAY_NAMES[weekday].slice(0, 3)}
              </div>
            ))}
          </div>
          <ol className="mt-1 grid grid-cols-7 gap-1.5">
            {Array.from({ length: leadingBlanks }, (_, blankIndex) => (
              <li key={`blank-${blankIndex}`} aria-hidden="true" />
            ))}
            {days.map((day) => {
              const request = leaveOnDate.get(day.date);
              const isToday = day.date === today;
              return (
                <li
                  key={day.date}
                  className={`min-h-20 rounded-xl p-2 text-left ring-1 ring-slate-200/70 ${DAY_STYLES[day.kind]} ${
                    isToday ? 'ring-2 ring-indigo-500' : ''
                  }`}
                >
                  <p className="text-sm font-semibold">{Number(day.date.slice(8))}</p>
                  {day.holidayName && <p className="mt-0.5 truncate text-[0.7rem]">{day.holidayName}</p>}
                  {request && (
                    <Badge tone={REQUEST_STATUS_DISPLAY[request.status].tone} className="mt-1 max-w-full truncate">
                      {request.leaveType.code}
                      {request.status === 'PENDING' ? ' ?' : ''}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-slate-100 ring-1 ring-slate-200" /> Weekly off
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-rose-50 ring-1 ring-rose-200" /> Holiday
            </span>
            <span className="flex items-center gap-1.5">
              <Badge tone="emerald">CL</Badge> Approved leave
            </span>
            <span className="flex items-center gap-1.5">
              <Badge tone="amber">CL ?</Badge> Waiting for approval
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
