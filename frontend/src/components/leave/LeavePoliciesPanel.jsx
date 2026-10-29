/**
 * Leave policies (HR and admins): the company's leave year and default time zone, and its leave
 * types. A company starts with the India standard template (CL, SL, EL, LOP), which HR edits here.
 *
 *   GET/PATCH /api/leave/settings · GET /api/leave/types?includeInactive=true · LeaveTypeForm.jsx
 *
 * The leave year's start month locks once any leave has been recorded; the backend refuses the
 * change and its message is shown.
 */

import { useMemo, useState } from 'react';
import { requestLeaveSettings, requestLeaveSettingsUpdate, requestLeaveTypes } from '../../api/leaveApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ACCRUAL_METHOD_OPTIONS, formatDays } from '../../constants/leave.js';
import { timeZoneOptions } from '../../constants/workplace.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { CalendarIcon, PlusIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, MONTH_NAMES, Notice, SelectInput, Toggle } from '../ui.jsx';
import LeaveTypeForm from './LeaveTypeForm.jsx';

function LeaveSettingsCard() {
  const { csrfToken } = useAuth();
  const settingsResource = useApiResource((signal) => requestLeaveSettings(signal), []);
  const [draft, setDraft] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const settings = settingsResource.data?.settings;
  const zoneOptions = useMemo(() => timeZoneOptions(settings?.defaultTimeZone), [settings?.defaultTimeZone]);
  const shown = draft ?? settings;
  const hasChanges =
    draft &&
    (draft.leaveYearStartMonth !== settings.leaveYearStartMonth || draft.defaultTimeZone !== settings.defaultTimeZone);

  async function saveSettings() {
    setIsSaving(true);
    setSaveResult(null);
    try {
      const changes = {};
      if (draft.leaveYearStartMonth !== settings.leaveYearStartMonth)
        changes.leaveYearStartMonth = draft.leaveYearStartMonth;
      if (draft.defaultTimeZone !== settings.defaultTimeZone) changes.defaultTimeZone = draft.defaultTimeZone;
      const { settings: savedSettings } = await requestLeaveSettingsUpdate(
        { ...changes, version: settings.version },
        csrfToken,
      );
      settingsResource.setData({ settings: savedSettings });
      setDraft(null);
      setSaveResult({ tone: 'success', message: 'Leave settings saved' });
    } catch (settingsError) {
      setSaveResult({ tone: 'error', message: toDisplayError(settingsError).message });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card title="Leave year" subtitle="Balances, accruals and year-end carry forward follow this year.">
      {settingsResource.isLoading && !settings && <LoadingBlock label="Loading settings…" />}
      {settingsResource.error && <Notice tone="error" title={settingsResource.error.message} />}
      {shown && (
        <div className="space-y-4">
          {saveResult && (
            <Notice tone={saveResult.tone} title={saveResult.message} onDismiss={() => setSaveResult(null)} />
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectInput
              label="Leave year starts in"
              value={String(shown.leaveYearStartMonth)}
              onChange={(changeEvent) => setDraft({ ...shown, leaveYearStartMonth: Number(changeEvent.target.value) })}
              options={MONTH_NAMES.map((monthName, monthIndex) => ({
                value: String(monthIndex + 1),
                label: monthName,
              }))}
              hint="Locked once leave has been recorded"
            />
            <SelectInput
              label="Default time zone"
              value={shown.defaultTimeZone}
              onChange={(changeEvent) => setDraft({ ...shown, defaultTimeZone: changeEvent.target.value })}
              options={zoneOptions}
              hint="For employees without an office"
            />
            <div className="flex items-end gap-2">
              <Button onClick={saveSettings} isBusy={isSaving} disabled={!hasChanges}>
                Save
              </Button>
              {hasChanges && (
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Undo
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

const ACCRUAL_LABEL_BY_METHOD = Object.fromEntries(ACCRUAL_METHOD_OPTIONS.map(({ value, label }) => [value, label]));

function describeEntitlement(leaveType) {
  if (!leaveType.tracksBalance) return 'No balance: unlimited';
  if (leaveType.accrual.method === 'NONE') return 'Granted per person by HR';
  const timing = leaveType.accrual.method === 'MONTHLY' ? ', monthly' : ', at the start of the year';
  return `${formatDays(leaveType.accrual.annualQuotaDays)} a year${timing}`;
}

function LeaveTypeRow({ leaveType, onEdit }) {
  return (
    <li className="flex flex-wrap items-center gap-4 px-5 py-3.5 sm:px-6">
      <Badge tone="violet" className="w-16 justify-center font-semibold">
        {leaveType.code}
      </Badge>
      <div className="min-w-48 flex-1">
        <p className="text-sm font-semibold text-slate-900">{leaveType.name}</p>
        <p className="text-xs text-slate-500" title={ACCRUAL_LABEL_BY_METHOD[leaveType.accrual.method]}>
          {describeEntitlement(leaveType)}
          {leaveType.usage.sandwichRule && ' · sandwich rule'}
          {leaveType.encashment.isEncashable && ' · encashable'}
        </p>
      </div>
      <div className="flex gap-1.5">
        {!leaveType.isPaid && <Badge tone="amber">Unpaid</Badge>}
        {!leaveType.isActive && <Badge>Retired</Badge>}
      </div>
      <Button variant="secondary" size="sm" onClick={onEdit}>
        Edit
      </Button>
    </li>
  );
}

export default function LeavePoliciesPanel() {
  const [showRetired, setShowRetired] = useState(false);
  // null: no form; 'new': adding; a leave type: editing it.
  const [editing, setEditing] = useState(null);
  const typesResource = useApiResource(
    (signal) => requestLeaveTypes({ includeInactive: showRetired }, signal),
    [showRetired],
  );
  const leaveTypes = typesResource.data?.leaveTypes ?? [];

  function handleSaved() {
    setEditing(null);
    typesResource.reload();
  }

  return (
    <div className="space-y-6">
      <LeaveSettingsCard />
      {editing && (
        <LeaveTypeForm
          key={editing === 'new' ? 'new' : editing.id}
          leaveType={editing === 'new' ? null : editing}
          onSaved={handleSaved}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card
        title="Leave types"
        subtitle="Each type carries its own policy: accrual, carry forward, encashment and the rules for applying."
        bodyClassName="p-0"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Toggle label="Show retired types" checked={showRetired} onChange={setShowRetired} />
            {!editing && (
              <Button size="sm" onClick={() => setEditing('new')}>
                <PlusIcon className="h-4 w-4" /> Add leave type
              </Button>
            )}
          </div>
        }
      >
        {typesResource.isLoading && !typesResource.data && <LoadingBlock label="Loading leave types…" />}
        {typesResource.error && (
          <div className="p-6">
            <Notice tone="error" title={typesResource.error.message} />
          </div>
        )}
        {typesResource.data && leaveTypes.length === 0 && (
          <div className="p-6">
            <EmptyState Icon={CalendarIcon} title="No leave types" description="Add the leave your company offers." />
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {leaveTypes.map((leaveType) => (
            <LeaveTypeRow key={leaveType.id} leaveType={leaveType} onEdit={() => setEditing(leaveType)} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
