/**
 * What the leads' team overview shows beside each person's work (taskService.getTeamWork):
 *
 *   burndownSeries({ startDate, endDate, today, tasks })   pure: the story points still open at the end
 *                                                          of each sprint day so far
 *   sprintBurndown(sprint, now)                            that series for a sprint, its days read in
 *                                                          the company's time zone
 *   unassignedBacklog(department)                          the backlog's open tasks nobody is assigned
 *                                                          to, most urgent and then oldest first
 */

import { TASK_SETTINGS } from '../../constants/validation.js';
import Task, { TASK_PRIORITIES, TASK_STATUSES } from '../../models/Task.js';
import { listCalendarDates } from '../../utils/calendarDates.js';
import { readOfficeLocalClock } from '../attendancePolicy.js';
import { getCompanySettings } from '../companySettings.js';

const PRIORITY_RANK = Object.values(TASK_PRIORITIES);

/**
 * Remaining points on day d = every task's points − the points of tasks done on or before d. A task
 * done before the sprint starts counts on its first day. Days after `today` are not reported (the
 * future is not known); a sprint not started yet has no days.
 * @param {{ startDate: string, endDate: string, today: string,
 *           tasks: { storyPoints: number|null, doneDate: string|null }[] }} input
 * @returns {{ totalPoints: number, days: { date: string, remainingPoints: number }[] }}
 */
export function burndownSeries({ startDate, endDate, today, tasks }) {
  const totalPoints = tasks.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0);
  const lastDay = today < endDate ? today : endDate;
  const days = listCalendarDates(startDate, lastDay).map((date) => ({
    date,
    remainingPoints:
      totalPoints -
      tasks
        .filter((task) => task.doneDate && task.doneDate <= date)
        .reduce((sum, task) => sum + (task.storyPoints ?? 0), 0),
  }));
  return { totalPoints, days };
}

/** @param {{ _id: object, departmentId: object, startDate: string, endDate: string }} sprint */
export async function sprintBurndown(sprint, now = new Date()) {
  const { timeZone } = await getCompanySettings();
  const tasks = await Task.find({ departmentId: sprint.departmentId, sprintId: sprint._id })
    .select('storyPoints status doneAt')
    .lean();
  const today = readOfficeLocalClock(now, timeZone).calendarDate;
  return {
    today,
    ...burndownSeries({
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      today,
      tasks: tasks.map((task) => ({
        storyPoints: task.storyPoints ?? null,
        doneDate:
          task.status === TASK_STATUSES.DONE && task.doneAt
            ? readOfficeLocalClock(task.doneAt, timeZone).calendarDate
            : null,
      })),
    }),
  };
}

/** @returns {Promise<{ total: number, tasks: object[] }>}  tasks: lean, without descriptions */
export async function unassignedBacklog(department) {
  const filter = {
    departmentId: department._id,
    sprintId: null,
    assigneeId: null,
    status: { $ne: TASK_STATUSES.DONE },
  };
  const [total, tasks] = await Promise.all([
    Task.countDocuments(filter),
    Task.aggregate([
      { $match: filter },
      { $addFields: { priorityRank: { $indexOfArray: [PRIORITY_RANK, '$priority'] } } },
      { $sort: { priorityRank: -1, createdAt: 1, _id: 1 } },
      { $limit: TASK_SETTINGS.UNASSIGNED_BACKLOG_LISTED },
      { $project: { description: 0, priorityRank: 0 } },
    ]),
  ]);
  return { total, tasks };
}
