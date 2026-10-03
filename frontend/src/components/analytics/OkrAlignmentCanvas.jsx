/**
 * OKR Strategic Alignment Canvas (GET /api/okrs/alignment?year=&quarter=).
 *
 * Tree: company objective -> department team nodes -> team objectives -> key results -> milestones.
 * Every node shows server-computed progress (weighted by key-result weight; the company node also
 * shows `rollupProgress`, which blends its own key results with its aligned team objectives).
 *
 * Editing:
 *   - A key result's slider sends PATCH /key-results/:id/progress { progressPercent, version } when
 *     the user releases it (not on every pixel). `version` makes concurrent edits safe: if someone
 *     else changed the key result first, the backend answers 409 STALE_VERSION, the canvas reloads
 *     and the user sees the latest value.
 *   - Milestones toggle done/pending; new milestones, key results and objectives can be added.
 *   - Which controls appear comes from the server's per-node `canUpdate` / `canManage` flags and
 *     meta (`canCreateCompanyObjective`, `headedDepartmentIds`); the backend re-checks every write.
 * After any successful write the tree is reloaded, so roll-ups always match the server.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  requestKeyResultCreation,
  requestKeyResultProgress,
  requestMilestoneCreation,
  requestMilestoneUpdate,
  requestObjectiveCreation,
  requestObjectiveUpdate,
  requestOkrAlignment,
  requestWorkforceRisk,
} from '../../api/workforceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { USER_ROLES } from '../../constants/routes.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { FlagIcon, PlusIcon, TargetIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, ProgressBar, SelectInput, TextInput, formatDate, formatInr, progressTone } from '../ui.jsx';

/** Keyboard slider changes are saved this long after the last key press, as one update. */
const KEYBOARD_COMMIT_DELAY_MS = 600;

const KEY_RESULT_UNITS = Object.freeze([
  { value: 'percent', label: 'Percent (%)' },
  { value: 'count', label: 'Count' },
  { value: 'currency_inr', label: 'Rupees (₹)' },
  { value: 'score', label: 'Score' },
]);

function formatUnitValue(value, unit) {
  if (unit === 'percent') return `${Math.round(value * 10) / 10}%`;
  if (unit === 'currency_inr') return formatInr(value);
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value);
}

function currentQuarter() {
  const today = new Date();
  return { year: today.getFullYear(), quarter: Math.floor(today.getMonth() / 3) + 1 };
}

