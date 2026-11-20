/**
 * Payroll → Form 16 (VIEW_OWN_FORM16): the signed-in employee's own Form 16 for a financial year
 * (GET /api/tax/my-form16?fy=).
 *
 *   eligible, uploaded     the CA's computation summary and a download per document
 *   eligible, not yet      the backend's "pending" notice
 *   not eligible           the backend's note that Form 16 here applies above the CTC threshold
 *
 * Downloads are 60-second links (GET /api/tax/form16/:documentId/download).
 */

import { useState } from 'react';
import { requestForm16Download, requestForm16Years, requestMyForm16 } from '../../api/taxApi.js';
import { FORM16_PART_LABELS, FORM16_SUMMARY_AMOUNTS, FORM16_TAX_REGIME_LABELS } from '../../constants/form16.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { ClockIcon, DocumentIcon, DownloadIcon } from '../Icons.jsx';
import {
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  Notice,
  SelectInput,
  formatDate,
  formatInr,
  openSignedUrl,
} from '../ui.jsx';

function ComputationSummary({ summary }) {
  const figures = FORM16_SUMMARY_AMOUNTS.filter(({ field }) => summary[field] !== null);
  if (figures.length === 0 && !summary.taxRegime && !summary.caRemarks) return null;
  return (
    <div className="mt-4 space-y-3">
      {figures.length > 0 && (
        <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {figures.map(({ field, label }) => (
            <div key={field} className="rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/70">
              <dt className="text-xs text-slate-500">{label}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
                {formatInr(summary[field], { precise: true })}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {summary.taxRegime && <p className="text-sm text-slate-600">{FORM16_TAX_REGIME_LABELS[summary.taxRegime]}</p>}
      {summary.caRemarks && (
        <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-700 ring-1 ring-slate-200/70">
          <span className="font-semibold">CA remarks: </span>
          {summary.caRemarks}
        </p>
      )}
    </div>
  );
}

export default function MyForm16Panel() {
  const yearsResource = useApiResource((signal) => requestForm16Years(signal), []);
  const financialYears = yearsResource.data?.financialYears ?? [];
  const [chosenYear, setChosenYear] = useState(null);
  const financialYear = chosenYear ?? financialYears[0] ?? null;
  const form16 = useApiResource((signal) => requestMyForm16(financialYear, signal), [financialYear], {
    enabled: Boolean(financialYear),
  });
  const [downloadingId, setDownloadingId] = useState(null);
  const [problem, setProblem] = useState(null);

  async function download(documentId) {
    setDownloadingId(documentId);
    setProblem(null);
    try {
      const { download: signedDownload } = await requestForm16Download(documentId);
      openSignedUrl(signedDownload.downloadUrl);
    } catch (downloadError) {
      setProblem(toDisplayError(downloadError));
    } finally {
      setDownloadingId(null);
    }
  }

  const data = form16.data;
  return (
    <Card
      title="Form 16"
      subtitle={data ? `Financial year ${data.financialYear} · Assessment year ${data.assessmentYear}` : null}
      actions={
        financialYears.length > 0 && (
          <SelectInput
            label="Financial year"
            value={financialYear ?? ''}
            onChange={(changeEvent) => setChosenYear(changeEvent.target.value)}
            options={financialYears.map((year) => ({ value: year, label: `FY ${year}` }))}
            className="w-44"
          />
        )
      }
    >
      <div data-testid="my-form16">
        {(yearsResource.error || form16.error) && (
          <Notice tone="error" title={(yearsResource.error ?? form16.error).message} />
        )}
        {problem && <Notice tone="error" title={problem.message} />}
        {form16.isLoading && !data && <LoadingBlock label="Loading your Form 16…" />}
        {data && !data.eligible && <Notice tone="info" title={data.notice} />}
        {data?.eligible && data.documents.length === 0 && (
          <EmptyState title="Pending CA upload" description={data.notice} Icon={ClockIcon} />
        )}
        {data?.eligible &&
          data.documents.map((document) => (
            <div key={document.id} className="border-b border-slate-100 py-4 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                    <DocumentIcon className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{FORM16_PART_LABELS[document.partType]}</p>
                    <p className="text-xs text-slate-500">
                      Version {document.version} · uploaded {formatDate(document.uploadedAt)}
                    </p>
                  </div>
                </div>
                <Button onClick={() => download(document.id)} isBusy={downloadingId === document.id}>
                  <DownloadIcon className="h-4 w-4" />
                  Download Form 16 PDF
                </Button>
              </div>
              <ComputationSummary summary={document.computationSummary} />
            </div>
          ))}
      </div>
    </Card>
  );
}
