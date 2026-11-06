/**
 * The dashboard's people parts (HR and administrators) and the person's own day (anyone with an
 * employee profile), from GET /api/dashboard/overview `people` and `me`:
 *
 *   PeopleStats      attendance today, what is waiting for you, headcount, presence now
 *   HolidaysPanel    the next holidays
 *   HeadcountPanel   current employees by department
 *   SelfStats        today's punch-in, leave balances, pending requests, latest payslip
 */

import { ATTENDANCE_DAY_LABELS, PRESENCE_DISPLAY } from '../../constants/dashboardDisplay.js';
import { ROUTE_PATHS } from '../../constants/routes.js';
import { MONTH_NAMES } from '../ui.jsx';
import { formatCalendarDate, formatClockTime, formatMinutes } from '../../utils/dashboardFormat.js';
import { BuildingIcon, CalendarIcon, CurrencyIcon, InboxIcon, MapPinIcon, UsersIcon } from '../Icons.jsx';
import { ArrowLink, Panel, Pill, StatCard } from './DashboardParts.jsx';

export function PeopleStats({ people }) {
  const { attendance, waiting, headcount, presence } = people;
  const waitingTotal = waiting.leaveRequests + waiting.leaveChanges + waiting.attendanceCorrections;
  return (
    <>
      <StatCard
        label="Present today"
        value={attendance.present}
        suffix={`of ${attendance.employees}`}
        Icon={MapPinIcon}
        tone="emerald"
        note={`${attendance.late} late · ${attendance.onLeave} on leave · ${attendance.notInYet} not in yet`}
        link={{ to: ROUTE_PATHS.ATTENDANCE, label: 'Today board' }}
      />
      <StatCard
        label="Waiting for you"
        value={waitingTotal}
        suffix={waitingTotal === 0 ? 'all clear' : 'to decide'}
        Icon={InboxIcon}
        tone={waitingTotal > 0 ? 'amber' : 'slate'}
        note={`${waiting.leaveRequests} leave · ${waiting.leaveChanges} changes · ${waiting.attendanceCorrections} attendance`}
        link={{ to: ROUTE_PATHS.LEAVE, label: 'Approvals' }}
      />
      <StatCard
        label="Headcount"
        value={headcount.employees}
        suffix={headcount.joinersThisMonth > 0 ? `+${headcount.joinersThisMonth} this month` : null}
        Icon={UsersIcon}
        tone="violet"
        note={
          // Attendance counts only people who have started and activated their account; the
          // headcount also includes invitations not yet accepted and joiners starting later.
          headcount.employees > attendance.employees
            ? `${headcount.employees - attendance.employees} yet to start or activate`
            : `${headcount.byDepartment.length} department${headcount.byDepartment.length === 1 ? '' : 's'}`
        }
        link={{ to: ROUTE_PATHS.ORGANISATION, label: 'Directory' }}
      />
      <StatCard
        label="Available now"
        value={presence ? presence.available : '—'}
        suffix={presence ? `${presence.away} away` : 'presence off'}
        Icon={BuildingIcon}
        tone="blue"
        note={
          presence
            ? PRESENCE_DISPLAY.filter(({ key }) => !['available', 'away'].includes(key))
                .map(({ key, label }) => `${presence[key] ?? 0} ${label.toLowerCase()}`)
                .join(' · ')
            : 'Switched off in company settings'
        }
      />
    </>
  );
}

