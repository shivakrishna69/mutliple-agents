/**
 * Presence as people see it: who is available, away or offline now, and each day's numbers
 * (services/presenceMetrics.js) beside the day's attendance.
 *
 * Status now (PRESENCE_DISPLAY_STATUSES): available and away come from the app; someone offline is
 * shown "on leave" on approved leave, "off work" once punched out, on a holiday or weekly off, or
 * outside their shift, and "offline" otherwise (a working hour with the app closed).
 *
 * Who appears is services/teamRoster.js's rule: HR and administrators everyone, managers their
 * reports, everyone their own days. Days older than the company's presence.detailRetentionDays are
 * read from the nightly summaries (models/PresenceDaySummary.js), their detail being gone.
 */

import { PRESENCE_MESSAGES } from '../constants/messages.js';
import PresenceDaySummary from '../models/PresenceDaySummary.js';
import PresenceInterval from '../models/PresenceInterval.js';
import { addDaysToCalendarDate } from '../utils/calendarDates.js';
import {
  localDayStart,
  readOfficeLocalClock,
  workedMinutesBetween,
  zonedLocalTimeToInstant,
} from './attendancePolicy.js';
import { loadAttendanceDays, TODAY_STATUSES } from './attendanceToday.js';
import { loadCurrentPresence, PRESENCE_STATUSES } from './presence.js';
import { summarizePresenceDay } from './presenceMetrics.js';
import { loadPresenceSettings } from './presenceSettings.js';
import { CURRENT_EMPLOYEES, loadTeamRoster, resolveTeamScope, toPersonView } from './teamRoster.js';

export const PRESENCE_DISPLAY_STATUSES = Object.freeze({
  ...PRESENCE_STATUSES,
  ON_LEAVE: 'on_leave',
  OFF_WORK: 'off_work',
});

const PRESENCE_FORBIDDEN = Object.freeze({ code: 'PRESENCE_FORBIDDEN', message: PRESENCE_MESSAGES.FORBIDDEN });

/** Attendance statuses of a day with no shift to keep: nobody is expected at work. */
const DAYS_OFF = Object.freeze([TODAY_STATUSES.HOLIDAY, TODAY_STATUSES.WEEKLY_OFF, TODAY_STATUSES.NO_OFFICE]);

const isoOrNull = (date) => date?.toISOString() ?? null;
const timeZoneOf = (person, companyTimeZone) => person.office?.timeZone ?? companyTimeZone;

/** The day's first and next day's first instant in the zone (01:00 where midnight is skipped). */
function dayBounds(date, timeZone) {
  return { dayStart: localDayStart(date, timeZone), dayEnd: localDayStart(addDaysToCalendarDate(date, 1), timeZone) };
}

/**
 * The person's shift on their day, or null when there is none to keep. A half day of leave keeps
 * the whole shift (the half is not subtracted).
 */
function shiftOf(person, attendanceDay) {
  if (!person.office || DAYS_OFF.includes(attendanceDay.status) || attendanceDay.leaveHalf === 'FULL') return null;
  const { shiftStartLocalTime, shiftEndLocalTime } = person.office.workday;
  const start = zonedLocalTimeToInstant(attendanceDay.date, shiftStartLocalTime, person.office.timeZone);
  const end = zonedLocalTimeToInstant(attendanceDay.date, shiftEndLocalTime, person.office.timeZone);
  return start && end ? { start, end } : null;
}

/** Minutes punched in: closed punches as recorded, an open one up to now. */
function workedMinutesOf(punch, now) {
  if (!punch) return null;
  return punch.workedMinutes ?? workedMinutesBetween(punch.checkInTime, now);
}

/** Each listed person's intervals overlapping [from, to), by user id. */
async function loadIntervalsByUser(userIds, from, to) {
  const intervals = await PresenceInterval.find({
    userId: { $in: userIds },
    startedAt: { $lt: to },
    $or: [{ endedAt: null }, { endedAt: { $gt: from } }],
  })
    .select('userId state startedAt endedAt')
    .lean();
  const intervalsByUser = new Map();
  for (const interval of intervals) {
    const userId = interval.userId.toString();
    intervalsByUser.set(userId, [...(intervalsByUser.get(userId) ?? []), interval]);
  }
  return intervalsByUser;
}

/** Each person's numbers for their attendance day, by employee id. */
async function computePresenceDays({ people, companyTimeZone, attendanceDays, now }) {
  const days = people.map((person) => {
    const attendanceDay = attendanceDays.get(person.employeeId);
    const timeZone = timeZoneOf(person, companyTimeZone);
    return { person, attendanceDay, timeZone, ...dayBounds(attendanceDay.date, timeZone) };
  });
  if (days.length === 0) return new Map();
  const from = new Date(Math.min(...days.map((day) => day.dayStart.getTime())));
  const to = new Date(Math.max(...days.map((day) => day.dayEnd.getTime())));
  const intervalsByUser = await loadIntervalsByUser(
    people.map((person) => person.userId),
    from,
    to,
  );
  return new Map(
    days.map(({ person, attendanceDay, timeZone, dayStart, dayEnd }) => [
      person.employeeId,
      {
        date: attendanceDay.date,
        timeZone,
        attendanceDay,
        metrics: summarizePresenceDay({
          intervals: intervalsByUser.get(person.userId) ?? [],
          dayStart,
          dayEnd,
          shift: shiftOf(person, attendanceDay),
          now,
        }),
      },
    ]),
  );
}

