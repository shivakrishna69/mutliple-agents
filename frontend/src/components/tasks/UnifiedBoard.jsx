/**
 * A department's work on one screen: the backlog on the left, the active sprint's four columns to its
 * right (To do, In progress, In review, Done), separated by dividers.
 *
 *   Backlog column   a quick "add a task" field (title only; it goes to the backlog), the unplanned
 *                    tasks, then each sprint being planned as a section that folds away; leads start
 *                    a planned sprint from its section
 *   Status columns   the active sprint's tasks; without an active sprint they say so
 *
 * Dragging (utils/taskBoard.js decides where a task may go, the backend decides again):
 *   backlog or planned sprint → To do    into the active sprint (leads, or the task's assignee)
 *   between status columns               a new status (Done only from In review, by a lead or the
 *                                        reporter); within a column, a new order
 *   → the backlog or a planned sprint    leads only
 * A target that would refuse the task does not light up and does not take the drop. Without a mouse,
 * a card opens the task, where its status and sprint can be chosen.
 */

import { useId, useRef, useState } from 'react';
import { requestTaskCreation } from '../../api/tasksApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { BOARD_COLUMNS, SPRINT_STATUSES, TASK_LIMITS, TASK_STATUSES } from '../../constants/tasks.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { canDragTask, canDropTask, orderFor, taskRightsOf } from '../../utils/taskBoard.js';
import { ChevronDownIcon } from '../Icons.jsx';
import { Button, formatDate } from '../ui.jsx';
import TaskCard from './TaskCard.jsx';

const DRAG_TYPE = 'application/x-nsk-task';
const BACKLOG_TARGET = Object.freeze({ key: 'backlog', sprintId: null });

