/**
 * Attendance analytics for HR, administrators and team leads, over the same people the Today board
 * shows them (services/teamRoster.js: everyone, or one department, for HR and administrators; a
 * lead's direct reports): read only.
 *
 *   month         per person, every day of the month so far, judged like the Today board (their
 *                 office's calendar, approved leave, their punch):
 *                   on_time / late   a punch-in (late includes half days: both came after the grace)
 *                   leave            approved full-day leave
 *                   absent           a working day without a punch-in, before today
 *                   holiday / weekly_off, not_joined (before their joining date), upcoming (today
 *                   without a punch-in yet, and later days)
 *                 Completion = days present ÷ days expected. Expected: working days from joining to
 *                 today (today only once punched in), less approved leave (a half day counts half).
 *                 A working day with a punch counts present up to what was expected of it. People
 *                 without a base office have no working days to judge: completion null.
 *   departments   the same sums per department: present ÷ expected, with headcount
 *   arrivals      punch-in times over the last ARRIVAL_DAYS days (to today), in each person's office
 *                 time (the company's for people without an office), counted per ARRIVAL_SLOT_MINUTES
 *                 slot and day, with each day's median arrival
 *
 * getOwnAttendanceMonth gives one person the same month for themselves, with their punch times.
 */

import { DAY_KINDS } from '../constants/calendarDays.js';
import { ATTENDANCE_MESSAGES } from '../constants/messages.js';
import { ATTENDANCE_ANALYTICS } from '../constants/validation.js';
import Attendance, { ATTENDANCE_STATUSES } from '../models/Attendance.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import { addDaysToCalendarDate, listCalendarDates } from '../utils/calendarDates.js';
import { readOfficeLocalClock } from './attendancePolicy.js';
import { LEAVE_HALVES, loadApprovedLeave } from './attendanceToday.js';
import { loadTeamRoster, resolveTeamScope, toPersonView } from './teamRoster.js';
import { loadOfficeCalendar } from './workCalendar.js';
import { classifyCalendarDay } from './workingDays.js';

export const ANALYTICS_DAY_STATUSES = Object.freeze({
  ON_TIME: 'on_time',
  LATE: 'late',
  LEAVE: 'leave',
  ABSENT: 'absent',
  HOLIDAY: 'holiday',
  WEEKLY_OFF: 'weekly_off',
  NOT_JOINED: 'not_joined',
  UPCOMING: 'upcoming',
});
const DAY = ANALYTICS_DAY_STATUSES;

const ANALYTICS_FORBIDDEN = Object.freeze({
  code: 'ANALYTICS_FORBIDDEN',
  message: ATTENDANCE_MESSAGES.ANALYTICS_FORBIDDEN,
});
const MINUTES_PER_DAY = 24 * 60;
const roundShare = (present, expected) => (expected > 0 ? Math.round((present / expected) * 1000) / 1000 : null);
/** Every date of a "YYYY-MM" month. */
function datesOfMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return listCalendarDates(`${month}-01`, `${month}-${String(dayCount).padStart(2, '0')}`);
}
/** "HH:MM" for minutes since midnight. */
export const asClockTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * One person's month, pure.
 * @param {{ dates: string[], today: string, joinedOn: string|null, hasOffice: boolean,
 *   dayKindOf: (date: string) => string, leaveOf: (date: string) => string|null,
 *   punchOf: (date: string) => { calculationStatus: string }|null }} input
 *   leaveOf answers FULL, FIRST, SECOND or null
 * @returns {{ days: { date: string, status: string }[], expectedDays: number, presentDays: number,
 *   lateDays: number, completion: number|null }}
 */
export function judgeMonth({ dates, today, joinedOn, hasOffice, dayKindOf, leaveOf, punchOf }) {
  let expectedDays = 0;
  let presentDays = 0;
  let lateDays = 0;
  const days = dates.map((date) => {
    if (joinedOn && date < joinedOn) return { date, status: DAY.NOT_JOINED };
    if (date > today) return { date, status: DAY.UPCOMING };
    const punch = punchOf(date);
    const leave = leaveOf(date);
    const kind = hasOffice ? dayKindOf(date) : null;
    const expected = kind === DAY_KINDS.WORKING ? (leave === null ? 1 : leave === LEAVE_HALVES.FULL ? 0 : 0.5) : 0;
    if (punch) {
      const isLate = punch.calculationStatus !== ATTENDANCE_STATUSES.NORMAL;
      if (isLate) lateDays += 1;
      expectedDays += expected;
      presentDays += expected;
      return { date, status: isLate ? DAY.LATE : DAY.ON_TIME };
    }
    if (leave === LEAVE_HALVES.FULL) return { date, status: DAY.LEAVE };
    if (kind === DAY_KINDS.HOLIDAY) return { date, status: DAY.HOLIDAY };
    if (kind === DAY_KINDS.WEEKLY_OFF) return { date, status: DAY.WEEKLY_OFF };
    if (!hasOffice || date === today) return { date, status: DAY.UPCOMING };
    expectedDays += expected;
    // Half-day leave without a punch: the other half was missed.
    return { date, status: DAY.ABSENT };
  });
  return {
    days,
    expectedDays,
    presentDays,
    lateDays,
    // Without an office nothing is expected, so there is no completion (null).
    completion: roundShare(presentDays, expectedDays),
  };
}

