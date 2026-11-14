/**
 * find_offboarding_employee: the NSK tool behind "Rahul is leaving" (RUN_OFFBOARDING). It finds the
 * person among everyone still employed, as the people lookup does (peopleTools.js findMatches: an
 * employee ID always wins, a name must match every word):
 *
 *   one match   who they are (name, ID, designation, department, status, joining date), whether
 *               offboarding has started for them, and the action cards to offer: Start offboarding
 *               package (unless it has started) and View profile first
 *   several     the candidates to pick from
 *   none        nothing
 *
 * No pay figures: those come with the preview, which the card opens. Audited by the controller like
 * the people tools (who was read, the fields shown).
 */

import { NSK_ACTION_KINDS } from '../../../constants/nskBot.js';
import { NSK_BOT_MESSAGES } from '../../../constants/messages.js';
import { NSK_BOT_SETTINGS } from '../../../constants/validation.js';
import OffboardingCase, { EXECUTED_STATUSES } from '../../../models/OffboardingCase.js';
import User from '../../../models/User.js';
import { calendarDateOfUtcInstant } from '../../../utils/calendarDates.js';
import { PEOPLE_SCOPES } from '../nskAccess.js';
import { candidatesOf, departmentNames, findMatches } from '../peopleTools.js';

const LABELS = NSK_BOT_MESSAGES.SOURCE_LABELS;
const FIELDS_SHOWN = Object.freeze([
  'name',
  'employee_code',
  'designation',
  'department',
  'employment_status',
  'joining_date',
  'offboarding',
]);

/**
 * @param {{ query: string }} request
 * @returns {Promise<{ result: object, source: string|null, audit: object }>}
 */
export async function findOffboardingEmployee({ query }) {
  const matches = await findMatches({ kind: PEOPLE_SCOPES.ORGANISATION }, query);
  if (matches.length === 0) {
    return {
      result: { matches: 0 },
      source: null,
      audit: { query, matches: 0, targetEmployeeIds: [], fieldsShown: [] },
    };
  }
  if (matches.length > 1) {
    const candidates = await candidatesOf(matches);
    return {
      result: {
        matches: matches.length,
        candidates: candidates.slice(0, NSK_BOT_SETTINGS.LOOKUP_CANDIDATES_MAX),
        more_not_shown: Math.max(candidates.length - NSK_BOT_SETTINGS.LOOKUP_CANDIDATES_MAX, 0),
      },
      source: LABELS.PEOPLE_SEARCH(query),
      audit: {
        query,
        matches: matches.length,
        targetEmployeeIds: matches
          .slice(0, NSK_BOT_SETTINGS.LOOKUP_CANDIDATES_MAX)
          .map((profile) => profile._id.toString()),
        fieldsShown: ['name', 'employee_code', 'designation', 'department'],
      },
    };
  }
  const [profile] = matches;
  const [user, departments, openCase] = await Promise.all([
    User.findById(profile.userId).select('name').lean(),
    departmentNames([profile.organizationData.departmentId]),
    OffboardingCase.findOne({ employeeId: profile._id, isActive: true })
      .select('status separation.lastWorkingDay')
      .lean(),
  ]);
  const started = openCase !== null && EXECUTED_STATUSES.includes(openCase.status);
  const employeeId = profile._id.toString();
  const actions = [
    ...(started ? [] : [{ kind: NSK_ACTION_KINDS.START_OFFBOARDING, employee_id: employeeId }]),
    { kind: NSK_ACTION_KINDS.VIEW_PROFILE, employee_id: employeeId },
  ];
  const name = user?.name ?? profile.employeeCode;
  return {
    result: {
      matches: 1,
      employee: {
        employee_id: employeeId,
        employee_code: profile.employeeCode,
        name,
        designation: profile.organizationData.designation,
        department: departments.get(profile.organizationData.departmentId?.toString())?.name ?? null,
        employment_status: profile.organizationData.employmentStatus,
        joining_date: calendarDateOfUtcInstant(profile.organizationData.dateOfJoining),
        offboarding: openCase
          ? { case_status: openCase.status, last_working_day: openCase.separation?.lastWorkingDay ?? null }
          : null,
      },
      ...(started ? { note: NSK_BOT_MESSAGES.OFFBOARDING_ALREADY_STARTED_NOTE } : {}),
      actions,
    },
    source: LABELS.EMPLOYEE_PROFILE(name, profile.employeeCode),
    audit: { query, matches: 1, targetEmployeeIds: [employeeId], fieldsShown: [...FIELDS_SHOWN] },
  };
}
