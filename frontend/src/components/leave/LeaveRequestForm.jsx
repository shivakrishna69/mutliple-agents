/**
 * Asking for leave. As the employee picks the type and dates, the backend prices the leave
 * (POST /api/leave/requests/preview) and the form shows it day by day: working days, weekly offs,
 * holidays, half days, days charged under the sandwich rule, and the balance left afterwards.
 * Nothing is saved until "Send request" (POST /api/leave/requests).
 *
 * When the type needs a supporting document for a leave this long, the employee picks one of their
 * leave documents from the vault or uploads one here (a medical certificate, for example).
 *
 * The preview is requested a moment after the last change, and an older preview never replaces a
 * newer one. Every policy check happens on the backend; its message is shown as it comes.
 */

import { useEffect, useRef, useState } from 'react';
import { requestLeavePreview, requestLeaveSubmission } from '../../api/leaveApi.js';
import { requestDocumentUpload, requestEmployeeDocuments } from '../../api/workforceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  DAY_KIND_LABELS,
  DAY_PORTIONS,
  END_PORTION_OPTIONS,
  LEAVE_DOCUMENT_TYPE,
  LEAVE_FIELD_LIMITS,
  START_PORTION_OPTIONS,
  UPLOAD_UNAVAILABLE_MESSAGE,
  UPLOAD_UNAVAILABLE_NO_DOCUMENTS_HINT,
  formatDays,
} from '../../constants/leave.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { formatCalendarDate } from '../../utils/dates.js';
import { Badge, Button, Card, Notice, SelectInput, Spinner, TextInput } from '../ui.jsx';

const PREVIEW_DELAY_MS = 400;
const HTTP_SERVER_ERROR_FLOOR = 500;
const SINGLE_DAY_PARTS = Object.freeze([
  { value: 'whole', label: 'Full day', startDayPortion: DAY_PORTIONS.FULL, endDayPortion: DAY_PORTIONS.FULL },
  {
    value: 'morning',
    label: 'Morning only (first half)',
    startDayPortion: DAY_PORTIONS.FULL,
    endDayPortion: DAY_PORTIONS.FIRST_HALF,
  },
  {
    value: 'afternoon',
    label: 'Afternoon only (second half)',
    startDayPortion: DAY_PORTIONS.SECOND_HALF,
    endDayPortion: DAY_PORTIONS.FULL,
  },
]);
const shortDate = (calendarDate) =>
  formatCalendarDate(calendarDate, { weekday: 'short', day: 'numeric', month: 'short' });

function singleDayPartOf(form) {
  return (
    SINGLE_DAY_PARTS.find(
      (part) => part.startDayPortion === form.startDayPortion && part.endDayPortion === form.endDayPortion,
    ) ?? SINGLE_DAY_PARTS[0]
  ).value;
}