export function HolidaysPanel({ holidays, title = 'Upcoming holidays' }) {
  return (
    <Panel title={title} action={<ArrowLink to={ROUTE_PATHS.LEAVE}>Calendar</ArrowLink>}>
      {holidays.length === 0 ? (
        <p className="text-sm text-slate-500">No holidays in the coming year yet.</p>
      ) : (
        <ul className="space-y-3">
          {holidays.map((holiday) => (
            <li key={holiday.id} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3.5">
              <span className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl bg-white text-brand-600 ring-1 ring-slate-200">
                <span className="text-[10px] font-semibold uppercase">
                  {formatCalendarDate(holiday.date, { month: 'short' })}
                </span>
                <span className="text-sm leading-none font-bold">
                  {formatCalendarDate(holiday.date, { day: 'numeric' })}
                </span>
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{holiday.name}</p>
                <p className="text-xs text-slate-500">
                  {formatCalendarDate(holiday.date, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function HeadcountPanel({ headcount }) {
  const largest = Math.max(1, ...headcount.byDepartment.map((department) => department.count));
  return (
    <Panel title="Headcount by department" subtitle={`${headcount.employees} current employees`}>
      {headcount.byDepartment.length === 0 ? (
        <p className="text-sm text-slate-500">No employees yet. Invite people from Onboarding.</p>
      ) : (
        <ul className="space-y-3">
          {headcount.byDepartment.map((department) => (
            <li key={department.departmentId ?? 'none'}>
              <div className="flex items-center justify-between text-sm">
                <span className="truncate text-slate-700">{department.name ?? 'No department'}</span>
                <span className="font-semibold text-slate-900 tabular-nums">{department.count}</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-slate-100" aria-hidden="true">
                <div
                  className="h-1.5 rounded-full bg-brand-600"
                  style={{ width: `${Math.round((department.count / largest) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function SelfStats({ me }) {
  const { today, leaveBalances, pendingLeave, latestPayslip } = me;
  const punchedIn = Boolean(today.checkInTime);
  return (
    <>
      <StatCard
        label="Today"
        value={<span className="text-2xl">{ATTENDANCE_DAY_LABELS[today.status] ?? today.status}</span>}
        Icon={MapPinIcon}
        tone={punchedIn ? 'emerald' : 'amber'}
        note={
          punchedIn
            ? `In at ${formatClockTime(today.checkInTime)}${today.workedMinutes !== null ? ` · ${formatMinutes(today.workedMinutes)} worked` : ''}`
            : (today.holidayName ?? formatCalendarDate(today.date, { weekday: 'long', day: 'numeric', month: 'long' }))
        }
        link={{ to: ROUTE_PATHS.ATTENDANCE, label: punchedIn ? 'Attendance' : 'Punch in' }}
      />
      <StatCard
        label="Leave balance"
        value={leaveBalances[0] ? leaveBalances[0].availableDays : '—'}
        suffix={leaveBalances[0] ? `${leaveBalances[0].code} days` : null}
        Icon={CalendarIcon}
        tone="blue"
        note={
          leaveBalances.length > 1
            ? leaveBalances
                .slice(1)
                .map((balance) => `${balance.availableDays} ${balance.code}`)
                .join(' · ')
            : 'Available to take'
        }
        link={{ to: ROUTE_PATHS.LEAVE, label: 'Apply' }}
      />
      <StatCard
        label="My pending requests"
        value={pendingLeave}
        suffix={pendingLeave === 1 ? 'request' : 'requests'}
        Icon={InboxIcon}
        tone="violet"
        note="Waiting for a decision"
        link={{ to: ROUTE_PATHS.LEAVE, label: 'My leave' }}
      />
      <StatCard
        label="Latest payslip"
        value={
          <span className="text-2xl">
            {latestPayslip ? `${MONTH_NAMES[latestPayslip.month - 1].slice(0, 3)} ${latestPayslip.year}` : '—'}
          </span>
        }
        Icon={CurrencyIcon}
        tone="emerald"
        note={latestPayslip ? 'Issued' : 'No payslip yet'}
        link={{ to: ROUTE_PATHS.PAYROLL, label: 'Payroll' }}
      />
    </>
  );
}

export function NextHolidayPill({ holiday }) {
  if (!holiday) return null;
  return (
    <Pill className="bg-white text-slate-700 ring-1 ring-slate-200">
      <CalendarIcon className="h-3.5 w-3.5 text-brand-600" />
      Next holiday: {holiday.name}, {formatCalendarDate(holiday.date)}
    </Pill>
  );
}
