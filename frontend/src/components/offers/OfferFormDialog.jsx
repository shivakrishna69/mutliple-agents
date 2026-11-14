/**
 * A new offer (POST /api/hr/onboarding/create-draft), saved for review; nothing reaches the
 * candidate from here.
 *
 *   Candidate   name, personal email, date of birth (it opens the final letter), gender
 *   Position    access role, designation, department, manager, joining date, work mode, status
 *   Pay         annual CTC, tax regime, work city (HRA rate), professional tax state, variable pay,
 *               stock options, and optionally Basic, HRA and special allowance: left empty, the
 *               company policy sets them; a split that cannot add up is refused by the backend,
 *               which names the special allowance it would be
 *   Terms       probation and notice (the company's unless changed) and the acceptance deadline
 *
 * "Work out figures" shows the structure (POST /calculate); "Preview letter" opens the letter as it
 * would be sent, watermarked; "Save for review" stores the draft. Every check and message is the
 * backend's.
 */

import { useMemo, useState } from 'react';
import { requestOfferCalculation, requestOfferDraftCreation } from '../../api/offersApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { toGroupedOptions } from '../../utils/groupedOptions.js';
import { emptyOfferForm, fieldErrorOf, offerRequestFromForm } from '../../utils/offers.js';
import Dialog from '../Dialog.jsx';
import { Button, Notice, SelectInput, TextInput } from '../ui.jsx';
import OfferPreviewDialog from './OfferPreviewDialog.jsx';
import StructureTable from './StructureTable.jsx';

function Section({ title, children }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

export default function OfferFormDialog({ options, settings, choices, onSaved, onClose }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState(() => emptyOfferForm(options, settings));
  const [busyAction, setBusyAction] = useState(null);
  const [problem, setProblem] = useState(null);
  const [structure, setStructure] = useState(null);
  const [preview, setPreview] = useState(null);
  const update = (field) => (changeEvent) => setForm({ ...form, [field]: changeEvent.target.value });
  const errorOf = (field) => fieldErrorOf(problem?.fieldErrors, field);
  const variablePercent = choices.limits.variablePayMaxBasisPoints / 100;

  const managerOptions = useMemo(
    () => [
      { value: '', label: 'No manager' },
      ...[...options.managers]
        .sort(
          (first, second) =>
            Number(second.departmentId === form.departmentId) - Number(first.departmentId === form.departmentId),
        )
        .map((manager) => ({ value: manager.employeeId, label: `${manager.name} · ${manager.designation}` })),
    ],
    [options.managers, form.departmentId],
  );

  async function run(action) {
    setBusyAction(action);
    setProblem(null);
    try {
      const request = offerRequestFromForm(form);
      if (action === 'save') {
        const result = await requestOfferDraftCreation(request, csrfToken);
        onSaved(result.draft, result.notice);
        return;
      }
      const result = await requestOfferCalculation({ ...request, includePreview: action === 'preview' }, csrfToken);
      setStructure(result.structure);
      if (action === 'preview' && result.preview) setPreview(result.preview);
    } catch (actionError) {
      setProblem(toDisplayError(actionError));
    } finally {
      setBusyAction(null);
    }
  }

  const input = (field, label, props = {}) => (
    <TextInput label={label} value={form[field]} onChange={update(field)} error={errorOf(field)} {...props} />
  );
  const select = (field, label, selectOptions, props = {}) => (
    <SelectInput
      label={label}
      value={form[field]}
      onChange={update(field)}
      options={selectOptions}
      error={errorOf(field)}
      {...props}
    />
  );

  return (
    <Dialog title="New offer" size="lg" onClose={onClose}>
      <form
        className="space-y-6"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          run('save');
        }}
      >
        {problem && <Notice tone="error" title={problem.message} />}
        <Section title="Candidate">
          {input('name', 'Full name', { required: true, 'data-autofocus': true })}
          {input('email', 'Personal email', { type: 'email', required: true })}
          {input('dateOfBirth', 'Date of birth', { type: 'date', required: true, hint: 'Opens the final letter' })}
          {select('gender', 'Gender', [{ value: '', label: 'Not given' }, ...choices.genders], {
            hint: 'Needed for Maharashtra professional tax',
          })}
        </Section>
        <Section title="Position">
          {input('designation', 'Designation', { required: true })}
          {select(
            'departmentId',
            'Department',
            options.departments.map((department) => ({ value: department.id, label: department.name })),
          )}
          {select('reportingManagerId', 'Reporting manager', managerOptions)}
          {select('role', 'Access role', toGroupedOptions(options.roleOptions))}
          {input('dateOfJoining', 'Joining date', { type: 'date', required: true })}
          {select(
            'workLocationType',
            'Work mode',
            options.workLocationTypes.map((mode) => ({ value: mode, label: mode })),
          )}
          {select(
            'employmentStatus',
            'Status on joining',
            options.employmentStatuses.map((status) => ({ value: status, label: status })),
          )}
        </Section>
        <Section title="Pay">
          {input('annualCtc', 'Annual CTC (₹)', {
            inputMode: 'numeric',
            required: true,
            hint: 'Fixed and variable together',
          })}
          {select('taxRegime', 'Tax regime', choices.taxRegimes)}
          {input('workCity', 'Work city', { required: true, hint: 'Sets the HRA rate' })}
          {select('professionalTaxState', 'Professional tax state', [
            { value: '', label: 'Choose a state' },
            ...choices.professionalTaxStates,
          ])}
          {input('variablePayAnnual', 'Variable pay a year (₹)', {
            inputMode: 'numeric',
            hint: `Part of the CTC, at most ${variablePercent}%`,
          })}
          {input('esopUnits', 'Stock options (units)', { inputMode: 'numeric', hint: 'Not part of the CTC' })}
          {input('basicAnnual', 'Basic a year (₹)', { inputMode: 'numeric', hint: 'Empty: the company policy' })}
          {input('hraAnnual', 'HRA a year (₹)', { inputMode: 'numeric', hint: 'Empty: the company policy' })}
          {input('specialAllowanceAnnual', 'Special allowance a year (₹)', {
            inputMode: 'numeric',
            hint: 'Optional: it balances the rest, and is checked',
          })}
        </Section>
        <Section title="Terms">
          {input('probationMonths', 'Probation (months)', {
            type: 'number',
            min: 0,
            max: choices.limits.probationMonthsMax,
          })}
          {input('noticePeriodDays', 'Notice period (days)', {
            type: 'number',
            min: 0,
            max: choices.limits.noticePeriodDaysMax,
          })}
          {input('offerValidUntil', 'Accept by', {
            type: 'date',
            hint: `Empty: ${settings.offerTerms.offerValidityDays} days from sending`,
          })}
        </Section>
        {structure && (
          <div className="rounded-xl ring-1 ring-slate-200">
            <StructureTable structure={structure} />
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => run('calculate')} isBusy={busyAction === 'calculate'}>
            Work out figures
          </Button>
          <Button variant="secondary" onClick={() => run('preview')} isBusy={busyAction === 'preview'}>
            Preview letter
          </Button>
          <Button type="submit" isBusy={busyAction === 'save'}>
            Save for review
          </Button>
        </div>
      </form>
      {preview && <OfferPreviewDialog preview={preview} candidateName={form.name} onClose={() => setPreview(null)} />}
    </Dialog>
  );
}