/**
 * Punch-in times bucketed per slot and day, pure.
 * @param {{ dates: string[], arrivals: { date: string, minutes: number }[], slotMinutes: number }} input
 *   minutes: local minutes since midnight
 */
export function bucketArrivals({ dates, arrivals, slotMinutes }) {
  const slotCount = MINUTES_PER_DAY / slotMinutes;
  const counts = Array.from({ length: slotCount }, () => dates.map(() => 0));
  const minutesByDate = new Map(dates.map((date) => [date, []]));
  for (const { date, minutes } of arrivals) {
    const dateIndex = dates.indexOf(date);
    if (dateIndex === -1) continue;
    counts[Math.floor(minutes / slotMinutes)][dateIndex] += 1;
    minutesByDate.get(date).push(minutes);
  }
  const used = counts.map((row, index) => ({ index, total: row.reduce((sum, count) => sum + count, 0) }));
  const first = used.find((slot) => slot.total > 0)?.index ?? null;
  const last = used.findLast((slot) => slot.total > 0)?.index ?? null;
  const slots =
    first === null
      ? []
      : counts.slice(first, last + 1).map((row, offset) => ({
          start: asClockTime((first + offset) * slotMinutes),
          counts: row,
          total: row.reduce((sum, count) => sum + count, 0),
        }));
  const medians = dates.map((date) => {
    const sorted = [...minutesByDate.get(date)].sort((a, b) => a - b);
    if (sorted.length === 0) return { date, count: 0, median: null };
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
    return { date, count: sorted.length, median: asClockTime(median) };
  });
  return { slotMinutes, dates, slots, medians };
}

/** Each office's calendar from `firstDate` to `lastDate`, by office id. */
async function loadCalendars(officesById, firstDate, lastDate) {
  const entries = await Promise.all(
    [...officesById.keys()].map(async (officeId) => [
      officeId,
      await loadOfficeCalendar(officeId, firstDate, lastDate),
    ]),
  );
  return new Map(entries);
}

/**
 * @param {{ viewer: { id: string, role: string }, month?: string|null, departmentId?: string|null, now?: Date }} request
 *   month "YYYY-MM" (default: the company's current month); a later month is refused upstream
 */
export async function getAttendanceAnalytics({ viewer, month = null, departmentId = null, now = new Date() }) {
  const { scope, filter } = await resolveTeamScope(viewer, { departmentId, forbidden: ANALYTICS_FORBIDDEN });
  const { people, officesById, companyTimeZone } = await loadTeamRoster({ filter, now });
  const companyToday = readOfficeLocalClock(now, companyTimeZone).calendarDate;
  const chosenMonth = month ?? companyToday.slice(0, 7);
  const monthDates = datesOfMonth(chosenMonth);
  const firstDate = monthDates[0];
  const lastDate = monthDates.at(-1);
  const arrivalDates = listCalendarDates(
    addDaysToCalendarDate(companyToday, 1 - ATTENDANCE_ANALYTICS.ARRIVAL_DAYS),
    companyToday,
  );

  const employeeIds = people.map((person) => person.employeeId);
  const rangeStart = monthDates[0] < arrivalDates[0] ? monthDates[0] : arrivalDates[0];
  const rangeEnd = monthDates.at(-1) > arrivalDates.at(-1) ? monthDates.at(-1) : arrivalDates.at(-1);
  const [punches, leaveByKey, calendars] = await Promise.all([
    Attendance.find({ employeeId: { $in: employeeIds }, date: { $gte: rangeStart, $lte: rangeEnd } })
      .select('employeeId date calculationStatus checkInTime')
      .lean(),
    loadApprovedLeave(employeeIds, monthDates),
    loadCalendars(officesById, firstDate, lastDate),
  ]);
  const punchByKey = new Map(punches.map((punch) => [`${punch.employeeId}|${punch.date}`, punch]));
  const timeZoneOf = (person) => person.office?.timeZone ?? companyTimeZone;
  const personById = new Map(people.map((person) => [person.employeeId, person]));

  const monthRows = people.map((person) => {
    const calendar = person.officeId ? calendars.get(person.officeId) : null;
    const judged = judgeMonth({
      dates: monthDates,
      today: readOfficeLocalClock(now, timeZoneOf(person)).calendarDate,
      joinedOn: person.joinedOn,
      hasOffice: Boolean(calendar),
      dayKindOf: (date) => classifyCalendarDay(date, calendar).kind,
      leaveOf: (date) => leaveByKey.get(`${person.employeeId}|${date}`) ?? null,
      punchOf: (date) => punchByKey.get(`${person.employeeId}|${date}`) ?? null,
    });
    return { person, ...judged };
  });

  const byDepartment = new Map();
  for (const row of monthRows) {
    const key = row.person.department?.id ?? null;
    const entry = byDepartment.get(key) ?? {
      department: row.person.department,
      headcount: 0,
      expectedDays: 0,
      presentDays: 0,
      lateDays: 0,
    };
    entry.headcount += 1;
    entry.expectedDays += row.expectedDays;
    entry.presentDays += row.presentDays;
    entry.lateDays += row.lateDays;
    byDepartment.set(key, entry);
  }

  const arrivals = punches
    // bucketArrivals counts only the arrival days.
    .filter((punch) => punch.checkInTime)
    .map((punch) => {
      const person = personById.get(punch.employeeId.toString());
      const clock = readOfficeLocalClock(punch.checkInTime, person ? timeZoneOf(person) : companyTimeZone);
      return { date: punch.date, minutes: clock.minutesSinceMidnight };
    });

  return {
    scope,
    month: chosenMonth,
    today: companyToday,
    people: monthRows.map(({ person, days, expectedDays, presentDays, lateDays, completion }) => ({
      ...toPersonView(person),
      expectedDays,
      presentDays,
      lateDays,
      completion,
      days,
    })),
    departments: [...byDepartment.values()]
      .map((entry) => ({ ...entry, completion: roundShare(entry.presentDays, entry.expectedDays) }))
      .sort((first, second) => (first.department?.name ?? '').localeCompare(second.department?.name ?? '')),
    arrivals: bucketArrivals({ dates: arrivalDates, arrivals, slotMinutes: ATTENDANCE_ANALYTICS.ARRIVAL_SLOT_MINUTES }),
  };
}