/** Circular progress gauge for objective nodes. */
/** `onDark` switches the track and label colours for use on the dark company header. */
function ProgressRing({ value, size = 56, onDark = false }) {
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const safeValue = Math.max(0, Math.min(100, value ?? 0));
  const strokeClassName = { emerald: 'stroke-emerald-500', amber: 'stroke-amber-500', rose: 'stroke-rose-500' }[progressTone(safeValue)];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} className={`fill-none ${onDark ? "stroke-white/15" : "stroke-slate-100"}`} strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className={`fill-none ${strokeClassName} transition-[stroke-dashoffset] duration-700`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - safeValue / 100)}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-xs font-bold ${onDark ? "text-white" : "text-slate-800"}`}>{Math.round(safeValue)}%</span>
    </div>
  );
}

// =================================================================================================
// Key results
// =================================================================================================

function MilestoneList({ keyResult, onChanged, reportError }) {
  const { csrfToken } = useAuth();
  const [newTitle, setNewTitle] = useState('');
  const [newDueDate, setNewDueDate] = useState('');
  const [busyMilestoneId, setBusyMilestoneId] = useState(null);
  // Optimistic status per milestone id: the box flips at once and reverts if the save fails.
  const [optimisticStatusById, setOptimisticStatusById] = useState({});
  const statusOf = (milestone) => optimisticStatusById[milestone.id] ?? milestone.status;

  async function toggleMilestone(milestone) {
    const nextStatus = statusOf(milestone) === 'done' ? 'pending' : 'done';
    setOptimisticStatusById((previousStatuses) => ({ ...previousStatuses, [milestone.id]: nextStatus }));
    setBusyMilestoneId(milestone.id);
    try {
      await requestMilestoneUpdate(keyResult.id, milestone.id, { status: nextStatus, version: keyResult.version }, csrfToken);
      onChanged();
    } catch (milestoneError) {
      setOptimisticStatusById((previousStatuses) => {
        const { [milestone.id]: _reverted, ...remainingStatuses } = previousStatuses;
        return remainingStatuses;
      });
      reportError(milestoneError);
    } finally {
      setBusyMilestoneId(null);
    }
  }

  async function addMilestone(submitEvent) {
    submitEvent.preventDefault();
    if (!newTitle.trim()) return;
    setBusyMilestoneId('new');
    try {
      await requestMilestoneCreation(keyResult.id, { title: newTitle.trim(), ...(newDueDate && { dueDate: newDueDate }), version: keyResult.version }, csrfToken);
      setNewTitle('');
      setNewDueDate('');
      onChanged();
    } catch (milestoneError) {
      reportError(milestoneError);
    } finally {
      setBusyMilestoneId(null);
    }
  }

  return (
    <div className="mt-3 space-y-1.5">
      {keyResult.milestones.map((milestone) => (
        <label key={milestone.id} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${keyResult.canUpdate ? 'cursor-pointer hover:bg-slate-50' : ''}`}>
          <input
            type="checkbox"
            checked={statusOf(milestone) === 'done'}
            disabled={!keyResult.canUpdate || busyMilestoneId !== null}
            onChange={() => toggleMilestone(milestone)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span className={statusOf(milestone) === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}>{milestone.title}</span>
          {milestone.dueDate && <span className="ml-auto text-xs text-slate-400">{formatDate(milestone.dueDate, { day: 'numeric', month: 'short' })}</span>}
        </label>
      ))}
      {keyResult.canUpdate && (
        <form onSubmit={addMilestone} className="flex gap-2 pt-1">
          <input
            value={newTitle}
            onChange={(changeEvent) => setNewTitle(changeEvent.target.value)}
            placeholder="Add a milestone…"
            maxLength={200}
            aria-label="New milestone title"
            className="min-w-0 flex-1 rounded-lg border-0 bg-slate-50 px-3 py-1.5 text-xs ring-1 ring-slate-200 ring-inset focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
          <input type="date" value={newDueDate} onChange={(changeEvent) => setNewDueDate(changeEvent.target.value)} aria-label="Due date" className="rounded-lg border-0 bg-slate-50 px-2 py-1.5 text-xs ring-1 ring-slate-200 ring-inset" />
          <Button size="sm" variant="secondary" type="submit" isBusy={busyMilestoneId === 'new'} disabled={!newTitle.trim()}>
            Add
          </Button>
        </form>
      )}
    </div>
  );
}

