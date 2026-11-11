/**
 * A task on the board: title, type and priority, key, story points and assignee. Clicking (or Enter
 * on) the card opens the task; when the viewer may move it, it can be dragged. Dropping another task
 * on a card puts that task just above it, when the drop is allowed there.
 */

import { PersonBadge, PriorityBadge, TaskTypeBadge } from './taskDisplay.jsx';

export default function TaskCard({ task, canDrag, isDragging, onOpen, onDragStart, onDragEnd, dropHandlers }) {
  return (
    <li
      draggable={canDrag}
      onDragStart={(dragEvent) => onDragStart(dragEvent, task)}
      onDragEnd={onDragEnd}
      {...dropHandlers}
      aria-label={`${task.key} ${task.title}`}
      className={`rounded-xl bg-white shadow-sm ring-1 ring-slate-200 transition ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''} ${isDragging ? 'opacity-40' : ''}`}
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
