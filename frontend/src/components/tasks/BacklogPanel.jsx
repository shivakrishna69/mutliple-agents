/**
 * The backlog and sprint planning: the sprints being planned and the active one, each with its tasks,
 * then the backlog. Leads plan a sprint, start one (when none is active), complete the active one
 * (its unfinished tasks come back to the backlog), and move a task into or out of a sprint from its
 * row. Everyone opens a task from its row.
 */

import { useState } from 'react';
import { requestSprintUpdate, requestTaskUpdate } from '../../api/tasksApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { BACKLOG, SPRINT_STATUSES, SPRINT_STATUS_DISPLAY, STATUS_LABELS } from '../../constants/tasks.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { Badge, Button, EmptyState, Notice, formatDate } from '../ui.jsx';
import { DocumentIcon } from '../Icons.jsx';
import { PersonBadge, PriorityBadge, TaskTypeBadge } from './taskDisplay.jsx';

function TaskRow({ departmentId, task, plannableSprints, canPlan, onOpen, onChanged, onError }) {
  const { csrfToken } = useAuth();
  const [isMoving, setIsMoving] = useState(false);

  async function moveTo(sprintValue) {
    setIsMoving(true);
    try {
      const result = await requestTaskUpdate(
        departmentId,
        task.id,
        { sprintId: sprintValue === BACKLOG ? null : sprintValue, version: task.version },
        csrfToken,
      );
      onChanged(result.task);
    } catch (moveError) {
      onError(toDisplayError(moveError));
    } finally {
      setIsMoving(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="min-w-0 flex-1 text-left focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-slate-500">{task.key}</span>
          <span className="truncate text-sm font-medium text-slate-900">{task.title}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <TaskTypeBadge taskType={task.taskType} />
          <PriorityBadge priority={task.priority} />
          <Badge tone="slate">{STATUS_LABELS[task.status]}</Badge>
          {task.storyPoints !== null && <span className="text-xs text-slate-500">{task.storyPoints} pts</span>}
        </span>
      </button>
      <PersonBadge person={task.assignee} />
      {canPlan && (
        <label className="flex items-center gap-2 text-xs text-slate-500">
          <span className="sr-only">Sprint for {task.key}</span>
          <select
            value={task.sprintId ?? BACKLOG}
            disabled={isMoving}
            onChange={(changeEvent) => moveTo(changeEvent.target.value)}
            className="rounded-lg border-0 bg-white py-1.5 pr-8 pl-2 text-xs ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500"
          >
            <option value={BACKLOG}>Backlog</option>
            {plannableSprints.map((sprint) => (
              <option key={sprint.id} value={sprint.id}>
                {sprint.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </li>
  );
}

function SprintSection({ departmentId, sprint, tasks, canPlan, hasActiveSprint, onTransitioned, onError, children }) {
  const { csrfToken } = useAuth();
  const [isChanging, setIsChanging] = useState(false);
  const status = SPRINT_STATUS_DISPLAY[sprint.status];

  async function transition(nextStatus) {
    if (
      nextStatus === SPRINT_STATUSES.COMPLETED &&
      !window.confirm(`Complete ${sprint.name}? Its unfinished tasks go back to the backlog.`)
    ) {
      return;
    }
    setIsChanging(true);
    try {
      const result = await requestSprintUpdate(
        departmentId,
        sprint.id,
        { status: nextStatus, version: sprint.version },
        csrfToken,
      );
      onTransitioned(result.notice);
    } catch (transitionError) {
      onError(toDisplayError(transitionError));
    } finally {
      setIsChanging(false);
    }
  }

  const points = tasks.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0);
  return (
    <section aria-label={sprint.name} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-900">{sprint.name}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="text-xs text-slate-500">
            {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)} · {tasks.length} tasks · {points} points
            {sprint.goal && ` · ${sprint.goal}`}
          </p>
        </div>
        {canPlan && sprint.status === SPRINT_STATUSES.PLANNING && (
          <Button
            size="sm"
            onClick={() => transition(SPRINT_STATUSES.ACTIVE)}
            isBusy={isChanging}
            disabled={hasActiveSprint}
            title={hasActiveSprint ? 'Complete the active sprint first' : undefined}
          >
            Start sprint
          </Button>
        )}
        {canPlan && sprint.status === SPRINT_STATUSES.ACTIVE && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => transition(SPRINT_STATUSES.COMPLETED)}
            isBusy={isChanging}
          >
            Complete sprint
          </Button>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * @param {{ departmentId: string, board: object, sprints: object[], tasks: object[], onOpen: Function,
 *   onTaskChanged: Function, onSprintsChanged: (notice) => void, onPlanSprint: () => void }} props
 */
export default function BacklogPanel({
  departmentId,
  board,
  sprints,
  tasks,
  onOpen,
  onTaskChanged,
  onSprintsChanged,
  onPlanSprint,
}) {
  const [error, setError] = useState(null);
  const canPlan = board.viewer.canPlanSprints;
  const openSprints = sprints
    .filter((sprint) => sprint.status !== SPRINT_STATUSES.COMPLETED)
    .sort((first, second) =>
      first.status === SPRINT_STATUSES.ACTIVE ? -1 : second.status === SPRINT_STATUSES.ACTIVE ? 1 : 0,
    );
  const hasActiveSprint = openSprints.some((sprint) => sprint.status === SPRINT_STATUSES.ACTIVE);
  const backlog = tasks.filter((task) => task.sprintId === null);
  const rows = (rowTasks) =>
    rowTasks.length === 0 ? (
      <p className="px-4 py-4 text-sm text-slate-500">No tasks.</p>
    ) : (
      <ul className="divide-y divide-slate-100">
        {rowTasks.map((task) => (
          <TaskRow
            key={task.id}
            departmentId={departmentId}
            task={task}
            plannableSprints={openSprints}
            canPlan={canPlan}
            onOpen={onOpen}
            onChanged={onTaskChanged}
            onError={setError}
          />
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      {error && <Notice tone="error" title={error.message} onDismiss={() => setError(null)} />}
      {canPlan && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onPlanSprint}>
            Plan a sprint
          </Button>
        </div>
      )}
      {openSprints.map((sprint) => (
        <SprintSection
          key={sprint.id}
          departmentId={departmentId}
          sprint={sprint}
          tasks={tasks.filter((task) => task.sprintId === sprint.id)}
          canPlan={canPlan}
          hasActiveSprint={hasActiveSprint}
          onTransitioned={onSprintsChanged}
          onError={setError}
        >
          {rows(tasks.filter((task) => task.sprintId === sprint.id))}
        </SprintSection>
      ))}
      <section aria-label="Backlog" className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <header className="border-b border-slate-100 px-4 py-3">
          <p className="font-semibold text-slate-900">Backlog</p>
          <p className="text-xs text-slate-500">{backlog.length} tasks not planned into a sprint</p>
        </header>
        {backlog.length === 0 && openSprints.length === 0 ? (
          <div className="p-4">
            <EmptyState
              Icon={DocumentIcon}
              title="Nothing here yet"
              description="Create a task to start the backlog."
            />
          </div>
        ) : (
          rows(backlog)
        )}
      </section>
    </div>
  );
}
