/**
 * Offers (People → Onboarding → Offers), for HR and administrators:
 *
 *   New offer      the offer form (OfferFormDialog), saved for review
 *   Import CSV     many offers at once (POST /drafts/import): every row becomes a draft for review, or
 *                  nothing is created and every problem is listed by line and column
 *   Drafts         each offer with its status and where the candidate is (lifecycle); a draft can be
 *                  previewed as its letter, sent, or cancelled
 *   Send selected  the ticked drafts waiting for review (or whose email failed), sent one by one
 *                  (POST /drafts/bulk-send); each draft's outcome is shown with the backend's reason
 *
 * Nothing reaches a candidate until someone sends it. Every message is the backend's.
 */

import { useRef, useState } from 'react';
import {
  requestOfferBulkSend,
  requestOfferCalculation,
  requestOfferDispatch,
  requestOfferDraftCancel,
  requestOfferDrafts,
  requestOfferImport,
  requestOfferSettings,
} from '../../api/offersApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  BULK_OUTCOME_DISPLAY,
  LIFECYCLE_DISPLAY,
  OFFER_STATUS_DISPLAY,
  OFFER_STATUSES,
  SENDABLE_STATUSES,
} from '../../constants/offers.js';

// Every draft starts as invited; the badge shows only once the candidate has moved on.
const OFFER_LIFECYCLE_INVITED = 'INVITED';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { offerRequestFromDraft } from '../../utils/offers.js';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, formatDate, formatInr } from '../ui.jsx';
import { DocumentIcon, PlusIcon, UploadIcon } from '../Icons.jsx';
import OfferFormDialog from './OfferFormDialog.jsx';
import OfferPreviewDialog from './OfferPreviewDialog.jsx';

