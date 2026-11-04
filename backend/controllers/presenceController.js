/**
 * Presence endpoints (routes/presenceRoutes.js, mounted at /api/presence). Everyone signed in uses
 * their own; team views follow services/teamRoster.js.
 */

import { PRESENCE_MESSAGES } from '../constants/messages.js';
import { ServiceError } from '../services/serviceError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { readOfficeLocalClock } from '../services/attendancePolicy.js';
import { getCompanySettings } from '../services/companySettings.js';
import { getDailyActivity, getOwnDailyActivity, getPresenceNow } from '../services/presenceActivity.js';
import { acknowledgePresenceNotice, getOwnPresenceSetup } from '../services/presenceSettings.js';
import { addDaysToCalendarDate, daysBetweenCalendarDates, isRealCalendarDate } from '../utils/calendarDates.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

/** The longest stretch of own days asked for at once, and the default (the last week). */
const OWN_DAYS_MAX = 31;
const OWN_DAYS_DEFAULT = 7;

const presenceHandler = createWorkforceHandlerFactory({
  auditCategory: 'presence',
  restrictedMessage: PRESENCE_MESSAGES.FORBIDDEN,
  inputInvalidMessage: PRESENCE_MESSAGES.QUERY_INVALID,
});

const ANYONE_READ = Object.freeze({ requiresWorkforceAdmin: false, isWrite: false });
const ANYONE_WRITE = Object.freeze({ requiresWorkforceAdmin: false, isWrite: true });

/** Validation errors for the optional ?date and ?departmentId of team views. */
function teamQueryErrors({ date, departmentId }) {
  const validationErrors = [];
  if (date !== undefined && !isRealCalendarDate(date)) {
    validationErrors.push({ field: 'date', message: 'must be a real date written YYYY-MM-DD' });
  }
  if (departmentId !== undefined && !isValidObjectIdString(departmentId)) {
    validationErrors.push({ field: 'departmentId', message: 'must be a department id' });
  }
  return validationErrors;
}

/** GET /api/presence/me : whether my activity is recorded, after how long I show Away, the notice. */
export const getOwnPresence = presenceHandler('view_own_presence_setup', ANYONE_READ, async (req) => ({
  message: PRESENCE_MESSAGES.SETUP_RETRIEVED,
  data: { presence: await getOwnPresenceSetup(req.user.id) },
}));

/** POST /api/presence/notice : { version } of the notice I read. Audited: it is a consent record. */
export const postNoticeAcknowledgement = presenceHandler('acknowledge_presence_notice', ANYONE_WRITE, async (req) => {
  const version = req.body?.version;
  if (!Number.isInteger(version)) {
    return { validationErrors: [{ field: 'version', message: PRESENCE_MESSAGES.NOTICE_VERSION_INVALID }] };
  }
  const presence = await acknowledgePresenceNotice({ userId: req.user.id, version });
  return {
    message: PRESENCE_MESSAGES.NOTICE_ACKNOWLEDGED,
    data: { presence },
    auditDetails: { noticeVersion: version },
  };
});

/** GET /api/presence/now?departmentId= : who is available, away, offline, on leave or off work */
export const getNow = presenceHandler('view_presence', ANYONE_READ, async (req) => {
  const validationErrors = teamQueryErrors({ departmentId: req.query.departmentId });
  if (validationErrors.length > 0) return { validationErrors };
  return {
    message: PRESENCE_MESSAGES.NOW_RETRIEVED,
    data: await getPresenceNow({ viewer: req.user, departmentId: req.query.departmentId ?? null }),
  };
});

/** GET /api/presence/daily?date=&departmentId= : everyone's numbers for a day (default: today so far) */
export const getDaily = presenceHandler('view_daily_activity', ANYONE_READ, async (req) => {
  const validationErrors = teamQueryErrors(req.query);
  if (validationErrors.length > 0) return { validationErrors };
  return {
    message: PRESENCE_MESSAGES.DAILY_RETRIEVED,
    data: await getDailyActivity({
      viewer: req.user,
      date: req.query.date ?? null,
      departmentId: req.query.departmentId ?? null,
    }),
  };
});

/** GET /api/presence/me/daily?from=&to= : my own days (default: the last week; at most 31) */
export const getOwnDaily = presenceHandler('view_own_daily_activity', ANYONE_READ, async (req) => {
  const { from, to } = req.query;
  const validationErrors = [];
  for (const [field, value] of Object.entries({ from, to })) {
    if (value !== undefined && !isRealCalendarDate(value)) {
      validationErrors.push({ field, message: 'must be a real date written YYYY-MM-DD' });
    }
  }
  if (validationErrors.length > 0) return { validationErrors };
  const today = readOfficeLocalClock(new Date(), (await getCompanySettings()).timeZone).calendarDate;
  const lastDate = to ?? today;
  const firstDate = from ?? addDaysToCalendarDate(lastDate, -(OWN_DAYS_DEFAULT - 1));
  if (firstDate > lastDate || daysBetweenCalendarDates(firstDate, lastDate) >= OWN_DAYS_MAX) {
    return {
      validationErrors: [{ field: 'from', message: `must be on or before "to", at most ${OWN_DAYS_MAX} days` }],
    };
  }
  const days = await getOwnDailyActivity({ userId: req.user.id, from: firstDate, to: lastDate });
  if (!days) throw new ServiceError(HTTP_STATUS.NOT_FOUND, 'PROFILE_NOT_FOUND', PRESENCE_MESSAGES.PROFILE_NOT_FOUND);
  return { message: PRESENCE_MESSAGES.DAILY_RETRIEVED, data: { from: firstDate, to: lastDate, days } };
});