function PreviewDays({ preview }) {
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
      <table className="min-w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {preview.days.map((day) => (
            <tr key={day.date} className={day.chargedDays === 0 ? 'text-slate-400' : 'text-slate-800'}>
              <td className="px-4 py-2 whitespace-nowrap">{shortDate(day.date)}</td>
              <td className="px-4 py-2">
                {day.holidayName ?? DAY_KIND_LABELS[day.kind]}
                {day.kind !== 'working' && day.chargedDays > 0 && (
                  <Badge tone="amber" className="ml-2">
                    sandwich rule
                  </Badge>
                )}
              </td>
              <td className="px-4 py-2 text-right font-medium tabular-nums">
                {day.chargedDays === 0 ? 'Free' : formatDays(day.chargedDays)}
              </td>
            </tr>
          ))}
          {preview.borderCharges.map((charge) => (
            <tr key={`border-${charge.date}`} className="bg-amber-50/60 text-slate-800">
              <td className="px-4 py-2 whitespace-nowrap">{shortDate(charge.date)}</td>
              <td className="px-4 py-2">
                Between this and your approved leave next to it
                <Badge tone="amber" className="ml-2">
                  sandwich rule
                </Badge>
              </td>
              <td className="px-4 py-2 text-right font-medium tabular-nums">{formatDays(charge.chargedDays)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewSummary({ preview, isPreviewing, previewError }) {
  if (previewError) return <Notice tone="warning" title={previewError.message} />;
  if (!preview) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        {isPreviewing && <Spinner className="h-4 w-4 text-indigo-500" />}
        Choose a leave type and dates to see what the leave costs.
      </p>
    );
  }
  const remaining = preview.tracksBalance ? preview.availableDays - preview.totalDays : null;
  return (
    <div className={`space-y-3 transition-opacity ${isPreviewing ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-lg font-semibold text-slate-900">This leave costs {formatDays(preview.totalDays)}</p>
        {preview.tracksBalance && (
          <p className="text-sm text-slate-600">
            {formatDays(preview.availableDays)} available · {formatDays(remaining)} left after
          </p>
        )}
      </div>
      <PreviewDays preview={preview} />
      {!preview.isCoveredByBalance && (
        <Notice tone="warning" title="Your balance does not cover this leave">
          Shorten it, choose another type, or ask HR.
        </Notice>
      )}
    </div>
  );
}

function AttachmentPicker({ employeeId, value, onChange, error }) {
  const { csrfToken } = useAuth();
  const documentsResource = useApiResource((signal) => requestEmployeeDocuments('me', signal), []);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const leaveDocuments = (documentsResource.data?.documents ?? []).filter(
    (document) => document.documentType === LEAVE_DOCUMENT_TYPE,
  );

  async function uploadFile(file) {
    if (!file) return;
    setIsUploading(true);
    setUploadError(null);
    try {
      const { document } = await requestDocumentUpload(
        { file, employeeId, documentType: LEAVE_DOCUMENT_TYPE },
        csrfToken,
      );
      documentsResource.setData((data) => ({ ...data, documents: [document, ...(data?.documents ?? [])] }));
      onChange(document.id);
    } catch (uploadFailure) {
      const displayError = toDisplayError(uploadFailure);
      // A fault on the server side (storage not configured, or down) is not something the employee
      // can fix; problems with the file itself (type, size) keep the backend's own message.
      setUploadError(
        displayError.status >= HTTP_SERVER_ERROR_FLOOR
          ? { ...displayError, isServiceUnavailable: true, message: UPLOAD_UNAVAILABLE_MESSAGE }
          : displayError,
      );
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <fieldset className="space-y-3 rounded-xl bg-indigo-50/60 p-4 ring-1 ring-indigo-100">
      <legend className="sr-only">Supporting document</legend>
      <p className="text-sm font-semibold text-slate-900">A supporting document is needed for leave this long</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectInput
          label="Supporting document"
          value={value ?? ''}
          onChange={(changeEvent) => onChange(changeEvent.target.value || null)}
          error={error}
          options={[
            { value: '', label: leaveDocuments.length ? 'Choose one of your documents' : 'No leave documents yet' },
            ...leaveDocuments.map((document) => ({ value: document.id, label: document.originalFileName })),
          ]}
        />
        <label className="block">
          <span className="block text-xs font-semibold tracking-wide text-slate-600 uppercase">Or upload one</span>
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            disabled={isUploading}
            onChange={(changeEvent) => uploadFile(changeEvent.target.files?.[0])}
            className="mt-1.5 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 file:ring-1 file:ring-indigo-200"
          />
        </label>
      </div>
      {isUploading && <p className="text-xs text-slate-500">Uploading…</p>}
      {uploadError && (
        <Notice
          tone={uploadError.isServiceUnavailable ? 'warning' : 'error'}
          title={uploadError.message}
          onDismiss={() => setUploadError(null)}
        >
          {uploadError.isServiceUnavailable && leaveDocuments.length === 0 && UPLOAD_UNAVAILABLE_NO_DOCUMENTS_HINT}
        </Notice>
      )}
      <p className="text-xs text-slate-500">
        PDF, JPG or PNG. It is kept in your document vault, where HR can verify it.
      </p>
    </fieldset>
  );
}

/**
 * @param {{ leaveTypes: object[], employeeId: string, today: string, draft?: object|null,
 *   onSubmitted: (request: object) => void, onCancel: () => void }} props  `draft` comes from the
 *   leave assistant and fills the form; nothing is sent until the employee presses Send.
 */
export default function LeaveRequestForm({ leaveTypes, employeeId, today, draft = null, onSubmitted, onCancel }) {
  const { csrfToken } = useAuth();
  // A draft from the leave assistant fills the form; the employee still reviews and sends it.
  const [form, setForm] = useState(() => ({
    leaveTypeId: draft?.leaveTypeId ?? leaveTypes[0]?.id ?? '',
    startDate: draft?.startDate ?? today,
    startDayPortion: draft?.startDayPortion ?? DAY_PORTIONS.FULL,
    endDate: draft?.endDate ?? today,
    endDayPortion: draft?.endDayPortion ?? DAY_PORTIONS.FULL,
    reason: draft?.reason ?? '',
    attachmentDocumentId: null,
  }));
  // The starting choice is priced as soon as the form opens, so it starts out busy.
  const [previewState, setPreviewState] = useState(() => ({
    preview: null,
    error: null,
    isPreviewing: Boolean(draft?.leaveTypeId ?? leaveTypes[0]),
  }));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const previewTimerRef = useRef(null);
  const previewControllerRef = useRef(null);
  const leaveType = leaveTypes.find((type) => type.id === form.leaveTypeId);
  const allowsHalfDay = leaveType?.usage.allowHalfDay ?? true;
  const isSingleDay = form.startDate === form.endDate;
  const fieldErrors = submitError?.fieldErrors ?? {};

  /** Prices the given choice a moment from now, replacing any preview still pending. */
  function startPreviewTimer(nextForm) {
    clearTimeout(previewTimerRef.current);
    previewControllerRef.current?.abort();
    previewTimerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      previewControllerRef.current = controller;
      const { leaveTypeId, startDate, startDayPortion, endDate, endDayPortion } = nextForm;
      try {
        const { preview } = await requestLeavePreview(
          { leaveTypeId, startDate, startDayPortion, endDate, endDayPortion },
          csrfToken,
          controller.signal,
        );
        if (!controller.signal.aborted) setPreviewState({ preview, error: null, isPreviewing: false });
      } catch (previewFailure) {
        if (controller.signal.aborted) return;
        setPreviewState({ preview: null, error: toDisplayError(previewFailure), isPreviewing: false });
      }
    }, PREVIEW_DELAY_MS);
  }

  function schedulePreview(nextForm) {
    if (!nextForm.leaveTypeId || !nextForm.startDate || !nextForm.endDate) {
      clearTimeout(previewTimerRef.current);
      previewControllerRef.current?.abort();
      setPreviewState({ preview: null, error: null, isPreviewing: false });
      return;
    }
    setPreviewState((previous) => ({ ...previous, isPreviewing: true }));
    startPreviewTimer(nextForm);
  }

  // Price the starting choice once, and stop any pending preview when the form closes.
  useEffect(() => {
    if (form.leaveTypeId) startPreviewTimer(form);
    return () => {
      clearTimeout(previewTimerRef.current);
      previewControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeForm(changes) {
    const nextForm = { ...form, ...changes };
    if (nextForm.endDate < nextForm.startDate) nextForm.endDate = nextForm.startDate;
    const nextType = leaveTypes.find((type) => type.id === nextForm.leaveTypeId);
    if (nextType && !nextType.usage.allowHalfDay) {
      nextForm.startDayPortion = DAY_PORTIONS.FULL;
      nextForm.endDayPortion = DAY_PORTIONS.FULL;
    }
    setForm(nextForm);
    const pricingChanged = ['leaveTypeId', 'startDate', 'startDayPortion', 'endDate', 'endDayPortion'].some(
      (fieldName) => nextForm[fieldName] !== form[fieldName],
    );
    if (pricingChanged) schedulePreview(nextForm);
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const { request } = await requestLeaveSubmission(form, csrfToken);
      onSubmitted(request);
    } catch (submitFailure) {
      setSubmitError(toDisplayError(submitFailure));
    } finally {
      setIsSubmitting(false);
    }
  }

  const { preview, error: previewError, isPreviewing } = previewState;
  return (
    <Card
      title={draft ? 'Review the assistant’s draft' : 'Ask for leave'}
      subtitle={
        draft
          ? 'Check the dates and the cost, then send it yourself. Your manager, or HR, decides.'
          : 'See what it costs before you send it. Your manager, or HR, decides.'
      }
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {submitError && <Notice tone="error" title={submitError.message} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectInput
            label="Leave type"
            value={form.leaveTypeId}
            onChange={(changeEvent) =>
              changeForm({ leaveTypeId: changeEvent.target.value, attachmentDocumentId: null })
            }
            error={fieldErrors.leaveTypeId}
            options={leaveTypes.map((type) => ({ value: type.id, label: `${type.name} (${type.code})` }))}
          />
          <TextInput
            label="From"
            type="date"
            value={form.startDate}
            onChange={(changeEvent) => changeForm({ startDate: changeEvent.target.value })}
            error={fieldErrors.startDate}
            required
          />
          <TextInput
            label="To"
            type="date"
            min={form.startDate}
            value={form.endDate}
            onChange={(changeEvent) => changeForm({ endDate: changeEvent.target.value })}
            error={fieldErrors.endDate}
            required
          />
        </div>
        {allowsHalfDay &&
          (isSingleDay ? (
            <SelectInput
              label="Which part of the day"
              value={singleDayPartOf(form)}
              onChange={(changeEvent) => {
                const part = SINGLE_DAY_PARTS.find((option) => option.value === changeEvent.target.value);
                changeForm({ startDayPortion: part.startDayPortion, endDayPortion: part.endDayPortion });
              }}
              options={SINGLE_DAY_PARTS}
              className="sm:max-w-xs"
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectInput
                label="First day"
                value={form.startDayPortion}
                onChange={(changeEvent) => changeForm({ startDayPortion: changeEvent.target.value })}
                options={START_PORTION_OPTIONS}
              />
              <SelectInput
                label="Last day"
                value={form.endDayPortion}
                onChange={(changeEvent) => changeForm({ endDayPortion: changeEvent.target.value })}
                options={END_PORTION_OPTIONS}
              />
            </div>
          ))}

        <PreviewSummary preview={preview} isPreviewing={isPreviewing} previewError={previewError} />

        {preview?.attachmentRequired && (
          <AttachmentPicker
            employeeId={employeeId}
            value={form.attachmentDocumentId}
            onChange={(attachmentDocumentId) => changeForm({ attachmentDocumentId })}
            error={fieldErrors.attachmentDocumentId}
          />
        )}

        <TextInput
          label="Reason"
          value={form.reason}
          onChange={(changeEvent) => changeForm({ reason: changeEvent.target.value })}
          error={fieldErrors.reason}
          minLength={LEAVE_FIELD_LIMITS.NOTE_MIN_LENGTH}
          maxLength={LEAVE_FIELD_LIMITS.NOTE_MAX_LENGTH}
          placeholder="Family function in Hyderabad"
          hint="Your approver sees this"
          required
        />
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSubmitting} disabled={Boolean(previewError) || !preview}>
            Send request
          </Button>
        </div>
      </form>
    </Card>
  );
}