function toMetricsView(metrics) {
  return { ...metrics, firstSeenAt: isoOrNull(metrics.firstSeenAt), lastSeenAt: isoOrNull(metrics.lastSeenAt) };
}

/** One person's day as the daily views show it. */
function toDailyRow(person, { date, metrics, attendanceDay }, now) {
  const { punch } = attendanceDay;
  return {
    ...toPersonView(person),
    date,
    presence: toMetricsView(metrics),
    attendance: {
      status: attendanceDay.status,
      workMode: punch?.workMode ?? null,
      checkInTime: isoOrNull(punch?.checkInTime),
      checkOutTime: isoOrNull(punch?.checkOutTime),
      workedMinutes: workedMinutesOf(punch, now),
    },
    // Online on a working day without punching in: worth a word with them.
    activeWithoutPunchIn: metrics.availableMinutes > 0 && attendanceDay.status === TODAY_STATUSES.NOT_IN,
  };
}

/** A day read back from its nightly summary. */
function toSummaryRow(person, summary) {
  return {
    ...toPersonView(person),
    date: summary.date,
    presence: toMetricsView({
      availableMinutes: summary.availableMinutes,
      awayMinutes: summary.awayMinutes,
      onlineMinutes: summary.onlineMinutes,
      offlineDuringShiftMinutes: summary.offlineDuringShiftMinutes,
      firstSeenAt: summary.firstSeenAt,
      lastSeenAt: summary.lastSeenAt,
    }),
    attendance: {
      status: summary.attendanceStatus,
      workMode: null,
      checkInTime: null,
      checkOutTime: null,
      workedMinutes: summary.workedMinutes,
    },
    activeWithoutPunchIn: summary.availableMinutes > 0 && summary.attendanceStatus === TODAY_STATUSES.NOT_IN,
  };
}

/** The oldest date whose detail is still kept, in the company's zone. */
async function oldestDetailedDate(companyTimeZone, now) {
  const { detailRetentionDays } = await loadPresenceSettings();
  return addDaysToCalendarDate(readOfficeLocalClock(now, companyTimeZone).calendarDate, -detailRetentionDays);
}

function displayStatusOf(person, presence, attendanceDay, now) {
  if (presence.status !== PRESENCE_STATUSES.OFFLINE) return presence.status;
  if (attendanceDay.status === TODAY_STATUSES.ON_LEAVE) return PRESENCE_DISPLAY_STATUSES.ON_LEAVE;
  if (attendanceDay.status === TODAY_STATUSES.OUT || DAYS_OFF.includes(attendanceDay.status)) {
    return PRESENCE_DISPLAY_STATUSES.OFF_WORK;
  }
  const shift = shiftOf(person, attendanceDay);
  if (shift && (now < shift.start || now >= shift.end)) return PRESENCE_DISPLAY_STATUSES.OFF_WORK;
  return PRESENCE_DISPLAY_STATUSES.OFFLINE;
}

/**
 * Who is available, away, offline, on leave or off work now.
 * @returns {Promise<{ scope: string, people: object[], counts: Record<string, number> }>}
 */
export async function getPresenceNow({ viewer, departmentId = null, now = new Date() }) {
  const { scope, filter } = await resolveTeamScope(viewer, { departmentId, forbidden: PRESENCE_FORBIDDEN });
  const roster = await loadTeamRoster({ filter, now });
  const [attendanceDays, presenceByUser] = await Promise.all([
    loadAttendanceDays({ ...roster, now }),
    loadCurrentPresence(roster.people.map((person) => person.userId)),
  ]);
  const people = roster.people.map((person) => {
    const presence = presenceByUser.get(person.userId);
    const attendanceDay = attendanceDays.get(person.employeeId);
    return {
      ...toPersonView(person),
      userId: person.userId,
      status: displayStatusOf(person, presence, attendanceDay, now),
      since: isoOrNull(presence.since),
      lastSeenAt: isoOrNull(presence.lastSeenAt),
      attendanceStatus: attendanceDay.status,
      workMode: attendanceDay.punch?.workMode ?? null,
    };
  });
  const counts = Object.fromEntries(Object.values(PRESENCE_DISPLAY_STATUSES).map((status) => [status, 0]));
  for (const person of people) counts[person.status] += 1;
  return { scope, people, counts };
}

/**
 * Everyone's numbers for one day: the date asked for, or each person's today (so far).
 * @returns {Promise<{ scope: string, date: string|null, source: 'detail'|'summary', people: object[] }>}
 */
