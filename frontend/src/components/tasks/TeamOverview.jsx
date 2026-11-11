/**
 * The leads' team overview on a department board (GET /tasks/metrics; the backend refuses anyone who
 * is not a lead, and the board shows this tab only to leads):
 *
 *   Showing        a sprint (the active one first), the backlog, or all the department's work
 *   Sprint progress  for a sprint: points done, days gone, whether it is on pace, and its burndown
 *   Workload       each person's tasks by status and their story points; tasks nobody owns; people
 *                  who left the department keep their row, so no work goes missing
 *   Unassigned backlog  open backlog tasks without an owner, most urgent first; each opens the task
 */

import { useState } from 'react';
import { requestTeamWork } from '../../api/tasksApi.js';
import { BACKLOG, BOARD_COLUMNS, SPRINT_STATUSES } from '../../constants/tasks.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { PACE, sprintPace } from '../../utils/sprintProgress.js';
import { Badge, Card, LoadingBlock, Notice, ProgressBar, SelectInput, StatTile } from '../ui.jsx';
import BurndownChart from './BurndownChart.jsx';
import { PersonBadge, PriorityBadge, TaskTypeBadge } from './taskDisplay.jsx';

const ALL_WORK = '';
const PACE_DISPLAY = Object.freeze({
  [PACE.NOT_STARTED]: { label: 'Not started yet', tone: 'slate', hint: 'The sprint’s first day is still ahead' },
  [PACE.ON_TRACK]: { label: 'On track', tone: 'emerald', hint: 'Open points are at or under the ideal line' },
  [PACE.BEHIND]: { label: 'Behind', tone: 'amber', hint: 'More points are open than the ideal line' },
  [PACE.DONE]: { label: 'All points done', tone: 'emerald', hint: 'Every planned point is done' },
});
const SPRINT_ORDER = [SPRINT_STATUSES.ACTIVE, SPRINT_STATUSES.PLANNING, SPRINT_STATUSES.COMPLETED];
const percent = (share) => Math.round(share * 100);

function scopeOptions(sprints) {
  const ordered = [...sprints].sort(
    (first, second) => SPRINT_ORDER.indexOf(first.status) - SPRINT_ORDER.indexOf(second.status),
  );
  return [
    ...ordered.map((sprint) => ({ value: sprint.id, label: `${sprint.name} (${sprint.status.toLowerCase()})` })),
    { value: BACKLOG, label: 'Backlog' },
    { value: ALL_WORK, label: 'All work' },
  ];
}

function SprintProgress({ sprint }) {
  const progress = sprintPace(sprint);
  const display = PACE_DISPLAY[progress.pace];
  return (
    <Card title="Sprint progress" subtitle={sprint.goal || sprint.name}>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Points done"
            value={`${progress.pointsDone} of ${sprint.burndown.totalPoints}`}
            hint={`${percent(progress.pointsDoneShare)}% of the sprint's points`}
            accent="emerald"
          />
          <StatTile
            label="Days gone"
            value={`${progress.daysGone} of ${progress.sprintLength}`}
            hint={`${percent(progress.daysGoneShare)}% of the sprint`}
            accent="sky"
          />
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Pace</p>
            <p className="mt-2">
              <Badge tone={display.tone}>{display.label}</Badge>
            </p>
            <p className="mt-1 text-xs text-slate-500">{display.hint}</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-600">Work done</p>
            <ProgressBar value={percent(progress.pointsDoneShare)} tone="emerald" label="Work done" />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-600">Time gone</p>
            <ProgressBar value={percent(progress.daysGoneShare)} tone="brand" label="Time gone" />
          </div>
        </div>
        <BurndownChart sprint={sprint} />
      </div>
    </Card>
  );
}

