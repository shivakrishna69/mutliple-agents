/**
 * A department's sprints. Everyone on the board sees them; only its leads create and change them.
 *
 *   listSprints(scope)              newest first, each with its task counts by status and points
 *   createSprint(scope, ...)        in PLANNING
 *   updateSprint(scope, ...)        name, goal, dates; and the status, forward only:
 *                                   PLANNING -> ACTIVE (when no other sprint is active)
 *                                   ACTIVE -> COMPLETED (its unfinished tasks go back to the backlog)
 */

import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { TASK_SETTINGS } from '../../constants/validation.js';
import Sprint, { SPRINT_STATUSES } from '../../models/Sprint.js';
import Task, { TASK_STATUSES } from '../../models/Task.js';
import { assertCurrentVersion, saveVersioned } from '../serviceError.js';
import { boardRefusal, requireLead } from './boardAccess.js';

const NEXT_STATUS = Object.freeze({
  [SPRINT_STATUSES.PLANNING]: SPRINT_STATUSES.ACTIVE,
  [SPRINT_STATUSES.ACTIVE]: SPRINT_STATUSES.COMPLETED,
});

export function toSprintSummary(sprint, progress = null) {
  return {
    id: sprint._id.toString(),
    name: sprint.name,
    goal: sprint.goal ?? '',
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    status: sprint.status,
    startedAt: sprint.startedAt ?? null,
    completedAt: sprint.completedAt ?? null,
    ...(progress ? { progress } : {}),
    version: sprint.__v,
  };
}

/** Task counts by status, and story points planned and done, per sprint id. */
async function progressBySprint(departmentId, sprintIds) {
  const rows = await Task.aggregate([
    { $match: { departmentId, sprintId: { $in: sprintIds } } },
    {
      $group: {
        _id: { sprintId: '$sprintId', status: '$status' },
        count: { $sum: 1 },
        points: { $sum: { $ifNull: ['$storyPoints', 0] } },
      },
    },
  ]);
  const progress = new Map();
  for (const { _id, count, points } of rows) {
    const key = _id.sprintId.toString();
    const entry = progress.get(key) ?? {
      tasksByStatus: Object.fromEntries(Object.values(TASK_STATUSES).map((status) => [status, 0])),
      points: 0,
      pointsDone: 0,
    };
    entry.tasksByStatus[_id.status] = count;
    entry.points += points;
    if (_id.status === TASK_STATUSES.DONE) entry.pointsDone += points;
    progress.set(key, entry);
  }
  return progress;
}

export async function listSprints({ department }) {
  const sprints = await Sprint.find({ departmentId: department._id })
    .sort({ startDate: -1, createdAt: -1 })
    .limit(TASK_SETTINGS.SPRINTS_LISTED)
    .lean();
  const progress = await progressBySprint(
    department._id,
    sprints.map((sprint) => sprint._id),
  );
  const empty = {
    tasksByStatus: Object.fromEntries(Object.values(TASK_STATUSES).map((status) => [status, 0])),
    points: 0,
    pointsDone: 0,
  };
  return sprints.map((sprint) => toSprintSummary(sprint, progress.get(sprint._id.toString()) ?? empty));
}

/** @param {{ name: string, goal: string, startDate: string, endDate: string }} input */
export async function createSprint(scope, input, actorUserId) {
  requireLead(scope);
  const sprint = await Sprint.create({ departmentId: scope.department._id, ...input, createdBy: actorUserId });
  return toSprintSummary(sprint.toObject());
}

/** The sprint, looked up within the department. */
export async function findSprint(department, sprintId, { lean = false } = {}) {
  const query = Sprint.findOne({ _id: sprintId, departmentId: department._id });
  const sprint = lean ? await query.lean() : await query;
  if (!sprint) throw boardRefusal(HTTP_STATUS.NOT_FOUND, 'SPRINT_NOT_FOUND');
  return sprint;
}

/** @param {{ changes: object, version: number }} input */
export async function updateSprint(scope, sprintId, { changes, version }) {
  requireLead(scope);
  const sprint = await findSprint(scope.department, sprintId);
  assertCurrentVersion(sprint, version);
  const { status: nextStatus, ...fields } = changes;
  if (sprint.status === SPRINT_STATUSES.COMPLETED) throw boardRefusal(HTTP_STATUS.CONFLICT, 'SPRINT_COMPLETED');
  sprint.set(fields);

  let completing = false;
  if (nextStatus !== undefined && nextStatus !== sprint.status) {
    if (NEXT_STATUS[sprint.status] !== nextStatus) {
      throw boardRefusal(HTTP_STATUS.CONFLICT, 'SPRINT_TRANSITION_NOT_ALLOWED');
    }
    sprint.status = nextStatus;
    if (nextStatus === SPRINT_STATUSES.ACTIVE) sprint.startedAt = new Date();
    if (nextStatus === SPRINT_STATUSES.COMPLETED) {
      sprint.completedAt = new Date();
      completing = true;
    }
  }
  // The one-active-sprint index refuses a second active sprint, even one started at the same time.
  await saveVersioned(sprint, { onDuplicateKey: () => boardRefusal(HTTP_STATUS.CONFLICT, 'SPRINT_ALREADY_ACTIVE') });
  if (completing) {
    await Task.updateMany(
      { departmentId: scope.department._id, sprintId: sprint._id, status: { $ne: TASK_STATUSES.DONE } },
      { $set: { sprintId: null }, $inc: { __v: 1 } },
    );
  }
  const progress = await progressBySprint(scope.department._id, [sprint._id]);
  return toSprintSummary(sprint.toObject(), progress.get(sprint._id.toString()) ?? null);
}
