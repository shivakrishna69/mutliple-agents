/**
 * A department's board as a whole: who is on it, who leads it, and what the viewer may do.
 *
 *   getBoardSummary(scope)              the department, the viewer's role and rights, the task leads,
 *                                       the people tasks can be assigned to, and the active sprint
 *   setTaskLeads(scope, ...)            the department's head (or an administrator) names its task
 *                                       leads: people in the department
 */

import { HTTP_STATUS } from '../../constants/httpStatus.js';
import Sprint, { SPRINT_STATUSES } from '../../models/Sprint.js';
import User from '../../models/User.js';
import { assertCurrentVersion, saveVersioned } from '../serviceError.js';
import { BOARD_ROLES, boardRefusal } from './boardAccess.js';
import { toSprintSummary } from './sprintService.js';

export async function peopleByIds(userIds) {
  const ids = [...new Set([...userIds].filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } })
    .select('name email')
    .lean();
  return new Map(
    users.map((user) => [user._id.toString(), { id: user._id.toString(), name: user.name, email: user.email }]),
  );
}

export async function getBoardSummary(scope) {
  const { department, board, role, isHead, isAdmin, memberUserIds, headUserId } = scope;
  const leadIds = board.leadUserIds.map(String).filter((leadId) => memberUserIds.has(leadId));
  const people = await peopleByIds([...memberUserIds]);
  const activeSprint = await Sprint.findOne({ departmentId: department._id, status: SPRINT_STATUSES.ACTIVE }).lean();
  const isLead = role === BOARD_ROLES.LEAD;
  return {
    department: { id: department._id.toString(), name: department.name, code: department.code },
    viewer: {
      role,
      isHead,
      canPlanSprints: isLead,
      canMoveAnyTask: isLead,
      canSeeTeamWork: isLead,
      canChooseLeads: isHead || isAdmin,
    },
    head: headUserId ? (people.get(headUserId) ?? null) : null,
    leads: leadIds.map((leadId) => people.get(leadId)).filter(Boolean),
    members: [...people.values()].sort((first, second) => first.name.localeCompare(second.name)),
    activeSprint: activeSprint ? toSprintSummary(activeSprint) : null,
    version: board.__v,
  };
}

/** @param {{ leadUserIds: string[], version: number }} input */
export async function setTaskLeads(scope, { leadUserIds, version }) {
  const { board, isHead, isAdmin, memberUserIds } = scope;
  if (!isHead && !isAdmin) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'HEAD_ONLY');
  if (leadUserIds.some((leadId) => !memberUserIds.has(leadId))) {
    throw boardRefusal(HTTP_STATUS.UNPROCESSABLE_CONTENT, 'LEAD_NOT_A_MEMBER');
  }
  assertCurrentVersion(board, version);
  board.leadUserIds = [...new Set(leadUserIds)];
  await saveVersioned(board);
  return getBoardSummary({ ...scope, board });
}
