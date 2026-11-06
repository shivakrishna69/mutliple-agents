/**
 * GET /api/dashboard/overview: everything the dashboard shows for one viewer, in sections. Each
 * section is built only for the roles allowed to see it, so a viewer never receives another
 * role's data (an absent section is null):
 *
 *   people    HR and administrators       services/dashboardPeople.js
 *   support   administrators and agents   services/dashboardSupport.js
 *   accounts  administrators              accounts per role, and how many are new this week
 *   me        anyone with an employee profile   services/dashboardSelf.js
 *
 * The range (today, 7 or 30 days) is in the company's time zone (services/dashboardRange.js).
 */

import { DASHBOARD_RANGE_LABELS } from '../constants/messages.js';
import { DASHBOARD_SETTINGS } from '../constants/validation.js';
import User, { ACCOUNT_STATUSES, ROLES } from '../models/User.js';
import { getCompanySettings } from './companySettings.js';
import { isStaffRole } from './conversationAccess.js';
import { loadPeopleSummary } from './dashboardPeople.js';
import { resolveDashboardRange } from './dashboardRange.js';
import { loadSelfSummary } from './dashboardSelf.js';
import { loadSupportSummary } from './dashboardSupport.js';
import { isWorkforceAdmin } from './workforceAccess.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Accounts per role (signed-up and active ones; invitations not yet accepted are not counted). */
async function loadAccountSummary(now) {
  const countable = { status: { $in: [ACCOUNT_STATUSES.ACTIVE, ACCOUNT_STATUSES.UNVERIFIED] } };
  const byRole = await User.aggregate([{ $match: countable }, { $group: { _id: '$role', count: { $sum: 1 } } }]);
  const perRole = Object.fromEntries(Object.values(ROLES).map((role) => [role, 0]));
  for (const { _id: role, count } of byRole) perRole[role] = count;
  const newThisWeek = await User.countDocuments({
    ...countable,
    createdAt: { $gte: new Date(now.getTime() - DASHBOARD_SETTINGS.NEW_ACCOUNTS_DAYS * DAY_MS), $lte: now },
  });
  return {
    total: Object.values(perRole).reduce((sum, count) => sum + count, 0),
    perRole,
    newThisWeek,
    unverified: await User.countDocuments({ status: ACCOUNT_STATUSES.UNVERIFIED }),
  };
}

/**
 * @param {{ viewer: { id: string, role: string }, rangeKey: string, now?: Date }} request
 */
export async function buildDashboardOverview({ viewer, rangeKey, now = new Date() }) {
  const { timeZone } = await getCompanySettings();
  const range = resolveDashboardRange(rangeKey, timeZone, now);
  const isAdmin = viewer.role === ROLES.ADMIN;
  const [people, support, accounts, me] = await Promise.all([
    isWorkforceAdmin(viewer.role) ? loadPeopleSummary({ viewer, range, now }) : null,
    isStaffRole(viewer.role) ? loadSupportSummary({ viewer, range }) : null,
    isAdmin ? loadAccountSummary(now) : null,
    loadSelfSummary({ viewer, now }),
  ]);
  return {
    range: {
      key: range.key,
      label: DASHBOARD_RANGE_LABELS[range.key],
      timeZone,
      firstDate: range.firstDate,
      lastDate: range.lastDate,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    ranges: Object.values(DASHBOARD_SETTINGS.RANGES).map((key) => ({ key, label: DASHBOARD_RANGE_LABELS[key] })),
    generatedAt: now.toISOString(),
    people,
    support,
    accounts,
    me,
  };
}