function QuickAdd({ departmentId, onCreated }) {
  const { csrfToken } = useAuth();
  const inputId = useId();
  const [title, setTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  async function submit(submitEvent) {
    submitEvent.preventDefault();
    if (!title.trim()) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await requestTaskCreation(departmentId, { title: title.trim() }, csrfToken);
      setTitle('');
      onCreated(result.task, result.notice);
    } catch (createError) {
      setSaveError(toDisplayError(createError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="sr-only" htmlFor={inputId}>
        Add a task to the backlog
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          value={title}
          onChange={(changeEvent) => setTitle(changeEvent.target.value)}
          maxLength={TASK_LIMITS.TITLE}
          placeholder="Add a task…"
          className="min-w-0 flex-1 rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500"
        />
        <Button type="submit" size="sm" isBusy={isSaving} disabled={!title.trim()}>
          Add
        </Button>
      </div>
      {saveError && <p className="text-xs text-rose-600">{saveError.message}</p>}
    </form>
  );
}

export default function UnifiedBoard({
  departmentId,
  board,
  sprints,
  tasks,
  activeSprint,
  currentUserId,
  busySprintId,
  onOpen,
  onMove,
  onStartSprint,
  onCreated,
}) {
  const activeSprintId = activeSprint?.id ?? null;
  // The ref answers drag-over at once (the first events come before React re-renders); the state
  // dims the dragged card.
  const draggedRef = useRef(null);
  const [dragged, setDragged] = useState(null);
  const [hoverKey, setHoverKey] = useState(null);
  const [folded, setFolded] = useState(() => new Set());
  const rightsOf = (task) => taskRightsOf(task, board.viewer, currentUserId, activeSprintId);
  const planningSprints = sprints.filter((sprint) => sprint.status === SPRINT_STATUSES.PLANNING);
  const sprintColumnTasks = (status) =>
    activeSprintId ? tasks.filter((task) => task.sprintId === activeSprintId && task.status === status) : [];

  // Every drop target by key; elements name theirs in data-drop-target (cards also data-before-task).
  const targetsByKey = Object.fromEntries([
    [BACKLOG_TARGET.key, BACKLOG_TARGET],
    ...planningSprints.map((sprint) => [sprint.id, { key: sprint.id, sprintId: sprint.id }]),
    ...BOARD_COLUMNS.map((column) => [column.status, { key: column.status, status: column.status }]),
  ]);

  const allows = (target) => {
    const task = draggedRef.current;
    return Boolean(task && target) && canDropTask(task, target, rightsOf(task), activeSprintId);
  };

  function startDrag(dragEvent, task) {
    dragEvent.dataTransfer.setData(DRAG_TYPE, task.id);
    dragEvent.dataTransfer.effectAllowed = 'move';
    draggedRef.current = task;
    setDragged(task);
  }

  function endDrag() {
    draggedRef.current = null;
    setDragged(null);
    setHoverKey(null);
  }

  function drop(target, beforeTask) {
    const task = draggedRef.current;
    endDrag();
    if (!task || beforeTask?.id === task.id || !canDropTask(task, target, rightsOf(task), activeSprintId)) return;
    if (target.status === undefined) {
      onMove(task, { sprintId: target.sprintId });
      return;
    }
    const columnTasks = sprintColumnTasks(target.status).filter((candidate) => candidate.id !== task.id);
    onMove(task, {
      ...(task.sprintId !== activeSprintId ? { sprintId: activeSprintId } : {}),
      status: target.status,
      orderIndex: orderFor(columnTasks, beforeTask),
    });
  }

  // A target takes the drag (and lights up) only when the drop is allowed there.
  function handleDragOver(dragEvent) {
    const target = targetsByKey[dragEvent.currentTarget.dataset.dropTarget];
    if (!allows(target)) return;
    dragEvent.preventDefault();
    dragEvent.stopPropagation();
    setHoverKey(target.key);
  }

  function handleDragLeave(dragEvent) {
    const key = dragEvent.currentTarget.dataset.dropTarget;
    setHoverKey((current) => (current === key ? null : current));
  }

  function handleDrop(dragEvent) {
    dragEvent.preventDefault();
    dragEvent.stopPropagation();
    const { dropTarget, beforeTask } = dragEvent.currentTarget.dataset;
    drop(targetsByKey[dropTarget], tasks.find((task) => task.id === beforeTask) ?? null);
  }

  const dropProps = (key, beforeTaskId) => ({
    'data-drop-target': key,
    'data-before-task': beforeTaskId,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  });
  const highlight = (key) => (hoverKey === key ? 'bg-brand-50 ring-2 ring-brand-300 ring-inset' : '');

  const card = (task, targetKey) => (
    <TaskCard
      key={task.id}
      task={task}
      canDrag={canDragTask(task, rightsOf(task), activeSprintId)}
      isDragging={dragged?.id === task.id}
      onOpen={onOpen}
      onDragStart={startDrag}
      onDragEnd={endDrag}
      dropHandlers={targetKey ? dropProps(targetKey, task.id) : {}}
    />
  );
  const backlog = tasks.filter((task) => task.sprintId === null);

  return (
    <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 scroll-thin">
      <div className="grid min-w-[56rem] grid-cols-[16rem_repeat(4,minmax(10rem,1fr))] divide-x divide-slate-200">
        {/* --- Backlog and planned sprints ---------------------------------------------------- */}
        <div className="flex max-h-[calc(100vh-14rem)] min-h-[28rem] flex-col bg-slate-50/70">
          <div className="space-y-3 border-b border-slate-200 p-3">
            <h3 className="flex items-center justify-between px-1 text-xs font-semibold tracking-wide text-slate-600 uppercase">
              Backlog
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-200">
                {backlog.length}
              </span>
            </h3>
            <QuickAdd departmentId={departmentId} onCreated={onCreated} />
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3 scroll-thin">
            <section
              aria-label="Backlog"
              {...dropProps(BACKLOG_TARGET.key)}
              className={`min-h-16 rounded-xl p-1 transition ${highlight(BACKLOG_TARGET.key)}`}
            >
              {backlog.length === 0 ? (
                <p className="px-2 py-3 text-sm text-slate-500">No unplanned tasks.</p>
              ) : (
                <ul className="flex flex-col gap-2">{backlog.map((task) => card(task, null))}</ul>
              )}
            </section>
            {planningSprints.map((sprint) => {
              const sprintTasks = tasks.filter((task) => task.sprintId === sprint.id);
              const points = sprintTasks.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0);
              const isOpen = !folded.has(sprint.id);
              return (
                <section
                  key={sprint.id}
                  aria-label={sprint.name}
                  {...dropProps(sprint.id)}
                  className={`rounded-xl bg-white ring-1 ring-slate-200 transition ${highlight(sprint.id)}`}
                >
                  <header className="flex items-start justify-between gap-2 px-3 py-2.5">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setFolded((current) => {
                          const next = new Set(current);
                          if (next.has(sprint.id)) next.delete(sprint.id);
                          else next.add(sprint.id);
                          return next;
                        })
                      }
                      className="flex min-w-0 flex-1 items-start gap-1.5 text-left focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
                    >
                      <ChevronDownIcon
                        className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition ${isOpen ? '' : '-rotate-90'}`}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">{sprint.name}</span>
                        <span className="block text-xs text-slate-500">
                          Planning · {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)} ·{' '}
                          {sprintTasks.length} tasks · {points} pts
                        </span>
                      </span>
                    </button>
                    {board.viewer.canPlanSprints && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onStartSprint(sprint)}
                        isBusy={busySprintId === sprint.id}
                        disabled={Boolean(activeSprint)}
                        title={activeSprint ? 'Complete the active sprint first' : undefined}
                      >
                        Start sprint
                      </Button>
                    )}
                  </header>
                  {isOpen && (
                    <div className="px-2 pb-2">
                      {sprintTasks.length === 0 ? (
                        <p className="px-2 py-2 text-xs text-slate-500">No tasks planned yet.</p>
                      ) : (
                        <ul className="flex flex-col gap-2">{sprintTasks.map((task) => card(task, null))}</ul>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>

        {/* --- The active sprint's columns ---------------------------------------------------- */}
        {BOARD_COLUMNS.map((column) => {
          const columnTasks = sprintColumnTasks(column.status);
          return (
            <section
              key={column.status}
              aria-label={column.label}
              {...dropProps(column.status)}
              className={`flex max-h-[calc(100vh-14rem)] min-h-[28rem] flex-col transition ${highlight(column.status)}`}
            >
              <h3 className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                {column.label}
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                  {columnTasks.length}
                </span>
              </h3>
              <div className="flex-1 overflow-y-auto p-3 scroll-thin">
                {!activeSprint && column.status === TASK_STATUSES.TODO ? (
                  <p className="px-1 text-sm text-slate-500">
                    No sprint is active.{' '}
                    {board.viewer.canPlanSprints
                      ? 'Plan one, add tasks to it, and start it.'
                      : 'When a task lead starts a sprint, its tasks appear here.'}
                  </p>
                ) : (
                  <ul className="flex min-h-full flex-col gap-2">
                    {columnTasks.map((task) => card(task, column.status))}
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