function KeyResultRow({ keyResult, onChanged, reportError }) {
  const { csrfToken } = useAuth();
  const [draftPercent, setDraftPercent] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const displayedPercent = draftPercent ?? keyResult.progress;
  // pointerup, keyup and blur can all follow one drag; only the first may send it.
  const isCommittingRef = useRef(false);
  const keyboardCommitTimerRef = useRef(null);
  // Latest slider value, read by the delayed keyboard commit (a timer must not see a stale render).
  const draftPercentRef = useRef(null);
  function updateDraft(nextPercent) {
    draftPercentRef.current = nextPercent;
    setDraftPercent(nextPercent);
  }
  useEffect(() => () => clearTimeout(keyboardCommitTimerRef.current), []);

  function scheduleKeyboardCommit() {
    clearTimeout(keyboardCommitTimerRef.current);
    keyboardCommitTimerRef.current = setTimeout(commitProgress, KEYBOARD_COMMIT_DELAY_MS);
  }

  async function commitProgress() {
    clearTimeout(keyboardCommitTimerRef.current);
    if (isCommittingRef.current) return;
    const percentToSave = draftPercentRef.current;
    if (percentToSave === null || percentToSave === keyResult.progress) {
      updateDraft(null);
      return;
    }
    isCommittingRef.current = true;
    setIsSaving(true);
    try {
      await requestKeyResultProgress(keyResult.id, { progressPercent: percentToSave, version: keyResult.version }, csrfToken);
      onChanged();
    } catch (progressError) {
      reportError(progressError);
    } finally {
      setIsSaving(false);
      updateDraft(null);
      isCommittingRef.current = false;
    }
  }

  return (
    <div className="rounded-xl bg-white p-3.5 ring-1 ring-slate-200/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-900">{keyResult.title}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {formatUnitValue(keyResult.currentValue, keyResult.unit)} of {formatUnitValue(keyResult.targetValue, keyResult.unit)}
            {keyResult.owner?.name && ` · ${keyResult.owner.name}`}
            {keyResult.weight > 1 && ` · weight ${keyResult.weight}`}
          </p>
        </div>
        <span className={`shrink-0 text-sm font-bold tabular-nums ${{ emerald: 'text-emerald-600', amber: 'text-amber-600', rose: 'text-rose-600' }[progressTone(displayedPercent)]}`}>
          {isSaving ? '…' : `${Math.round(displayedPercent)}%`}
        </span>
      </div>
      <div className="mt-3">
        {keyResult.canUpdate ? (
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={Math.round(displayedPercent)}
            disabled={isSaving}
            onChange={(changeEvent) => updateDraft(Number(changeEvent.target.value))}
            onPointerUp={commitProgress}
            onKeyUp={(keyEvent) => ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(keyEvent.key) && scheduleKeyboardCommit()}
            onBlur={commitProgress}
            aria-label={`Progress for ${keyResult.title}`}
            className="h-2 w-full cursor-pointer accent-indigo-600"
          />
        ) : (
          <ProgressBar value={keyResult.progress} tone={progressTone(keyResult.progress)} label={`Progress for ${keyResult.title}`} />
        )}
      </div>
      <button type="button" onClick={() => setIsExpanded((wasExpanded) => !wasExpanded)} className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-500" aria-expanded={isExpanded}>
        Milestones {keyResult.milestoneSummary.done}/{keyResult.milestoneSummary.total} {isExpanded ? '▴' : '▾'}
      </button>
      {keyResult.lastCheckIn?.note && isExpanded && <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">Last check-in: “{keyResult.lastCheckIn.note}”</p>}
      {isExpanded && <MilestoneList keyResult={keyResult} onChanged={onChanged} reportError={reportError} />}
    </div>
  );
}

function AddKeyResultForm({ objective, ownerOptions, defaultOwnerId, onCreated, onCancel }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState({ title: '', unit: 'percent', startValue: '0', targetValue: '100', weight: '1', ownerEmployeeId: defaultOwnerId ?? ownerOptions[0]?.value ?? '' });
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const update = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setFormError(null);
    try {
      await requestKeyResultCreation(
        objective.id,
        { title: form.title.trim(), unit: form.unit, startValue: Number(form.startValue), targetValue: Number(form.targetValue), weight: Number(form.weight), ownerEmployeeId: form.ownerEmployeeId },
        csrfToken,
      );
      onCreated();
    } catch (creationError) {
      setFormError(toDisplayError(creationError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl bg-indigo-50/60 p-4 ring-1 ring-indigo-100">
      <TextInput label="Key result" value={form.title} onChange={update('title')} placeholder="e.g. Raise CSAT from 78% to 90%" error={formError?.fieldErrors?.title} required />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SelectInput label="Unit" value={form.unit} onChange={update('unit')} options={KEY_RESULT_UNITS} />
        <TextInput label="Start" type="number" step="any" value={form.startValue} onChange={update('startValue')} error={formError?.fieldErrors?.startValue} />
        <TextInput label="Target" type="number" step="any" value={form.targetValue} onChange={update('targetValue')} error={formError?.fieldErrors?.targetValue} />
        <TextInput label="Weight" type="number" min="1" max="10" value={form.weight} onChange={update('weight')} />
      </div>
      {ownerOptions.length > 0 && <SelectInput label="Owner" value={form.ownerEmployeeId} onChange={update('ownerEmployeeId')} options={ownerOptions} />}
      {formError && <Notice tone="error" title={formError.message} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" isBusy={isSaving} disabled={!form.title.trim() || !form.ownerEmployeeId}>
          Add key result
        </Button>
      </div>
    </form>
  );
}

// =================================================================================================
// Objectives
// =================================================================================================

function ObjectiveBody({ objective, ownerOptions, defaultOwnerId, onChanged, reportError }) {
  const { csrfToken } = useAuth();
  const [isAddingKeyResult, setIsAddingKeyResult] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  async function archiveObjective() {
    if (!window.confirm(`Archive "${objective.title}"? It will leave the canvas.`)) return;
    setIsArchiving(true);
    try {
      await requestObjectiveUpdate(objective.id, { status: 'archived', version: objective.version }, csrfToken);
      onChanged();
    } catch (archiveError) {
      reportError(archiveError);
    } finally {
      setIsArchiving(false);
    }
  }

  return (
    <div className="space-y-2.5">
      {objective.keyResults.length === 0 && !isAddingKeyResult && <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">No key results yet.</p>}
      {objective.keyResults.map((keyResult) => (
        <KeyResultRow key={keyResult.id} keyResult={keyResult} onChanged={onChanged} reportError={reportError} />
      ))}
      {isAddingKeyResult && (
        <AddKeyResultForm objective={objective} ownerOptions={ownerOptions} defaultOwnerId={defaultOwnerId} onCreated={() => { setIsAddingKeyResult(false); onChanged(); }} onCancel={() => setIsAddingKeyResult(false)} />
      )}
      {objective.canManage && !isAddingKeyResult && (
        <div className="flex gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => setIsAddingKeyResult(true)}>
            <PlusIcon className="h-4 w-4" /> Key result
          </Button>
          <Button variant="ghost" size="sm" isBusy={isArchiving} onClick={archiveObjective}>
            Archive
          </Button>
        </div>
      )}
    </div>
  );
}

function CompanyObjectiveNode({ objective, ownerOptions, defaultOwnerId, onChanged, reportError, onAddTeamObjective, canAddTeamObjective }) {
  return (
    <article className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200/70">
      <header className="relative bg-gradient-to-br from-slate-900 via-indigo-950 to-violet-950 px-6 py-5 text-white">
        <div className="flex items-start gap-4">
          <ProgressRing value={objective.rollupProgress ?? objective.progress} size={64} onDark />
          <div className="min-w-0 flex-1">
            <Badge tone="violet">Company objective</Badge>
            <h3 className="mt-2 text-lg font-bold">{objective.title}</h3>
            {objective.description && <p className="mt-1 text-sm text-slate-300">{objective.description}</p>}
            <p className="mt-2 text-xs text-slate-400">
              Owner {objective.owner?.name ?? '—'} · own key results {Math.round(objective.progress ?? 0)}% · aligned teams {objective.alignedProgress === null || objective.alignedProgress === undefined ? '—' : `${Math.round(objective.alignedProgress)}%`}
            </p>
          </div>
        </div>
      </header>
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Company key results</p>
          <ObjectiveBody objective={objective} ownerOptions={ownerOptions} defaultOwnerId={defaultOwnerId} onChanged={onChanged} reportError={reportError} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Aligned teams</p>
            {canAddTeamObjective && (
              <Button variant="ghost" size="sm" onClick={() => onAddTeamObjective(objective)}>
                <PlusIcon className="h-4 w-4" /> Team objective
              </Button>
            )}
          </div>
          {objective.teams.length === 0 ? (
            <EmptyState Icon={FlagIcon} title="No team has aligned yet" description="Team objectives that support this goal appear here." />
          ) : (
            // Connector: a rail on the left with a tick per team node.
            <div className="relative space-y-4 border-l-2 border-dashed border-indigo-200 pl-5">
              {objective.teams.map((team) => (
                <section key={team.department.departmentId} className="relative">
                  <span className="absolute top-5 -left-[1.4rem] h-0.5 w-4 bg-indigo-200" aria-hidden="true" />
                  <div className="rounded-2xl bg-slate-50/80 p-4 ring-1 ring-slate-200/70">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-slate-900">
                        {team.department.name ?? 'Team'} {team.department.code && <span className="text-xs font-normal text-slate-400">· {team.department.code}</span>}
                      </p>
                      <span className="text-sm font-bold text-slate-700 tabular-nums">{Math.round(team.progress ?? 0)}%</span>
                    </div>
                    <div className="mt-3 space-y-4">
                      {team.objectives.map((teamObjective) => (
                        <div key={teamObjective.id}>
                          <div className="mb-2 flex items-center gap-3">
                            <ProgressRing value={teamObjective.progress} size={40} />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-slate-900">{teamObjective.title}</p>
                              <p className="text-xs text-slate-500">Owner {teamObjective.owner?.name ?? '—'}</p>
                            </div>
                          </div>
                          <ObjectiveBody objective={teamObjective} ownerOptions={ownerOptions} defaultOwnerId={defaultOwnerId} onChanged={onChanged} reportError={reportError} />
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function ObjectiveComposer({ level, parentObjective, period, departmentOptions, ownerOptions, defaultOwnerId, onCreated, onCancel }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState({ title: '', description: '', departmentId: departmentOptions[0]?.value ?? '', ownerEmployeeId: defaultOwnerId ?? ownerOptions[0]?.value ?? '' });
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const update = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setFormError(null);
    try {
      await requestObjectiveCreation(
        {
          level,
          period,
          title: form.title.trim(),
          ...(form.description.trim() && { description: form.description.trim() }),
          ownerEmployeeId: form.ownerEmployeeId,
          ...(level === 'team' && { departmentId: form.departmentId, parentObjectiveId: parentObjective.id }),
        },
        csrfToken,
      );
      onCreated();
    } catch (creationError) {
      setFormError(toDisplayError(creationError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card title={level === 'company' ? 'New company objective' : `New team objective under “${parentObjective.title}”`} subtitle={`Q${period.quarter} ${period.year}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <TextInput label="Objective" value={form.title} onChange={update('title')} placeholder="An ambitious, qualitative goal" error={formError?.fieldErrors?.title} required />
        <TextInput label="Description (optional)" value={form.description} onChange={update('description')} maxLength={2000} />
        <div className="grid gap-4 sm:grid-cols-2">
          {level === 'team' && <SelectInput label="Team" value={form.departmentId} onChange={update('departmentId')} options={departmentOptions} />}
          {ownerOptions.length > 0 && <SelectInput label="Owner" value={form.ownerEmployeeId} onChange={update('ownerEmployeeId')} options={ownerOptions} />}
        </div>
        {formError && <Notice tone="error" title={formError.message} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving} disabled={!form.title.trim() || !form.ownerEmployeeId || (level === 'team' && !form.departmentId)}>
            Create objective
          </Button>
        </div>
      </form>
    </Card>
  );
}

// =================================================================================================
// Canvas
// =================================================================================================

export default function OkrAlignmentCanvas() {
  const { currentUser } = useAuth();
  const isOrganisationWide = [USER_ROLES.ADMIN, USER_ROLES.HR].includes(currentUser.role);
  const [period, setPeriod] = useState(currentQuarter);
  const [composer, setComposer] = useState(null); // { level, parentObjective? }
  const [actionError, setActionError] = useState(null);
  const { data, error, isLoading, reload } = useApiResource((signal) => requestOkrAlignment(period, signal), [period.year, period.quarter]);
  const rosterResource = useApiResource((signal) => requestWorkforceRisk({ limit: 500 }, signal), [], { enabled: isOrganisationWide });

  const viewerEmployeeId = data?.meta?.viewerEmployeeId ?? null;
  const ownerOptions = useMemo(() => {
    const rosterOptions = [...(rosterResource.data?.employees ?? [])]
      .sort((first, second) => (first.name ?? '').localeCompare(second.name ?? ''))
      .map((employee) => ({ value: employee.employeeId, label: `${employee.name ?? 'Unnamed'}${employee.employeeId === viewerEmployeeId ? ' (you)' : ''}` }));
    if (rosterOptions.length > 0) return rosterOptions;
    return viewerEmployeeId ? [{ value: viewerEmployeeId, label: 'Me' }] : [];
  }, [rosterResource.data, viewerEmployeeId]);

  const departmentOptions = useMemo(() => {
    const departmentNames = new Map();
    for (const employee of rosterResource.data?.employees ?? []) if (employee.departmentId) departmentNames.set(employee.departmentId, employee.departmentName);
    for (const companyObjective of data?.companyObjectives ?? []) for (const team of companyObjective.teams) departmentNames.set(team.department.departmentId, team.department.name);
    const allowedIds = isOrganisationWide ? [...departmentNames.keys()] : (data?.meta?.headedDepartmentIds ?? []);
    return allowedIds.map((departmentId) => ({ value: departmentId, label: departmentNames.get(departmentId) ?? 'Your department' }));
  }, [rosterResource.data, data, isOrganisationWide]);

  function reportError(caughtError) {
    const displayError = toDisplayError(caughtError);
    setActionError(caughtError?.code === 'STALE_VERSION' ? { ...displayError, message: 'Someone updated this just before you. The latest values are shown now; please re-apply your change.' } : displayError);
    reload();
  }

  const handleChanged = () => {
    setActionError(null);
    reload();
  };

  const yearOptions = [period.year - 1, period.year, period.year + 1].map((yearValue) => ({ value: String(yearValue), label: String(yearValue) }));
  const canAddTeamObjective = isOrganisationWide || (data?.meta?.headedDepartmentIds?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex gap-3">
          <SelectInput label="Year" value={String(period.year)} onChange={(changeEvent) => setPeriod({ ...period, year: Number(changeEvent.target.value) })} options={yearOptions} className="w-28" />
          <SelectInput label="Quarter" value={String(period.quarter)} onChange={(changeEvent) => setPeriod({ ...period, quarter: Number(changeEvent.target.value) })} options={[1, 2, 3, 4].map((quarterNumber) => ({ value: String(quarterNumber), label: `Q${quarterNumber}` }))} className="w-28" />
        </div>
        {data && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs text-slate-500">Overall alignment progress</p>
              <p className="text-xs text-slate-400">
                {data.meta.objectiveCount} objectives · {data.meta.keyResultCount} key results
              </p>
            </div>
            <ProgressRing value={data.meta.overallProgress ?? 0} size={52} />
            {data.meta.canCreateCompanyObjective && (
              <Button onClick={() => setComposer({ level: 'company' })}>
                <PlusIcon className="h-4 w-4" /> Company objective
              </Button>
            )}
          </div>
        )}
      </div>

      {actionError && <Notice tone={actionError.status === 409 ? 'warning' : 'error'} title={actionError.message} onDismiss={() => setActionError(null)} />}
      {composer && (
        <ObjectiveComposer
          level={composer.level}
          parentObjective={composer.parentObjective}
          period={period}
          departmentOptions={departmentOptions}
          ownerOptions={ownerOptions}
          defaultOwnerId={viewerEmployeeId}
          onCreated={() => { setComposer(null); handleChanged(); }}
          onCancel={() => setComposer(null)}
        />
      )}

      {isLoading && !data && <LoadingBlock label="Loading the alignment canvas…" />}
      {error && <Notice tone={error.status === 403 ? 'info' : 'error'} title={error.status === 403 ? 'OKRs are available to employees with a profile, HR and administrators.' : error.message} />}
      {data && data.companyObjectives.length === 0 && (
        <EmptyState
          Icon={TargetIcon}
          title={`No objectives for Q${period.quarter} ${period.year}`}
          description="Company objectives anchor the canvas; team objectives align beneath them."
          action={data.meta.canCreateCompanyObjective && <Button onClick={() => setComposer({ level: 'company' })}>Create the first objective</Button>}
        />
      )}
      <div className="space-y-6">
        {data?.companyObjectives.map((companyObjective) => (
          <CompanyObjectiveNode
            key={companyObjective.id}
            objective={companyObjective}
            ownerOptions={ownerOptions}
            defaultOwnerId={viewerEmployeeId}
            onChanged={handleChanged}
            reportError={reportError}
            canAddTeamObjective={canAddTeamObjective}
            onAddTeamObjective={(parentObjective) => setComposer({ level: 'team', parentObjective })}
          />
        ))}
      </div>
    </div>
  );
}
