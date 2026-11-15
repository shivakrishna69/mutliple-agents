/**
 * Offboarding one person, inside the NSK conversation, opened from their Start offboarding package card
 * (RUN_OFFBOARDING; the backend checks it on every call):
 *
 *   1. the form: separation kind, resignation or notice date, last working day, exit reason, and the
 *      adjustments HR may make (salary, salary days, encashable leave, notice shortfall or its waiver,
 *      fixed-term, TDS, other earnings and deductions); empty means "what the portal holds"
 *   2. Preview settlement (POST /offboarding/preview): the breakdown with the payment deadline banner,
 *      the backend's notes, and what still blocks starting; previewing again keeps the same draft
 *   3. Start offboarding (POST /offboarding/execute, at the version previewed): the person moves to
 *      Notice and the documents are prepared; each step arrives over Socket.IO (OFFBOARDING_PROGRESS),
 *      with the case re-read every few seconds as well, since events missed while disconnected are not
 *      replayed; each ready document gets a download button
 *
 * Every error, note and figure shown is the backend's.
 */

import { useEffect, useState } from 'react';
import { requestOffboardingCase, requestOffboardingExecution, requestOffboardingPreview } from '../../api/nskBotApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { OFFBOARDING_LABELS as L, OFFBOARDING_STATUSES, SEPARATION_KIND_OPTIONS } from '../../constants/nskBot.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { useSocket } from '../../hooks/useSocket.js';
import { emptyOffboardingForm, isGenerating, mergeProgress, toPreviewRequest } from '../../utils/nskBot.js';
import { CloseIcon, PlusIcon } from '../Icons.jsx';
import { Button, Notice, SelectInput, TextInput, Toggle } from '../ui.jsx';
import OffboardingDocuments from './OffboardingDocuments.jsx';
import SettlementBreakdown from './SettlementBreakdown.jsx';

const POLL_INTERVAL_MS = 3_000;
const todayIso = () => new Date().toISOString().slice(0, 10);