function WorkloadTable({ members, unassigned, totals }) {
  const cell = 'px-3 py-2.5 text-right tabular-nums';
  const row = (key, who, work) => (
    <tr key={key}>
      <th scope="row" className="px-3 py-2.5 text-left font-normal">
        {who}
      </th>
      {BOARD_COLUMNS.map((column) => (
        <td key={column.status} className={cell}>
          {work.tasksByStatus[column.status]}
        </td>
      ))}
      <td className={cell}>
        {work.pointsDone} / {work.points}
      </td>
    </tr>
  );
  const person = (entry) => (
    <span className="flex items-center gap-2.5">
      <PersonBadge person={entry.person} />
      <span className="text-sm text-slate-800">
        {entry.person.name ?? 'Former member'}
        {entry.isFormer && <span className="ml-1.5 text-xs text-slate-500">(left the department)</span>}
      </span>
    </span>
  );
  return (
    <Card title="Workload" subtitle="Tasks by status, and story points done of planned" bodyClassName="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="border-b border-slate-100 text-xs text-slate-500">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Person
            </th>
            {BOARD_COLUMNS.map((column) => (
              <th key={column.status} scope="col" className="px-3 py-2 text-right font-medium">
                {column.label}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Story points
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-slate-700">
          {members.map((entry) => row(entry.person.id, person(entry), entry))}
          {row(
            'unassigned',
            <span className="flex items-center gap-2.5">
              <PersonBadge person={null} />
              <span className="text-sm text-slate-600">Unassigned</span>
            </span>,
            unassigned,
          )}
        </tbody>
        <tfoot className="border-t border-slate-200 font-semibold text-slate-900">
          {row('total', <span className="text-sm">Total</span>, totals)}
        </tfoot>
      </table>
    </Card>
  );
}

function UnassignedBacklog({ backlog, onOpenTask }) {
  if (backlog.total === 0) {
    return (
      <Card title="Unassigned backlog">
        <p className="text-sm text-slate-500">Every open backlog task has an owner.</p>
      </Card>
    );
  }
  const more = backlog.total - backlog.tasks.length;
  return (
    <Card title="Unassigned backlog" subtitle="Open backlog tasks nobody owns, the most urgent first">
      <div className="space-y-3">
        <Notice
          tone="warning"
          title={`${backlog.total} backlog ${backlog.total === 1 ? 'task has' : 'tasks have'} no owner`}
        />
        <ul aria-label="Unassigned backlog tasks" className="divide-y divide-slate-100">
          {backlog.tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-center gap-2 py-2">
              <button
                type="button"
                onClick={() => onOpenTask(task)}
                className="min-w-0 flex-1 truncate text-left text-sm text-slate-800 hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
              >
                <span className="mr-2 font-mono text-xs text-slate-500">{task.key}</span>
                {task.title}
              </button>
              <TaskTypeBadge taskType={task.taskType} />
              <PriorityBadge priority={task.priority} />
            </li>
          ))}
        </ul>
        {more > 0 && <p className="text-xs text-slate-500">and {more} more in the backlog</p>}
      </div>
    </Card>
  );
}

/** `revision` changes when the board's tasks do, so the numbers follow changes made on the board. */
export default function TeamOverview({ departmentId, board, sprints, revision, onOpenTask }) {
  const activeSprint = sprints.find((sprint) => sprint.status === SPRINT_STATUSES.ACTIVE) ?? null;
  const [scope, setScope] = useState(activeSprint?.id ?? ALL_WORK);
  const teamWork = useApiResource(
    (signal) => requestTeamWork(departmentId, scope || null, signal),
    [departmentId, scope, revision],
  );
  const work = teamWork.data;
  const formerIds = new Set(
    (work?.members ?? [])
      .map((entry) => entry.person.id)
      .filter((id) => !board.members.some((member) => member.id === id)),
  );
  const leads = [...(board.head ? [board.head] : []), ...board.leads.filter((lead) => lead.id !== board.head?.id)];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SelectInput
          label="Showing"
          value={scope}
          onChange={(changeEvent) => setScope(changeEvent.target.value)}
          options={scopeOptions(sprints)}
          className="w-full sm:w-72"
        />
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">Task leads:</span>{' '}
          {leads.length ? leads.map((lead) => lead.name).join(', ') : 'none yet'}
        </p>
      </div>
      {teamWork.error && <Notice tone="error" title={teamWork.error.message} />}
      {teamWork.isLoading && !work && <LoadingBlock label="Loading the team's work…" />}
      {work && (
        <>
          {work.sprint && <SprintProgress sprint={work.sprint} />}
          <WorkloadTable
            members={work.members.map((entry) => ({ ...entry, isFormer: formerIds.has(entry.person.id) }))}
            unassigned={work.unassigned}
            totals={work.totals}
          />
          <UnassignedBacklog backlog={work.unassignedBacklog} onOpenTask={onOpenTask} />
        </>
      )}
    </div>
  );
}
