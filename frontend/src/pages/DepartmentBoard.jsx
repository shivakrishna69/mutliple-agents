/**
 * A department's task board (/boards/:departmentId), for its people:
 *
 *   Board           everything on one screen (components/tasks/UnifiedBoard.jsx): the backlog with
 *                   quick add and the sprints being planned on the left, the active sprint's four
 *                   columns on the right; tasks are dragged between them as the viewer's rights allow
 *   Team overview   leads only (?view=team): each person's workload, a sprint's progress and
 *                   burndown, the unassigned backlog (components/tasks/TeamOverview.jsx)
 *   Filters         assignee (everyone, me, unassigned), status and type, on the board
 *
 * The header shows the active sprint (name, dates, goal, days left) with the leads' Plan sprint and
 * Complete sprint; the head (or an administrator) chooses the task leads there (TaskLeadsDialog).
 * Tabs and buttons follow the viewer's rights from the backend, which decides again on every request.
 *
 * "Create task" opens the create dialog; any task opens its detail (?task=<id>, which is where
 * the backend's assignment notifications link). A move is shown at once and sent; when the backend
 * refuses it, the task goes back and the backend's reason is shown.
 */

import { useId, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { requestBoard, requestSprints, requestTaskUpdate, requestTasks } from '../api/tasksApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { ArrowLeftIcon, PlusIcon, UsersIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { CreateTaskDialog, SprintDialog, TaskDetailDialog } from '../components/tasks/TaskDialogs.jsx';
import TaskLeadsDialog from '../components/tasks/TaskLeadsDialog.jsx';
import TeamOverview from '../components/tasks/TeamOverview.jsx';
import UnifiedBoard from '../components/tasks/UnifiedBoard.jsx';
import { Badge, Button, LoadingBlock, Notice, Tabs, formatDate } from '../components/ui.jsx';
import { ROUTE_PATHS } from '../constants/routes.js';
import { ASSIGNEE_FILTERS, BOARD_COLUMNS, SPRINT_STATUSES, TASK_TYPE_OPTIONS } from '../constants/tasks.js';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';
import { useSprintTransition } from '../hooks/useSprintTransition.js';
import { localToday } from '../utils/dates.js';
import { sprintDates } from '../utils/sprintProgress.js';

const VIEWS = Object.freeze([
  { id: 'board', label: 'Board' },
  { id: 'team', label: 'Team overview', isVisibleTo: (viewer) => viewer.canSeeTeamWork },
]);
const DEFAULT_VIEW = 'board';
/** "Sprint 1 · 9 Nov 2026 – 20 Nov 2026 · 9 days left · Ship login", or that no sprint is active. */
function sprintLine(sprint) {
  if (!sprint) return 'No sprint is active';
  const daysLeft = sprintDates(localToday(), sprint.endDate).length;
  const left = daysLeft === 0 ? 'past its end date' : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`;
  return [sprint.name, `${formatDate(sprint.startDate)} – ${formatDate(sprint.endDate)}`, left, sprint.goal]
    .filter(Boolean)
    .join(' · ');
}
const viewsFor = (viewer) => VIEWS.filter((candidate) => !candidate.isVisibleTo || candidate.isVisibleTo(viewer));
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
  const openTaskId = searchParameters.get('task');

  const boardResource = useApiResource((signal) => requestBoard(departmentId, signal), [departmentId]);
  const sprintsResource = useApiResource((signal) => requestSprints(departmentId, signal), [departmentId]);
  const tasksResource = useApiResource((signal) => requestTasks(departmentId, {}, signal), [departmentId]);
  const [filters, setFilters] = useState({ assignee: ASSIGNEE_FILTERS.ALL, status: ALL, taskType: ALL });
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
  const [moveError, setMoveError] = useState(null);
  const sprintTransition = useSprintTransition(departmentId, {
    onDone: (message) => {
      setNotice(message ?? null);
      reloadAll();
    },
    onError: setMoveError,
  });

  const board = boardResource.data?.board ?? null;
  const views = board ? viewsFor(board.viewer) : [];
  const requestedView = searchParameters.get('view');
  const view = views.some((candidate) => candidate.id === requestedView) ? requestedView : DEFAULT_VIEW;
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

  /** @param {{ status?: string, sprintId?: string|null, orderIndex?: number }} move */
  async function moveTask(task, move) {
    setMoveError(null);
    const changes = { ...move };
    if (changes.status === task.status) delete changes.status;
    replaceTask({ ...task, ...move });
    try {
      const result = await requestTaskUpdate(departmentId, task.id, { ...changes, version: task.version }, csrfToken);
      replaceTask(result.task);
      if (changes.sprintId !== undefined) sprintsResource.reload();
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

  const canPlan = board.viewer.canPlanSprints;
  return (
    <div className="mx-auto max-w-screen-2xl space-y-6 px-4 py-8 sm:px-8">
      {backLink}
      <PageHeader
        title={`${board.department.name} board`}
        description={sprintLine(activeSprint)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {board.viewer.role === 'LEAD' && <Badge tone="violet">Task lead</Badge>}
            {board.viewer.canChooseLeads && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'leads' })}>
                <UsersIcon className="h-4 w-4" />
                Task leads
              </Button>
            )}
            {canPlan && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'sprint' })}>
                Plan sprint
              </Button>
            )}
            {canPlan && activeSprint && (
              <Button
                variant="secondary"
                onClick={() => sprintTransition.transition(activeSprint, SPRINT_STATUSES.COMPLETED)}
                isBusy={sprintTransition.busySprintId === activeSprint.id}
              >
                Complete sprint
              </Button>
            )}
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
        tabs={views}
        activeTabId={view}
        onChange={(nextView) => setParameter('view', nextView === DEFAULT_VIEW ? null : nextView)}
        label="Board views"
      />
      {view !== 'team' && <FilterBar filters={filters} onChange={setFilters} />}

      {view === 'board' && (
        <UnifiedBoard
          departmentId={departmentId}
          board={board}
          sprints={sprints}
          tasks={visibleTasks}
          activeSprint={activeSprint}
          currentUserId={currentUser.id}
          busySprintId={sprintTransition.busySprintId}
          onOpen={(task) => setParameter('task', task.id)}
          onMove={moveTask}
          onStartSprint={(sprint) => sprintTransition.transition(sprint, SPRINT_STATUSES.ACTIVE)}
          onCreated={(task, message) => {
            setNotice(message ?? null);
            replaceTask(task);
          }}
        />
      )}
      {view === 'team' && sprintsResource.data && (
        <TeamOverview
          departmentId={departmentId}
          board={board}
          sprints={sprints}
          revision={tasksResource.data}
          onOpenTask={(task) => setParameter('task', task.id)}
        />
      )}

      {dialog?.kind === 'leads' && (
        <TaskLeadsDialog
          departmentId={departmentId}
          board={board}
          onClose={() => setDialog(null)}
          onSaved={(savedBoard, message) => {
            setDialog(null);
            setNotice(message ?? null);
            boardResource.setData({ board: savedBoard });
          }}
        />
      )}
      {dialog?.kind === 'create' && (
        <CreateTaskDialog
          departmentId={departmentId}
          board={board}
          plannableSprints={plannableSprints}
          defaultSprintId={null}
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