function LineEditor({ title, lines, onChange, withTaxable }) {
  const update = (index, changes) => onChange(lines.map((line, at) => (at === index ? { ...line, ...changes } : line)));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-semibold tracking-wide text-slate-600 uppercase">{title}</legend>
      {lines.map((line, index) => (
        <div key={index} className="flex items-end gap-1.5">
          <TextInput
            className="flex-1"
            label={L.LINE_LABEL}
            value={line.label}
            maxLength={80}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <TextInput
            className="w-28"
            label={L.LINE_AMOUNT}
            type="number"
            min="0"
            step="0.01"
            value={line.amount}
            onChange={(event) => update(index, { amount: event.target.value })}
          />
          {withTaxable && (
            <label className="mb-2.5 flex items-center gap-1 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={line.taxable !== false}
                onChange={(event) => update(index, { taxable: event.target.checked })}
              />
              {L.TAXABLE}
            </label>
          )}
          <button
            type="button"
            aria-label={`${L.REMOVE_LINE} ${title}`}
            onClick={() => onChange(lines.filter((_, at) => at !== index))}
            className="mb-2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange([...lines, { label: '', amount: '', taxable: true }])}
        aria-label={`${L.ADD_LINE}: ${title}`}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {L.ADD_LINE}
      </Button>
    </fieldset>
  );
}

/**
 * @param {{ target: { employeeId: string, employeeName: string, employeeCode: string }, onClose: () => void }} props
 */
export default function OffboardingPanel({ target, onClose }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState(() => emptyOffboardingForm(todayIso()));
  const [offboardingCase, setOffboardingCase] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const setValue = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));
  const started = offboardingCase && offboardingCase.status !== OFFBOARDING_STATUSES.DRAFT;
  const generating = isGenerating(offboardingCase);
  const fieldError = (field) => error?.fieldErrors?.[field];

  useSocket({ onOffboardingProgress: (event) => setOffboardingCase((current) => mergeProgress(current, event)) });

  // Events missed while the socket was away are not replayed: the case is re-read while documents are prepared.
  const caseId = offboardingCase?.id;
  useEffect(() => {
    if (!generating || !caseId) return undefined;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const { case: latest } = await requestOffboardingCase(caseId, controller.signal);
        setOffboardingCase(latest);
      } catch {
        // The next round, or the socket, brings the news.
      }
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [generating, caseId]);

  async function preview(event) {
    event.preventDefault();
    setBusy('preview');
    setError(null);
    setNotice(null);
    try {
      const request = toPreviewRequest(form, target.employeeId, offboardingCase?.version ?? null);
      const result = await requestOffboardingPreview(request, csrfToken);
      setOffboardingCase(result.case);
      setNotice(result.message);
    } catch (previewError) {
      setError(toDisplayError(previewError));
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy('start');
    setError(null);
    try {
      const result = await requestOffboardingExecution(
        { caseId: offboardingCase.id, version: offboardingCase.version },
        csrfToken,
      );
      setOffboardingCase(result.case);
      setNotice(result.message);
    } catch (startError) {
      setError(toDisplayError(startError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-label={`${L.TITLE}: ${target.employeeName}`}
      data-testid="offboarding-panel"
      className="rounded-2xl bg-white p-3.5 ring-1 ring-brand-200"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{L.TITLE}</h3>
          <p className="text-xs text-slate-500">
            {target.employeeName} · {target.employeeCode}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close the offboarding package"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {!started && (
        <form onSubmit={preview} className="mt-3 space-y-3" noValidate>
          <SelectInput
            label={L.SEPARATION}
            options={SEPARATION_KIND_OPTIONS}
            value={form.kind}
            onChange={set('kind')}
            error={fieldError('separation.kind')}
          />
          <div className="grid grid-cols-2 gap-2">
            <TextInput
              label={L.NOTICE_DATE}
              type="date"
              required
              value={form.noticeDate}
              onChange={set('noticeDate')}
              error={fieldError('separation.noticeDate')}
            />
            <TextInput
              label={L.LAST_WORKING_DAY}
              type="date"
              required
              value={form.lastWorkingDay}
              onChange={set('lastWorkingDay')}
              error={fieldError('separation.lastWorkingDay')}
            />
          </div>
          <TextInput
            label={L.REASON}
            value={form.reason}
            maxLength={300}
            onChange={set('reason')}
            error={fieldError('separation.reason')}
          />
          <details className="rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-200/70">
            <summary className="cursor-pointer text-xs font-semibold text-slate-600">{L.ADJUSTMENTS}</summary>
            <div className="mt-2.5 space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['monthlyGross', L.MONTHLY_GROSS],
                  ['monthlyBasic', L.MONTHLY_BASIC],
                  ['salaryDays', L.SALARY_DAYS],
                  ['encashableDays', L.ENCASHABLE_DAYS],
                  ['noticeShortfallDays', L.SHORTFALL_DAYS],
                  ['tdsOverride', L.TDS_OVERRIDE],
                ].map(([field, label]) => (
                  <TextInput
                    key={field}
                    label={label}
                    type="number"
                    min="0"
                    step={field === 'salaryDays' || field === 'noticeShortfallDays' ? '1' : '0.01'}
                    value={form[field]}
                    onChange={set(field)}
                    error={fieldError(`adjustments.${field}`)}
                  />
                ))}
              </div>
              <Toggle
                label={L.WAIVE_RECOVERY}
                checked={form.noticeRecoveryWaived}
                onChange={setValue('noticeRecoveryWaived')}
              />
              <Toggle label={L.FIXED_TERM} checked={form.isFixedTerm} onChange={setValue('isFixedTerm')} />
              <LineEditor
                title={L.OTHER_EARNINGS}
                lines={form.otherEarnings}
                onChange={setValue('otherEarnings')}
                withTaxable
              />
              <LineEditor
                title={L.OTHER_DEDUCTIONS}
                lines={form.otherDeductions}
                onChange={setValue('otherDeductions')}
              />
            </div>
          </details>
          <Button type="submit" variant="secondary" isBusy={busy === 'preview'} className="w-full">
            {offboardingCase ? L.PREVIEW_AGAIN : L.PREVIEW}
          </Button>
        </form>
      )}

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error.message}</Notice>
        </div>
      )}
      {notice && !error && (
        <div className="mt-3">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}

      {offboardingCase && (
        <div className="mt-3 space-y-3">
          <SettlementBreakdown offboardingCase={offboardingCase} />
          {!started && (
            <Button
              className="w-full"
              isBusy={busy === 'start'}
              disabled={offboardingCase.blockers.length > 0 || busy !== null}
              onClick={start}
            >
              {L.START}
            </Button>
          )}
          {started && <OffboardingDocuments offboardingCase={offboardingCase} />}
          {offboardingCase.status === OFFBOARDING_STATUSES.FAILED && (
            <Button variant="secondary" className="w-full" isBusy={busy === 'start'} onClick={start}>
              {L.RETRY}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
