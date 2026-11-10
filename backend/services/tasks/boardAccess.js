/**
 * Who may use a department's task board, and how: one rule for every board endpoint
 * (middleware/departmentBoardScope.js).
 *
 *   member   someone whose employee record is in the department (not ended): sees the board, creates
 *            tasks, changes the tasks they reported or are assigned to, moves the tasks assigned to
 *            them, comments
 *   lead     the department's head, the task leads the head named (DepartmentBoard.leadUserIds, still
 *            in the department), and administrators (MANAGE_ALL_TASK_BOARDS): also plan sprints, move
 *            and change any task, and see the team's work
 *   anyone else   refused, HR included: a department's work is its own
 *
 * loadBoardScope(user, departmentId) → { department, board, role, isHead, isAdmin, memberUserIds },
 * creating the board the first time; memberUserIds are the accounts tasks may be assigned to (the
 * department's people and its head).
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';
import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { TASK_MESSAGES } from '../../constants/messages.js';
import Department from '../../models/Department.js';
import DepartmentBoard from '../../models/DepartmentBoard.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import User, { ACCOUNT_STATUSES } from '../../models/User.js';
import { isDuplicateKeyError } from '../../utils/mongoErrors.js';
import { ServiceError } from '../serviceError.js';

export const BOARD_ROLES = Object.freeze({ LEAD: 'LEAD', MEMBER: 'MEMBER' });

export const boardRefusal = (httpStatus, code) => new ServiceError(httpStatus, code, TASK_MESSAGES[code]);

/** The board of a department, created the first time. */
async function ensureBoard(departmentId) {
  const existing = await DepartmentBoard.findOne({ departmentId });
  if (existing) return existing;
  try {
    return await DepartmentBoard.create({ departmentId });
  } catch (createError) {
    if (!isDuplicateKeyError(createError)) throw createError;
    return DepartmentBoard.findOne({ departmentId });
  }
}

/** Active accounts of the department's people (records not ended), and of its head. */
async function loadMemberUserIds(department) {
  const profiles = await EmployeeProfile.find({
    'organizationData.departmentId': department._id,
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
  })
    .select('userId')
    .lean();
  const userIds = profiles.map((profile) => profile.userId).filter(Boolean);
  let headUserId = null;
  if (department.departmentHeadId) {
    const head = await EmployeeProfile.findById(department.departmentHeadId).select('userId').lean();
    headUserId = head?.userId?.toString() ?? null;
    if (headUserId) userIds.push(head.userId);
  }
  const active = await User.find({ _id: { $in: userIds }, status: ACCOUNT_STATUSES.ACTIVE })
    .select('_id')
    .lean();
  return { memberUserIds: new Set(active.map((account) => account._id.toString())), headUserId };
}

/**
 * @param {{ id: string, role: string }} user
 * @param {string} departmentId
 */
export async function loadBoardScope(user, departmentId) {
  if (
    !hasCapability(user.role, CAPABILITIES.USE_TASK_BOARDS) &&
    !hasCapability(user.role, CAPABILITIES.MANAGE_ALL_TASK_BOARDS)
  ) {
    throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'NOT_ALLOWED');
  }
  const department = await Department.findById(departmentId).lean();
  if (!department || department.isActive === false) throw boardRefusal(HTTP_STATUS.NOT_FOUND, 'DEPARTMENT_NOT_FOUND');
  const { memberUserIds, headUserId } = await loadMemberUserIds(department);
  const isAdmin = hasCapability(user.role, CAPABILITIES.MANAGE_ALL_TASK_BOARDS);
  const isMember = memberUserIds.has(user.id);
  if (!isAdmin && !isMember) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'NOT_A_MEMBER');

  const board = await ensureBoard(department._id);
  const isHead = headUserId === user.id;
  const isNamedLead = isMember && board.leadUserIds.some((leadId) => leadId.toString() === user.id);
  return {
    department,
    board,
    role: isAdmin || isHead || isNamedLead ? BOARD_ROLES.LEAD : BOARD_ROLES.MEMBER,
    isHead,
    isAdmin,
    memberUserIds,
    headUserId,
  };
}

export const isLead = (scope) => scope.role === BOARD_ROLES.LEAD;

export function requireLead(scope) {
  if (!isLead(scope)) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'LEADS_ONLY');
}