/**
 * One person's own month, for themselves (the NSK assistant): every day judged as in the analytics
 * above, with the punch-in and punch-out times in their office's time (the company's without an
 * office) and how long they worked.
 * @param {{ userId: string, month?: string|null, now?: Date }} request  month "YYYY-MM" (default: current)
 * @returns {Promise<object|null>} null when no employee profile is linked to the account; `person`
 *   null (and no days) when they have not joined yet
 */
export async function getOwnAttendanceMonth({ userId, month = null, now = new Date() }) {
  const profile = await EmployeeProfile.findOne({ userId }).select('_id').lean();
  if (!profile) return null;
  const { people, officesById, companyTimeZone } = await loadTeamRoster({ filter: { _id: profile._id }, now });
  const companyToday = readOfficeLocalClock(now, companyTimeZone).calendarDate;
  const chosenMonth = month ?? companyToday.slice(0, 7);
  const [person] = people;
  if (!person) return { month: chosenMonth, person: null, expectedDays: 0, presentDays: 0, lateDays: 0, days: [] };

  const monthDates = datesOfMonth(chosenMonth);
  const timeZone = person.office?.timeZone ?? companyTimeZone;
  const [punches, leaveByKey, calendars] = await Promise.all([
    Attendance.find({ employeeId: profile._id, date: { $gte: monthDates[0], $lte: monthDates.at(-1) } })
      .select('date calculationStatus checkInTime checkOutTime workedMinutes workMode')
      .lean(),
    loadApprovedLeave([profile._id], monthDates),
    loadCalendars(officesById, monthDates[0], monthDates.at(-1)),
  ]);
  const punchByDate = new Map(punches.map((punch) => [punch.date, punch]));
  const calendar = person.officeId ? calendars.get(person.officeId) : null;
  const judged = judgeMonth({
    dates: monthDates,
    today: readOfficeLocalClock(now, timeZone).calendarDate,
    joinedOn: person.joinedOn,
    hasOffice: Boolean(calendar),
    dayKindOf: (date) => classifyCalendarDay(date, calendar).kind,
    leaveOf: (date) => leaveByKey.get(`${person.employeeId}|${date}`) ?? null,
    punchOf: (date) => punchByDate.get(date) ?? null,
  });
  const localTime = (instant) =>
    instant ? asClockTime(readOfficeLocalClock(instant, timeZone).minutesSinceMidnight) : null;
  return {
    month: chosenMonth,
    timeZone,
    person: toPersonView(person),
    expectedDays: judged.expectedDays,
    presentDays: judged.presentDays,
    lateDays: judged.lateDays,
    completion: judged.completion,
    days: judged.days.map((day) => {
      const punch = punchByDate.get(day.date);
      return {
        ...day,
        leave: leaveByKey.get(`${person.employeeId}|${day.date}`) ?? null,
        punchIn: localTime(punch?.checkInTime),
        punchOut: localTime(punch?.checkOutTime),
        workedMinutes: punch?.workedMinutes ?? null,
        workMode: punch?.workMode ?? null,
      };
    }),
  };
}
