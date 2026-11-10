/**
 * The active sprint as four columns (To do, In progress, In review, Done). Tasks the viewer may move
 * can be dragged to another column, or within one to change their order: dropping on a card puts the
 * task just above it, dropping on a column's empty space puts it at the bottom. The new order sits
 * between its neighbours (ORDER_GAP leaves room), so nothing else is renumbered.
 *
 * Without a mouse, a card opens the task, where its status can be chosen.
 */

import { useState } from 'react';
import { BOARD_COLUMNS } from '../../constants/tasks.js';
import { orderFor, taskRightsOf } from '../../utils/taskBoard.js';
import { PersonBadge, PriorityBadge, TaskTypeBadge } from './taskDisplay.jsx';

const DRAG_TYPE = 'application/x-nsk-task';

function TaskCard({ task, canMove, onOpen, onDragStart, onDropBefore, isDragging }) {
  return (
    <li
      draggable={canMove}
      onDragStart={(dragEvent) => onDragStart(dragEvent, task)}
      onDragOver={(dragEvent) => dragEvent.preventDefault()}
      onDrop={(dragEvent) => {
        dragEvent.preventDefault();
        dragEvent.stopPropagation();
        onDropBefore(task);
      }}
      aria-label={`${task.key} ${task.title}`}
      className={`rounded-xl bg-white shadow-sm ring-1 ring-slate-200 transition ${canMove ? 'cursor-grab active:cursor-grabbing' : ''} ${isDragging ? 'opacity-40' : ''}`}
    >
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="w-full p-3 text-left focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
      >
        <span className="block text-sm font-medium text-slate-900">{task.title}</span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          <TaskTypeBadge taskType={task.taskType} />
          <PriorityBadge priority={task.priority} />
        </span>
        <span className="mt-2 flex items-center justify-between">
          <span className="font-mono text-xs text-slate-500">{task.key}</span>
          <span className="flex items-center gap-2">
            {task.storyPoints !== null && (
              <span
                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600"
                title="Story points"
              >
                {task.storyPoints}
                <span className="sr-only"> story points</span>
              </span>
            )}
            <PersonBadge person={task.assignee} />
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * @param {{ tasks: object[], viewer: object, currentUserId: string, onOpen: (task) => void,
 *   onMove: (task, { status, orderIndex }) => void }} props
 */
export default function KanbanBoard({ tasks, viewer, currentUserId, onOpen, onMove }) {
  const [dragged, setDragged] = useState(null);
  const [hoverColumn, setHoverColumn] = useState(null);

  function startDrag(dragEvent, task) {
    dragEvent.dataTransfer.setData(DRAG_TYPE, task.id);
    dragEvent.dataTransfer.effectAllowed = 'move';
    setDragged(task);
  }

  function drop(status, beforeTask) {
    const task = dragged;
    setDragged(null);
    setHoverColumn(null);
    if (!task || beforeTask?.id === task.id) return;
    const columnTasks = tasks.filter((candidate) => candidate.status === status && candidate.id !== task.id);
    onMove(task, { status, orderIndex: orderFor(columnTasks, beforeTask) });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {BOARD_COLUMNS.map((column) => {
        const columnTasks = tasks.filter((task) => task.status === column.status);
        return (
          <section
            key={column.status}
            aria-label={column.label}
            onDragOver={(dragEvent) => {
              dragEvent.preventDefault();
              setHoverColumn(column.status);
            }}
            onDragLeave={() => setHoverColumn((current) => (current === column.status ? null : current))}
            onDrop={(dragEvent) => {
              dragEvent.preventDefault();
              drop(column.status, null);
            }}
            className={`flex min-h-48 flex-col rounded-2xl p-3 transition ${hoverColumn === column.status ? 'bg-brand-50 ring-2 ring-brand-300' : 'bg-slate-100/70'}`}
          >
            <h3 className="mb-3 flex items-center justify-between px-1 text-xs font-semibold tracking-wide text-slate-600 uppercase">
              {column.label}
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-200">
                {columnTasks.length}
              </span>
            </h3>
            <ul className="flex flex-1 flex-col gap-2">
              {columnTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  canMove={taskRightsOf(task, viewer, currentUserId).canMove}
                  isDragging={dragged?.id === task.id}
                  onOpen={onOpen}
                  onDragStart={startDrag}
                  onDropBefore={(beforeTask) => drop(column.status, beforeTask)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
