/**
 * The department head (or an administrator) chooses the task leads: people in the department who
 * then plan sprints, move any task and see the team overview. The head always leads and is not in the
 * list. Saving sends the board version it was based on; the backend decides again (only the head or
 * an administrator, only people in the department) and its reason is shown when it refuses.
 */

import { useState } from 'react';
import { requestTaskLeadsUpdate } from '../../api/tasksApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { TASK_LIMITS } from '../../constants/tasks.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import Dialog from '../Dialog.jsx';
import { Button, Notice } from '../ui.jsx';
import { PersonBadge } from './taskDisplay.jsx';

export default function TaskLeadsDialog({ departmentId, board, onSaved, onClose }) {
  const { csrfToken } = useAuth();
  const headId = board.head?.id ?? null;
  const candidates = board.members.filter((member) => member.id !== headId);
  const [chosen, setChosen] = useState(() => new Set(board.leads.map((lead) => lead.id).filter((id) => id !== headId)));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const atLimit = chosen.size >= TASK_LIMITS.LEADS;

  function toggle(memberId) {
    const next = new Set(chosen);
    if (next.has(memberId)) next.delete(memberId);
    else next.add(memberId);
    setChosen(next);
  }

  async function submit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await requestTaskLeadsUpdate(departmentId, [...chosen], board.version, csrfToken);
      onSaved(result.board, result.notice);
    } catch (saveFailure) {
      setSaveError(toDisplayError(saveFailure));
      setIsSaving(false);
    }
  }

  return (
    <Dialog title="Task leads" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Task leads plan and run sprints, move any task, and see the team overview.
          {board.head ? ` ${board.head.name}, the department head, always leads.` : ''}
        </p>
        {saveError && <Notice tone="error" title={saveError.message} />}
        {candidates.length === 0 ? (
          <p className="text-sm text-slate-500">Nobody else is in this department yet.</p>
        ) : (
          <fieldset>
            <legend className="sr-only">People in the department</legend>
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl ring-1 ring-slate-200">
              {candidates.map((member) => {
                const isChosen = chosen.has(member.id);
                return (
                  <li key={member.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={isChosen}
                        disabled={!isChosen && atLimit}
                        onChange={() => toggle(member.id)}
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <PersonBadge person={member} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-800">{member.name}</span>
                        <span className="block truncate text-xs text-slate-500">{member.email}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {atLimit && (
              <p className="mt-2 text-xs text-slate-500">
                A department can have at most {TASK_LIMITS.LEADS} task leads.
              </p>
            )}
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving} disabled={candidates.length === 0}>
            Save task leads
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