export async function getDailyActivity({ viewer, date = null, departmentId = null, now = new Date() }) {
  const { scope, filter } = await resolveTeamScope(viewer, { departmentId, forbidden: PRESENCE_FORBIDDEN });
  const roster = await loadTeamRoster({ filter, now });
  if (date && date < (await oldestDetailedDate(roster.companyTimeZone, now))) {
    const summaries = await PresenceDaySummary.find({
      employeeId: { $in: roster.people.map((person) => person.employeeId) },
      date,
    }).lean();
    const summaryByEmployee = new Map(summaries.map((summary) => [summary.employeeId.toString(), summary]));
    const people = roster.people
      .filter((person) => summaryByEmployee.has(person.employeeId))
      .map((person) => toSummaryRow(person, summaryByEmployee.get(person.employeeId)));
    return { scope, date, source: 'summary', people };
  }
  const attendanceDays = await loadAttendanceDays({ ...roster, date, now });
  const presenceDays = await computePresenceDays({ ...roster, attendanceDays, now });
  const people = roster.people.map((person) => toDailyRow(person, presenceDays.get(person.employeeId), now));
  return { scope, date, source: 'detail', people };
}

/**
 * The signed-in employee's own days, newest first, from `from` to `to` (YYYY-MM-DD, inclusive).
 * @returns {Promise<object[]|null>} null without an employee profile
 */
export async function getOwnDailyActivity({ userId, from, to, now = new Date() }) {
  const roster = await loadTeamRoster({ filter: { ...CURRENT_EMPLOYEES, userId }, now });
  const [person] = roster.people;
  if (!person) return null;
  const detailedFrom = await oldestDetailedDate(roster.companyTimeZone, now);
  const ownRoster = { ...roster, people: [person] };
  const days = [];
  for (let date = to; date >= from; date = addDaysToCalendarDate(date, -1)) {
    if (date < detailedFrom) {
      const summary = await PresenceDaySummary.findOne({ employeeId: person.employeeId, date }).lean();
      if (summary) days.push(toSummaryRow(person, summary));
      continue;
    }
    const attendanceDays = await loadAttendanceDays({ ...ownRoster, date, now });
    const presenceDays = await computePresenceDays({ ...ownRoster, attendanceDays, now });
    days.push(toDailyRow(person, presenceDays.get(person.employeeId), now));
  }
  return days;
}

/**
 * Writes every current employee's totals for the day before, in their own time zone. Idempotent:
 * a day written again is replaced.
 * @returns {Promise<{ summariesWritten: number }>}
 */
export async function writeDailySummaries({ now = new Date() } = {}) {
  const roster = await loadTeamRoster({ filter: CURRENT_EMPLOYEES, now });
  const peopleByYesterday = new Map();
  for (const person of roster.people) {
    const yesterday = addDaysToCalendarDate(
      readOfficeLocalClock(now, timeZoneOf(person, roster.companyTimeZone)).calendarDate,
      -1,
    );
    peopleByYesterday.set(yesterday, [...(peopleByYesterday.get(yesterday) ?? []), person]);
  }

  let summariesWritten = 0;
  for (const [date, people] of peopleByYesterday) {
    const dayRoster = { ...roster, people };
    const attendanceDays = await loadAttendanceDays({ ...dayRoster, date, now });
    const presenceDays = await computePresenceDays({ ...dayRoster, attendanceDays, now });
    await PresenceDaySummary.bulkWrite(
      people.map((person) => {
        const { metrics, timeZone, attendanceDay } = presenceDays.get(person.employeeId);
        return {
          updateOne: {
            filter: { employeeId: person.employeeId, date },
            update: {
              $set: {
                ...metrics,
                timeZone,
                attendanceStatus: attendanceDay.status,
                workedMinutes: workedMinutesOf(attendanceDay.punch, now),
              },
              $setOnInsert: { employeeId: person.employeeId, userId: person.userId, date },
            },
            upsert: true,
          },
        };
      }),
    );
    summariesWritten += people.length;
  }
  return { summariesWritten };
}

/**
 * Deletes intervals that ended more than presence.detailRetentionDays ago, and daily totals older
 * than presence.summaryRetentionDays (company settings).
 * @returns {Promise<{ intervalsDeleted: number, summariesDeleted: number }>}
 */
export async function deleteExpiredPresence({ now = new Date() } = {}) {
  const { detailRetentionDays, summaryRetentionDays } = await loadPresenceSettings();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const oldestSummaryDate = new Date(now.getTime() - summaryRetentionDays * DAY_MS).toISOString().slice(0, 10);
  const [intervals, summaries] = await Promise.all([
    PresenceInterval.deleteMany({
      isOpen: false,
      endedAt: { $lt: new Date(now.getTime() - detailRetentionDays * DAY_MS) },
    }),
    PresenceDaySummary.deleteMany({ date: { $lt: oldestSummaryDate } }),
  ]);
  return { intervalsDeleted: intervals.deletedCount, summariesDeleted: summaries.deletedCount };
}
