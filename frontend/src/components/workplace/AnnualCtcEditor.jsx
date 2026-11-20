/**
 * An employee's annual CTC on the Workplace employee list (MANAGE_COMPENSATION): shown, and changed
 * in place (PUT /api/employees/:employeeId/compensation). People hired through an offer get it from
 * the offer; anyone else needs it set here, for example to count for the Form 16 portal. Messages are
 * the backend's.
 */

import { useState } from 'react';
import { requestEmployeeCompensationChange } from '../../api/workplaceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { Button, Notice, formatInr } from '../ui.jsx';

const INPUT_CLASS =
  'w-36 rounded-lg border-0 py-1.5 px-3 text-sm tabular-nums ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-500';

export default function AnnualCtcEditor({ employee, compensation, onSaved }) {
  const { csrfToken } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [problem, setProblem] = useState(null);
  const annualCtc = compensation?.annualCtc ?? null;

  function startEditing() {
    setAmountText(annualCtc === null ? '' : String(annualCtc));
    setEffectiveFrom('');
    setProblem(null);
    setIsEditing(true);
  }

  async function save() {
    setIsSaving(true);
    setProblem(null);
    try {
      const amount = Number(amountText);
      const result = await requestEmployeeCompensationChange(
        employee.employeeId,
        {
          annualCtc: Number.isFinite(amount) && amountText.trim() !== '' ? amount : amountText,
          effectiveFrom: effectiveFrom || null,
        },
        csrfToken,
      );
      onSaved(result.compensation);
      setIsEditing(false);
    } catch (saveError) {
      setProblem(toDisplayError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  if (!isEditing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-600">
          CTC{' '}
          <span className="font-semibold text-slate-900 tabular-nums">
            {annualCtc === null ? '—' : formatInr(annualCtc)}
          </span>
        </span>
        <Button variant="ghost" size="sm" onClick={startEditing} aria-label={`Edit annual CTC of ${employee.name}`}>
          Edit
        </Button>
      </div>
    );
  }

  return (
    <form
      className="w-full space-y-2 sm:w-auto"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          value={amountText}
          onChange={(changeEvent) => setAmountText(changeEvent.target.value)}
          aria-label={`Annual CTC of ${employee.name}, in rupees`}
          className={INPUT_CLASS}
          autoFocus
        />
        <input
          type="date"
          value={effectiveFrom}
          onChange={(changeEvent) => setEffectiveFrom(changeEvent.target.value)}
          aria-label="Effective from"
          className={INPUT_CLASS}
        />
        <Button type="submit" size="sm" isBusy={isSaving}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} disabled={isSaving}>
          Cancel
        </Button>
      </div>
      {problem && (
        <Notice tone="error" title={problem.message}>
          {Object.values(problem.fieldErrors ?? {}).join('. ') || null}
        </Notice>
      )}
    </form>
  );
}