function ImportProblems({ problem, onDismiss }) {
  return (
    <Notice tone="error" title={problem.message} onDismiss={onDismiss}>
      {problem.details.length > 0 && (
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-left text-xs" aria-label="Rows to fix">
            <thead>
              <tr>
                <th className="py-1 pr-3 font-semibold">Line</th>
                <th className="py-1 pr-3 font-semibold">Column</th>
                <th className="py-1 font-semibold">Problem</th>
              </tr>
            </thead>
            <tbody>
              {problem.details.map((detail) => (
                <tr key={`${detail.line}-${detail.field}-${detail.message}`}>
                  <td className="py-0.5 pr-3 tabular-nums">{detail.line ?? '—'}</td>
                  <td className="py-0.5 pr-3 font-mono">{detail.field}</td>
                  <td className="py-0.5">{detail.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Notice>
  );
}

function SendResults({ results, drafts, onDismiss }) {
  const nameOf = (draftId) => drafts.find((draft) => draft.id === draftId)?.candidate.name ?? draftId;
  return (
    <Notice tone="info" title="Send results" onDismiss={onDismiss}>
      <ul aria-label="Send results" className="mt-2 space-y-1 text-sm">
        {results.map((result) => (
          <li key={result.draftId} className="flex flex-wrap items-center gap-2">
            <Badge tone={BULK_OUTCOME_DISPLAY[result.outcome].tone}>{BULK_OUTCOME_DISPLAY[result.outcome].label}</Badge>
            <span className="font-medium">{nameOf(result.draftId)}</span>
            {result.message && <span className="text-slate-600">{result.message}</span>}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

export default function OffersPanel({ options }) {
  const { csrfToken } = useAuth();
  const settings = useApiResource((signal) => requestOfferSettings(signal), []);
  const drafts = useApiResource((signal) => requestOfferDrafts(undefined, signal), []);
  const [selected, setSelected] = useState(() => new Set());
  const [isComposing, setIsComposing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [problem, setProblem] = useState(null);
  const [sendResults, setSendResults] = useState(null);
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(null);
  const fileInput = useRef(null);

  const list = drafts.data?.drafts ?? [];
  const sendable = list.filter((draft) => SENDABLE_STATUSES.includes(draft.status));
  const bulkSendMax = settings.data?.choices.limits.bulkSendMax ?? 0;
  const selectedIds = [...selected].filter((draftId) => sendable.some((draft) => draft.id === draftId));

  function toggle(draftId) {
    const next = new Set(selected);
    if (next.has(draftId)) next.delete(draftId);
    else next.add(draftId);
    setSelected(next);
  }

  async function act(key, action) {
    setBusy(key);
    setProblem(null);
    try {
      await action();
    } catch (actionError) {
      setProblem(toDisplayError(actionError));
    } finally {
      setBusy(null);
    }
  }

  const importFile = (file) =>
    act('import', async () => {
      const result = await requestOfferImport(file, csrfToken);
      setNotice(result.notice);
      drafts.reload();
    });

  const sendSelected = () =>
    act('bulk', async () => {
      const result = await requestOfferBulkSend(selectedIds, csrfToken);
      setNotice(result.notice);
      setSendResults(result.results);
      setSelected(new Set());
      drafts.reload();
    });

  const previewDraft = (draft) =>
    act(`preview-${draft.id}`, async () => {
      const result = await requestOfferCalculation(
        { ...offerRequestFromDraft(draft), includePreview: true },
        csrfToken,
      );
      setPreview({ preview: result.preview, candidateName: draft.candidate.name });
    });

  const sendDraft = (draft) =>
    act(`send-${draft.id}`, async () => {
      const result = await requestOfferDispatch(draft.id, csrfToken);
      setNotice(result.notice);
      drafts.reload();
    });

  const cancelDraft = (draft) =>
    act(`cancel-${draft.id}`, async () => {
      const result = await requestOfferDraftCancel(draft.id, draft.version, csrfToken);
      setNotice(result.notice);
      drafts.reload();
    });

  if (settings.error || drafts.error) return <Notice tone="error" title={(settings.error ?? drafts.error).message} />;
  if (!settings.data || !drafts.data) return <LoadingBlock label="Loading offers…" />;

  return (
    <div className="space-y-4">
      {notice && <Notice tone="success" title={notice} onDismiss={() => setNotice(null)} />}
      {problem && <ImportProblems problem={problem} onDismiss={() => setProblem(null)} />}
      {sendResults && <SendResults results={sendResults} drafts={list} onDismiss={() => setSendResults(null)} />}

      <Card
        title="Offers"
        subtitle="Prepared offers wait here for review. Nothing reaches a candidate until it is sent."
        actions={
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="Offer CSV file"
              onChange={(changeEvent) => {
                const [file] = changeEvent.target.files;
                changeEvent.target.value = '';
                if (file) importFile(file);
              }}
            />
            <Button variant="secondary" onClick={() => fileInput.current.click()} isBusy={busy === 'import'}>
              <UploadIcon className="h-4 w-4" />
              Import CSV
            </Button>
            <Button onClick={() => setIsComposing(true)}>
              <PlusIcon className="h-4 w-4" />
              New offer
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        {list.length === 0 ? (
          <div className="p-6">
            <EmptyState
              Icon={DocumentIcon}
              title="No offers yet"
              description="Prepare one with New offer, or import many from a CSV."
            />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <p className="text-sm text-slate-600">
                {selectedIds.length} selected · at most {bulkSendMax} at a time
              </p>
              <Button
                size="sm"
                onClick={sendSelected}
                disabled={selectedIds.length === 0 || selectedIds.length > bulkSendMax}
                isBusy={busy === 'bulk'}
              >
                Send selected
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead className="border-b border-slate-100 text-xs text-slate-500">
                  <tr>
                    <th className="w-10 px-4 py-2" scope="col">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="px-3 py-2 text-left font-medium" scope="col">
                      Candidate
                    </th>
                    <th className="px-3 py-2 text-left font-medium" scope="col">
                      Role
                    </th>
                    <th className="px-3 py-2 text-right font-medium" scope="col">
                      CTC
                    </th>
                    <th className="px-3 py-2 text-left font-medium" scope="col">
                      Joining
                    </th>
                    <th className="px-3 py-2 text-left font-medium" scope="col">
                      Status
                    </th>
                    <th className="px-3 py-2 text-right font-medium" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((draft) => {
                    const canSend = SENDABLE_STATUSES.includes(draft.status);
                    const status = OFFER_STATUS_DISPLAY[draft.status];
                    const lifecycle = LIFECYCLE_DISPLAY[draft.lifecycle];
                    return (
                      <tr key={draft.id} aria-label={draft.candidate.name}>
                        <td className="px-4 py-3">
                          {canSend && (
                            <input
                              type="checkbox"
                              checked={selected.has(draft.id)}
                              onChange={() => toggle(draft.id)}
                              aria-label={`Select ${draft.candidate.name}`}
                              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                            />
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className="block font-medium text-slate-900">{draft.candidate.name}</span>
                          <span className="block text-xs text-slate-500">{draft.candidate.personalEmail}</span>
                        </td>
                        <td className="px-3 py-3 text-slate-700">{draft.position.designation}</td>
                        <td className="px-3 py-3 text-right text-slate-900 tabular-nums">
                          {formatInr(draft.compensation.annualCtc)}
                        </td>
                        <td className="px-3 py-3 text-slate-700">{formatDate(draft.position.dateOfJoining)}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            <Badge tone={status.tone}>{status.label}</Badge>
                            {lifecycle && draft.lifecycle !== OFFER_LIFECYCLE_INVITED && (
                              <Badge tone={lifecycle.tone}>{lifecycle.label}</Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-1.5">
                            {canSend && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => previewDraft(draft)}
                                isBusy={busy === `preview-${draft.id}`}
                              >
                                Preview
                              </Button>
                            )}
                            {canSend && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => sendDraft(draft)}
                                isBusy={busy === `send-${draft.id}`}
                              >
                                Send
                              </Button>
                            )}
                            {draft.status === OFFER_STATUSES.PENDING_REVIEW && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => cancelDraft(draft)}
                                isBusy={busy === `cancel-${draft.id}`}
                              >
                                Cancel
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {isComposing && (
        <OfferFormDialog
          options={options}
          settings={settings.data.settings}
          choices={settings.data.choices}
          onClose={() => setIsComposing(false)}
          onSaved={(draft, message) => {
            setIsComposing(false);
            setNotice(message);
            drafts.reload();
          }}
        />
      )}
      {preview && (
        <OfferPreviewDialog
          preview={preview.preview}
          candidateName={preview.candidateName}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
