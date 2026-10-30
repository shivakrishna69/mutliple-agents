/**
 * Adds or edits a leave type and its whole policy (backend models/LeaveType.js). Day values are in
 * days, in half-day steps; an empty "limit" field means no limit.
 *
 *   POST /api/leave/types · PATCH /api/leave/types/:id (with the version loaded; the code is fixed)
 *
 * Sections that do not apply are hidden and sent as their neutral values (no balance means no
 * accrual or encashment; no accrual means no quota), so a hidden field never fails validation.
 * The backend validates everything and its messages are shown next to the fields.
 */

import { useState } from 'react';
import { requestLeaveTypeCreation, requestLeaveTypeUpdate } from '../../api/leaveApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  ACCRUAL_METHOD_OPTIONS,
  ACCRUAL_TIMING_OPTIONS,
  ELIGIBLE_STATUS_OPTIONS,
  LEAVE_FIELD_LIMITS,
  PRO_RATA_STEP_OPTIONS,
  YEAR_END_EXCESS_OPTIONS,
} from '../../constants/leave.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { Button, Card, Notice, SelectInput, TextInput, Toggle } from '../ui.jsx';

const NO_ACCRUAL = 'NONE';
const dayInputProps = {
  type: 'number',
  min: '0',
  max: String(LEAVE_FIELD_LIMITS.MAX_POLICY_DAYS),
  step: String(LEAVE_FIELD_LIMITS.POLICY_DAY_STEP),
};

const toFormValue = (days) => (days === null || days === undefined ? '' : String(days));
const toDaysOrNull = (value) => (value === '' ? null : Number(value));
const toDaysOrZero = (value) => (value === '' ? 0 : Number(value));

function formFromType(leaveType) {
  return {
    code: leaveType?.code ?? '',
    name: leaveType?.name ?? '',
    description: leaveType?.description ?? '',
    isPaid: leaveType?.isPaid ?? true,
    tracksBalance: leaveType?.tracksBalance ?? true,
    isActive: leaveType?.isActive ?? true,
    accrualMethod: leaveType?.accrual.method ?? NO_ACCRUAL,
    annualQuotaDays: toFormValue(leaveType?.accrual.annualQuotaDays ?? 0),
    accrualTiming: leaveType?.accrual.timing ?? ACCRUAL_TIMING_OPTIONS[0].value,
    proRataRoundingStepDays: String(leaveType?.accrual.proRataRoundingStepDays ?? LEAVE_FIELD_LIMITS.POLICY_DAY_STEP),
    accrueDuringNotice: leaveType?.accrueDuringNotice ?? true,
    carryForwardMaxDays: toFormValue(leaveType ? leaveType.carryForward.maxDays : 0),
    yearEndExcessAction: leaveType?.carryForward.yearEndExcessAction ?? YEAR_END_EXCESS_OPTIONS[0].value,
    isEncashable: leaveType?.encashment.isEncashable ?? false,
    minBalanceRetainedDays: toFormValue(leaveType?.encashment.minBalanceRetainedDays ?? 0),
    sandwichRule: leaveType?.usage.sandwichRule ?? false,
    allowHalfDay: leaveType?.usage.allowHalfDay ?? true,
    maxConsecutiveDays: toFormValue(leaveType?.usage.maxConsecutiveDays),
    minNoticeDays: toFormValue(leaveType?.usage.minNoticeDays ?? 0),
    maxBackdatedDays: toFormValue(leaveType?.usage.maxBackdatedDays ?? 0),
    eligibleEmploymentStatuses: leaveType?.usage.eligibleEmploymentStatuses ?? [...ELIGIBLE_STATUS_OPTIONS],
    minServiceDays: toFormValue(leaveType?.usage.minServiceDays ?? 0),
    attachmentRequiredAfterDays: toFormValue(leaveType?.usage.attachmentRequiredAfterDays),
    hrApprovalAfterDays: toFormValue(leaveType?.usage.hrApprovalAfterDays),
    allowNegativeBalance: leaveType?.usage.allowNegativeBalance ?? false,
    maxNegativeDays: toFormValue(leaveType?.usage.maxNegativeDays ?? 0),
  };
}

