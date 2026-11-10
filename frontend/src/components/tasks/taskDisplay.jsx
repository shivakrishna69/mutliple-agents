/**
 * Small pieces every task board view shares: the type and priority badges and a person's initials.
 */

import { PRIORITY_OPTIONS, TASK_TYPE_OPTIONS } from '../../constants/tasks.js';
import { initialsOf } from '../../utils/dashboardFormat.js';
import { Badge } from '../ui.jsx';

const optionOf = (options, value) =>
  options.find((option) => option.value === value) ?? { label: value, tone: 'slate' };

export function TaskTypeBadge({ taskType }) {
  const option = optionOf(TASK_TYPE_OPTIONS, taskType);
  return <Badge tone={option.tone}>{option.label}</Badge>;
}

export function PriorityBadge({ priority }) {
  const option = optionOf(PRIORITY_OPTIONS, priority);
  return <Badge tone={option.tone}>{option.label}</Badge>;
}

/** A person's initials in a circle, with their name for screen readers and on hover. */
export function PersonBadge({ person, emptyLabel = 'Unassigned' }) {
  if (!person) {
    return (
      <span
        className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-slate-300 text-[10px] text-slate-400"
        title={emptyLabel}
      >
        <span aria-hidden="true">—</span>
        <span className="sr-only">{emptyLabel}</span>
      </span>
    );
  }
  return (
    <span
      className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-[11px] font-bold text-brand-700"
      title={person.name ?? ''}
    >
      <span aria-hidden="true">{initialsOf(person.name ?? '?')}</span>
      <span className="sr-only">{person.name}</span>
    </span>
  );
}
