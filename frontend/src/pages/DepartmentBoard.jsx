/**
 * A department's task board (/boards/:departmentId), for its people:
 *
 *   Active sprint   the active sprint's tasks in four columns, dragged between them by whoever may
 *                   move them (components/tasks/KanbanBoard.jsx); without an active sprint, the way to
 *                   the backlog
 *   Backlog         sprints being planned with their tasks, then the backlog; leads plan, start and
 *                   complete sprints and move tasks into them (components/tasks/BacklogPanel.jsx)
 *   Filters         assignee (everyone, me, unassigned), status and type, on both views
 *
 * "Create task" opens the create dialog; any task opens its detail (?task=<id>, which is where
 * the backend's assignment notifications link). The view is kept in the address (?view=backlog).
 * A move is shown at once and sent; when the backend refuses it, the task goes back and the
 * backend's reason is shown.
 */

import { useId, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { requestBoard, requestSprints, requestTaskUpdate, requestTasks } from '../api/tasksApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { ArrowLeftIcon, PlusIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import BacklogPanel from '../components/tasks/BacklogPanel.jsx';
import KanbanBoard from '../components/tasks/KanbanBoard.jsx';
import { CreateTaskDialog, SprintDialog, TaskDetailDialog } from '../components/tasks/TaskDialogs.jsx';
import { Badge, Button, EmptyState, LoadingBlock, Notice, Tabs, formatDate } from '../components/ui.jsx';
import { ROUTE_PATHS } from '../constants/routes.js';
import { ASSIGNEE_FILTERS, BOARD_COLUMNS, SPRINT_STATUSES, TASK_TYPE_OPTIONS } from '../constants/tasks.js';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';

const VIEWS = Object.freeze([
  { id: 'sprint', label: 'Active sprint' },
  { id: 'backlog', label: 'Backlog' },
]);
const ALL = '';
const STALE_VERSION = 'STALE_VERSION';

function FilterBar({ filters, onChange }) {
  const idPrefix = useId();
  const select = (label, field, options) => (
    <div className="flex items-center gap-2 text-sm text-slate-600">
      <label htmlFor={`${idPrefix}-${field}`} className="font-medium">
        {label}
      </label>
      <select
        id={`${idPrefix}-${field}`}
        value={filters[field]}
        onChange={(changeEvent) => onChange({ ...filters, [field]: changeEvent.target.value })}
        className="rounded-lg border-0 bg-white py-1.5 pr-8 pl-3 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <div
      role="group"
      aria-label="Filters"
      className="flex flex-wrap items-center gap-4 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200"
    >
      {select('Assignee', 'assignee', [
        { value: ASSIGNEE_FILTERS.ALL, label: 'Everyone' },
        { value: ASSIGNEE_FILTERS.ME, label: 'Me' },
        { value: ASSIGNEE_FILTERS.UNASSIGNED, label: 'Unassigned' },
      ])}
      {select('Status', 'status', [
        { value: ALL, label: 'Any' },
        ...BOARD_COLUMNS.map((column) => ({ value: column.status, label: column.label })),
      ])}
      {select('Type', 'taskType', [{ value: ALL, label: 'Any' }, ...TASK_TYPE_OPTIONS])}
    </div>
  );
}

function matches(task, filters, currentUserId) {
  if (filters.assignee === ASSIGNEE_FILTERS.ME && task.assignee?.id !== currentUserId) return false;
  if (filters.assignee === ASSIGNEE_FILTERS.UNASSIGNED && task.assignee) return false;
  if (filters.status && task.status !== filters.status) return false;
  if (filters.taskType && task.taskType !== filters.taskType) return false;
  return true;
}

export default function DepartmentBoard() {
  const { departmentId } = useParams();
  const { currentUser, csrfToken } = useAuth();
  const [searchParameters, setSearchParameters] = useSearchParams();
  const view = searchParameters.get('view') === 'backlog' ? 'backlog' : 'sprint';
  const openTaskId = searchParameters.get('task');

  const boardResource = useApiResource((signal) => requestBoard(departmentId, signal), [departmentId]);
  const sprintsResource = useApiResource((signal) => requestSprints(departmentId, signal), [departmentId]);
  const tasksResource = useApiResource((signal) => requestTasks(departmentId, {}, signal), [departmentId]);
  const [filters, setFilters] = useState({ assignee: ASSIGNEE_FILTERS.ALL, status: ALL, taskType: ALL });
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
  const [moveError, setMoveError] = useState(null);

  const board = boardResource.data?.board ?? null;
  const sprints = useMemo(() => sprintsResource.data?.sprints ?? [], [sprintsResource.data]);
  const allTasks = useMemo(() => tasksResource.data?.tasks ?? [], [tasksResource.data]);
  const activeSprint = sprints.find((sprint) => sprint.status === SPRINT_STATUSES.ACTIVE) ?? null;
  const plannableSprints = sprints.filter((sprint) => sprint.status !== SPRINT_STATUSES.COMPLETED);
  const visibleTasks = allTasks
    .filter((task) => matches(task, filters, currentUser.id))
    .sort((first, second) => first.orderIndex - second.orderIndex);

  function setParameter(name, value) {
    const next = new URLSearchParams(searchParameters);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParameters(next, { replace: name === 'view' });
  }

  function replaceTask(task) {
    tasksResource.setData((current) => ({
      tasks: (current?.tasks ?? []).some((existing) => existing.id === task.id)
        ? current.tasks.map((existing) => (existing.id === task.id ? task : existing))
        : [...(current?.tasks ?? []), task],
    }));
  }

  function reloadAll() {
    boardResource.reload();
    sprintsResource.reload();
    tasksResource.reload();
  }

  async function moveTask(task, { status, orderIndex }) {
    setMoveError(null);
    const changes = { orderIndex, ...(status !== task.status ? { status } : {}) };
    replaceTask({ ...task, status, orderIndex });
    try {
      const result = await requestTaskUpdate(departmentId, task.id, { ...changes, version: task.version }, csrfToken);
      replaceTask(result.task);
    } catch (updateError) {
      replaceTask(task);
      setMoveError(toDisplayError(updateError));
      if (updateError?.code === STALE_VERSION) tasksResource.reload();
    }
  }

  const backLink = (
    <Link
      to={ROUTE_PATHS.BOARDS}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      All boards
    </Link>
  );

  if (boardResource.isLoading && !board) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
        {backLink}
        <LoadingBlock label="Loading the board…" />
      </div>
    );
  }
  if (!board) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
        {backLink}
        <Notice tone="error" title={boardResource.error?.message} />
      </div>
    );
  }

  const sprintTasks = activeSprint ? visibleTasks.filter((task) => task.sprintId === activeSprint.id) : [];
  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
      {backLink}
      <PageHeader
        title={`${board.department.name} board`}
        description={
          activeSprint
            ? `${activeSprint.name} · ${formatDate(activeSprint.startDate)} – ${formatDate(activeSprint.endDate)}${activeSprint.goal ? ` · ${activeSprint.goal}` : ''}`
            : 'No sprint is active'
        }
        actions={
          <div className="flex items-center gap-2">
            {board.viewer.role === 'LEAD' && <Badge tone="violet">Task lead</Badge>}
            <Button onClick={() => setDialog({ kind: 'create' })}>
              <PlusIcon className="h-4 w-4" />
              Create task
            </Button>
          </div>
        }
      />
      {notice && <Notice tone="success" title={notice} onDismiss={() => setNotice(null)} />}
      {moveError && <Notice tone="error" title={moveError.message} onDismiss={() => setMoveError(null)} />}
      {(tasksResource.error || sprintsResource.error) && (
        <Notice tone="error" title={(tasksResource.error ?? sprintsResource.error).message} />
      )}
      <Tabs
        tabs={VIEWS}
        activeTabId={view}
        onChange={(nextView) => setParameter('view', nextView === 'sprint' ? null : nextView)}
        label="Board views"
      />
      <FilterBar filters={filters} onChange={setFilters} />

      {view === 'sprint' &&
        (activeSprint ? (
          <KanbanBoard
            tasks={sprintTasks}
            viewer={board.viewer}
            currentUserId={currentUser.id}
            onOpen={(task) => setParameter('task', task.id)}
            onMove={moveTask}
          />
        ) : (
          <EmptyState
            title="No sprint is active"
            description={
              board.viewer.canPlanSprints
                ? 'Plan a sprint in the backlog, move tasks into it, and start it.'
                : 'When a task lead starts a sprint, its tasks appear here.'
            }
            action={
              <Button variant="secondary" onClick={() => setParameter('view', 'backlog')}>
                Go to the backlog
              </Button>
            }
          />
        ))}
      {view === 'backlog' && (
        <BacklogPanel
          departmentId={departmentId}
          board={board}
          sprints={sprints}
          tasks={visibleTasks}
          onOpen={(task) => setParameter('task', task.id)}
          onTaskChanged={(task) => {
            replaceTask(task);
            sprintsResource.reload();
          }}
          onSprintsChanged={(message) => {
            setNotice(message ?? null);
            reloadAll();
          }}
          onPlanSprint={() => setDialog({ kind: 'sprint' })}
        />
      )}

      {dialog?.kind === 'create' && (
        <CreateTaskDialog
          departmentId={departmentId}
          board={board}
          plannableSprints={plannableSprints}
          defaultSprintId={view === 'sprint' ? (activeSprint?.id ?? null) : null}
          onClose={() => setDialog(null)}
          onCreated={(task, message) => {
            setDialog(null);
            setNotice(message ?? null);
            replaceTask(task);
            sprintsResource.reload();
          }}
        />
      )}
      {dialog?.kind === 'sprint' && (
        <SprintDialog
          departmentId={departmentId}
          onClose={() => setDialog(null)}
          onCreated={(sprint, message) => {
            setDialog(null);
            setNotice(message ?? null);
            sprintsResource.reload();
          }}
        />
      )}
      {openTaskId && (
        <TaskDetailDialog
          departmentId={departmentId}
          taskId={openTaskId}
          board={board}
          sprints={sprints}
          currentUserId={currentUser.id}
          onChanged={(task) => {
            replaceTask(task);
            sprintsResource.reload();
          }}
          onClose={() => setParameter('task', null)}
        />
      )}
    </div>
  );
}