/** The request body, with the neutral values for sections that do not apply. */
function typeInputFromForm(form, { includeCode }) {
  const hasAccrual = form.tracksBalance && form.accrualMethod !== NO_ACCRUAL;
  const canGoNegative = form.tracksBalance && form.allowNegativeBalance;
  return {
    ...(includeCode ? { code: form.code.trim().toUpperCase() } : {}),
    name: form.name,
    description: form.description,
    isPaid: form.isPaid,
    tracksBalance: form.tracksBalance,
    isActive: form.isActive,
    accrual: {
      method: form.tracksBalance ? form.accrualMethod : NO_ACCRUAL,
      annualQuotaDays: hasAccrual ? toDaysOrZero(form.annualQuotaDays) : 0,
      timing: form.accrualTiming,
      proRataRoundingStepDays: Number(form.proRataRoundingStepDays),
    },
    accrueDuringNotice: form.accrueDuringNotice,
    carryForward: {
      maxDays: form.tracksBalance ? toDaysOrNull(form.carryForwardMaxDays) : 0,
      yearEndExcessAction: form.yearEndExcessAction,
    },
    encashment: {
      isEncashable: form.tracksBalance && form.isEncashable,
      minBalanceRetainedDays: toDaysOrZero(form.minBalanceRetainedDays),
    },
    usage: {
      sandwichRule: form.sandwichRule,
      allowHalfDay: form.allowHalfDay,
      maxConsecutiveDays: toDaysOrNull(form.maxConsecutiveDays),
      minNoticeDays: toDaysOrZero(form.minNoticeDays),
      maxBackdatedDays: toDaysOrZero(form.maxBackdatedDays),
      eligibleEmploymentStatuses: form.eligibleEmploymentStatuses,
      minServiceDays: toDaysOrZero(form.minServiceDays),
      attachmentRequiredAfterDays: toDaysOrNull(form.attachmentRequiredAfterDays),
      hrApprovalAfterDays: toDaysOrNull(form.hrApprovalAfterDays),
      allowNegativeBalance: canGoNegative,
      maxNegativeDays: canGoNegative ? toDaysOrZero(form.maxNegativeDays) : 0,
    },
  };
}

function Section({ title, description, children }) {
  return (
    <fieldset className="space-y-3">
      <div>
        <legend className="text-sm font-semibold text-slate-900">{title}</legend>
        {description && <p className="text-xs text-slate-500">{description}</p>}
      </div>
      {children}
    </fieldset>
  );
}

/**
 * @param {{ leaveType: object|null, onSaved: (leaveType: object) => void, onCancel: () => void }} props
 *   leaveType null adds a new type.
 */
export default function LeaveTypeForm({ leaveType, onSaved, onCancel }) {
  const { csrfToken } = useAuth();
  const isEditing = Boolean(leaveType);
  const [form, setForm] = useState(() => formFromType(leaveType));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const fieldErrors = saveError?.fieldErrors ?? {};
  const text = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });
  const flag = (fieldName) => (checked) => setForm({ ...form, [fieldName]: checked });

  function toggleStatus(status) {
    const statuses = form.eligibleEmploymentStatuses.includes(status)
      ? form.eligibleEmploymentStatuses.filter((value) => value !== status)
      : [...form.eligibleEmploymentStatuses, status];
    setForm({ ...form, eligibleEmploymentStatuses: statuses });
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const typeInput = typeInputFromForm(form, { includeCode: !isEditing });
      const { leaveType: savedType } = isEditing
        ? await requestLeaveTypeUpdate(leaveType.id, { ...typeInput, version: leaveType.version }, csrfToken)
        : await requestLeaveTypeCreation(typeInput, csrfToken);
      onSaved(savedType);
    } catch (typeError) {
      setSaveError(toDisplayError(typeError));
    } finally {
      setIsSaving(false);
    }
  }

  const hasAccrual = form.tracksBalance && form.accrualMethod !== NO_ACCRUAL;
  return (
    <Card
      title={isEditing ? `Edit ${leaveType.name}` : 'Add a leave type'}
      subtitle={
        isEditing
          ? 'Policy changes apply from now on; leave already recorded keeps its figures.'
          : 'Every rule here is your company’s own; change any of them later.'
      }
    >
      <form onSubmit={handleSubmit} className="space-y-8">
        {saveError && <Notice tone="error" title={saveError.message} />}

        <Section title="Basics">
          <div className="grid gap-4 sm:grid-cols-3">
            <TextInput
              label="Code"
              value={form.code}
              onChange={text('code')}
              error={fieldErrors.code}
              hint={isEditing ? 'The code cannot change' : 'Letters, digits or _, e.g. CL'}
              pattern={LEAVE_FIELD_LIMITS.TYPE_CODE_PATTERN}
              disabled={isEditing}
              required
            />
            <TextInput label="Name" value={form.name} onChange={text('name')} error={fieldErrors.name} required />
            <TextInput
              label="Description"
              value={form.description}
              onChange={text('description')}
              error={fieldErrors.description}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Toggle
              label="Paid"
              description="Unpaid days are reported to payroll"
              checked={form.isPaid}
              onChange={flag('isPaid')}
            />
            <Toggle
              label="Keeps a balance"
              description="Off for Loss of Pay, which has no limit"
              checked={form.tracksBalance}
              onChange={flag('tracksBalance')}
            />
            {isEditing && (
              <Toggle
                label="Offered"
                description="Retire a type instead of deleting it"
                checked={form.isActive}
                onChange={flag('isActive')}
              />
            )}
          </div>
          {fieldErrors.tracksBalance && <p className="text-xs text-rose-600">{fieldErrors.tracksBalance}</p>}
        </Section>

        {form.tracksBalance && (
          <Section title="Accrual" description="How days are credited during the leave year.">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectInput
                label="Method"
                value={form.accrualMethod}
                onChange={text('accrualMethod')}
                error={fieldErrors['accrual.method']}
                options={ACCRUAL_METHOD_OPTIONS}
              />
              {hasAccrual && (
                <TextInput
                  label="Days a year"
                  {...dayInputProps}
                  value={form.annualQuotaDays}
                  onChange={text('annualQuotaDays')}
                  error={fieldErrors['accrual.annualQuotaDays']}
                  required
                />
              )}
              {form.accrualMethod === 'MONTHLY' && (
                <SelectInput
                  label="Monthly credit lands"
                  value={form.accrualTiming}
                  onChange={text('accrualTiming')}
                  error={fieldErrors['accrual.timing']}
                  options={ACCRUAL_TIMING_OPTIONS}
                />
              )}
              {hasAccrual && (
                <SelectInput
                  label="Round a joiner's part-year credit to"
                  value={form.proRataRoundingStepDays}
                  onChange={text('proRataRoundingStepDays')}
                  error={fieldErrors['accrual.proRataRoundingStepDays']}
                  options={PRO_RATA_STEP_OPTIONS}
                />
              )}
            </div>
            {hasAccrual && (
              <Toggle
                label="Keeps accruing during notice"
                checked={form.accrueDuringNotice}
                onChange={flag('accrueDuringNotice')}
              />
            )}
          </Section>
        )}

        {form.tracksBalance && (
          <Section title="Year end and encashment">
            <div className="grid gap-4 sm:grid-cols-3">
              <TextInput
                label="Carry forward at most (days)"
                {...dayInputProps}
                value={form.carryForwardMaxDays}
                onChange={text('carryForwardMaxDays')}
                error={fieldErrors['carryForward.maxDays']}
                hint="Empty: carry everything forward"
              />
              <SelectInput
                label="Days over that limit"
                value={form.yearEndExcessAction}
                onChange={text('yearEndExcessAction')}
                error={fieldErrors['carryForward.yearEndExcessAction']}
                options={YEAR_END_EXCESS_OPTIONS}
              />
              {form.isEncashable && (
                <TextInput
                  label="Days kept after encashing"
                  {...dayInputProps}
                  value={form.minBalanceRetainedDays}
                  onChange={text('minBalanceRetainedDays')}
                  error={fieldErrors['encashment.minBalanceRetainedDays']}
                />
              )}
            </div>
            <Toggle
              label="HR may encash it"
              description="Pay days out through payroll"
              checked={form.isEncashable}
              onChange={flag('isEncashable')}
            />
          </Section>
        )}

        <Section title="When employees apply">
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle
              label="Sandwich rule"
              description="Weekends and holidays between two leave days count as leave"
              checked={form.sandwichRule}
              onChange={flag('sandwichRule')}
            />
            <Toggle label="Half days allowed" checked={form.allowHalfDay} onChange={flag('allowHalfDay')} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextInput
              label="Most days in one go"
              {...dayInputProps}
              value={form.maxConsecutiveDays}
              onChange={text('maxConsecutiveDays')}
              error={fieldErrors['usage.maxConsecutiveDays']}
              hint="Empty: no limit"
            />
            <TextInput
              label="Notice needed (days)"
              {...dayInputProps}
              value={form.minNoticeDays}
              onChange={text('minNoticeDays')}
              error={fieldErrors['usage.minNoticeDays']}
            />
            <TextInput
              label="May start up to (days ago)"
              {...dayInputProps}
              value={form.maxBackdatedDays}
              onChange={text('maxBackdatedDays')}
              error={fieldErrors['usage.maxBackdatedDays']}
              hint="For leave applied for afterwards, e.g. sick leave"
            />
            <TextInput
              label="Service needed (days)"
              {...dayInputProps}
              value={form.minServiceDays}
              onChange={text('minServiceDays')}
              error={fieldErrors['usage.minServiceDays']}
            />
            <TextInput
              label="Document needed after (days)"
              {...dayInputProps}
              value={form.attachmentRequiredAfterDays}
              onChange={text('attachmentRequiredAfterDays')}
              error={fieldErrors['usage.attachmentRequiredAfterDays']}
              hint="Empty: never needed"
            />
            <TextInput
              label="HR also approves leave over (days)"
              {...dayInputProps}
              value={form.hrApprovalAfterDays}
              onChange={text('hrApprovalAfterDays')}
              error={fieldErrors['usage.hrApprovalAfterDays']}
              hint="After the manager; empty: the manager alone decides"
            />
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">Offered to</p>
            <div className="mt-2 flex flex-wrap gap-5" role="group" aria-label="Offered to">
              {ELIGIBLE_STATUS_OPTIONS.map((status) => (
                <label key={status} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300 text-brand-600"
                    checked={form.eligibleEmploymentStatuses.includes(status)}
                    onChange={() => toggleStatus(status)}
                  />
                  {status}
                </label>
              ))}
            </div>
            {fieldErrors['usage.eligibleEmploymentStatuses'] && (
              <p className="mt-1 text-xs text-rose-600">{fieldErrors['usage.eligibleEmploymentStatuses']}</p>
            )}
          </div>
          {form.tracksBalance && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Toggle
                label="Balance may go negative"
                checked={form.allowNegativeBalance}
                onChange={flag('allowNegativeBalance')}
              />
              {form.allowNegativeBalance && (
                <TextInput
                  label="By at most (days)"
                  {...dayInputProps}
                  value={form.maxNegativeDays}
                  onChange={text('maxNegativeDays')}
                  error={fieldErrors['usage.maxNegativeDays']}
                />
              )}
            </div>
          )}
        </Section>

        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving}>
            {isEditing ? 'Save leave type' : 'Add leave type'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
