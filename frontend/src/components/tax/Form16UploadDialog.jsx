/**
 * The CA's computation and upload dialog (Form 16 portal → an employee): on one side the employee's
 * annual CTC and its split (from their offer, while the CTC is still the offer's) and the TDS on the
 * year's payslips by month; on the other the Form 16 upload (PDF, part, optional computation summary)
 * and the version history, each version downloadable.
 *
 * GET /api/tax/ca/employees/:employeeId?fy= (404 for anyone at or below the threshold) and
 * POST …/form16. Every message shown is the backend's.
 */

import { useState } from 'react';
import { requestCaEmployee, requestForm16Download, requestForm16Upload } from '../../api/taxApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  FORM16_CTC_SPLIT_LINES,
  FORM16_PART_LABELS,
  FORM16_PART_TYPES,
  FORM16_SUMMARY_AMOUNTS,
  FORM16_TAX_REGIME_LABELS,
} from '../../constants/form16.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { summaryRequestFrom } from '../../utils/form16.js';
import Dialog from '../Dialog.jsx';
import { DownloadIcon } from '../Icons.jsx';
import {
  Badge,
  Button,
  Field,
  LoadingBlock,
  Notice,
  SelectInput,
  TextInput,
  formatDate,
  formatInr,
  openSignedUrl,
} from '../ui.jsx';

const EMPTY_SUMMARY = Object.freeze({
  grossSalary: '',
  totalDeductions: '',
  taxableIncome: '',
  totalTaxPayable: '',
  tdsDeducted: '',
  taxRegime: '',
  caRemarks: '',
});
const PART_OPTIONS = Object.values(FORM16_PART_TYPES).map((value) => ({ value, label: FORM16_PART_LABELS[value] }));
const REGIME_OPTIONS = [
  { value: '', label: 'Not stated' },
  ...Object.entries(FORM16_TAX_REGIME_LABELS).map(([value, label]) => ({ value, label })),
];

function Panel({ title, children }) {
  return (
    <section className="rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
      <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function FigureRow({ label, amount, isTotal = false }) {
  return (
    <div
      className={`flex justify-between gap-3 py-1.5 text-sm ${isTotal ? 'border-t border-slate-200 font-semibold' : ''}`}
    >
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium text-slate-900 tabular-nums">{formatInr(amount)}</dd>
    </div>
  );
}

function CompensationSide({ detail }) {
  const { ctc, taxDeducted } = detail;
  return (
    <div className="space-y-4">
      <Panel title="Annual CTC">
        <p className="text-2xl font-bold text-slate-900 tabular-nums" data-testid="form16-annual-ctc">
          {formatInr(ctc.annualCtc)}
        </p>
        {ctc.effectiveFrom && <p className="mt-1 text-xs text-slate-500">From {formatDate(ctc.effectiveFrom)}</p>}
        {ctc.split ? (
          <dl className="mt-3">
            {FORM16_CTC_SPLIT_LINES.filter((line) => line.isTotal || ctc.split[line.field] > 0).map((line) => (
              <FigureRow key={line.field} label={line.label} amount={ctc.split[line.field]} isTotal={line.isTotal} />
            ))}
          </dl>
        ) : (
          <p className="mt-3 text-xs text-slate-500">The split is shown for employees hired through an offer.</p>
        )}
      </Panel>
      <Panel title={`TDS on payslips, FY ${detail.financialYear}`}>
        {taxDeducted.months.length === 0 ? (
          <p className="text-sm text-slate-500">No payslips issued this year.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1 font-medium">Month</th>
                <th className="py-1 text-right font-medium">Gross</th>
                <th className="py-1 text-right font-medium">TDS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {taxDeducted.months.map((month) => (
                <tr key={month.period}>
                  <td className="py-1.5 text-slate-700">{month.period}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatInr(month.grossEarnings)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatInr(month.tds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className="mt-2">
          <FigureRow label="Year to date TDS" amount={taxDeducted.totals.tds} isTotal />
        </dl>
      </Panel>
    </div>
  );
}

function VersionHistory({ history, onDownload, downloadingId }) {
  if (history.length === 0) return <p className="text-sm text-slate-500">Nothing uploaded for this year yet.</p>;
  return (
    <ul className="divide-y divide-slate-100" data-testid="form16-history">
      {history.map((document) => (
        <li key={document.id} className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-800">
              v{document.version} · {FORM16_PART_LABELS[document.partType]}
            </p>
            <p className="truncate text-xs text-slate-500">
              {document.fileName} · {formatDate(document.uploadedAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={document.status === 'ACTIVE' ? 'emerald' : 'slate'}>
              {document.status === 'ACTIVE' ? 'Active' : 'Superseded'}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDownload(document.id)}
              isBusy={downloadingId === document.id}
              aria-label={`Download version ${document.version}`}
            >
              <DownloadIcon className="h-4 w-4" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Form16UploadDialog({ employeeId, employeeName, financialYear, onUploaded, onClose }) {
  const { csrfToken } = useAuth();
  const detail = useApiResource(
    (signal) => requestCaEmployee(employeeId, financialYear, signal),
    [employeeId, financialYear],
  );
  const [file, setFile] = useState(null);
  const [partType, setPartType] = useState(FORM16_PART_TYPES.CONSOLIDATED);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [problem, setProblem] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  const setSummaryField = (field) => (changeEvent) => setSummary({ ...summary, [field]: changeEvent.target.value });
  const errorOf = (field) => problem?.fieldErrors?.[field] ?? problem?.fieldErrors?.[`computationSummary.${field}`];

  async function upload() {
    if (!file) return;
    setIsUploading(true);
    setProblem(null);
    setSuccess(null);
    try {
      const result = await requestForm16Upload(
        { employeeId, financialYear, partType, computationSummary: summaryRequestFrom(summary), file },
        csrfToken,
      );
      setSuccess(`Version ${result.document.version} uploaded`);
      setFile(null);
      setSummary(EMPTY_SUMMARY);
      setFileInputKey((key) => key + 1);
      detail.reload();
      onUploaded();
    } catch (uploadError) {
      setProblem(toDisplayError(uploadError));
    } finally {
      setIsUploading(false);
    }
  }

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

  return (
    <Dialog title={`Form 16 · ${employeeName} · FY ${financialYear}`} size="xl" onClose={onClose}>
      <div data-testid="form16-upload-dialog">
        {detail.isLoading && !detail.data && <LoadingBlock />}
        {detail.error && <Notice tone="error" title={detail.error.message} />}
        {detail.data && (
          <div className="grid gap-5 lg:grid-cols-2">
            <CompensationSide detail={detail.data} />
            <div className="space-y-4">
              <form
                className="space-y-4"
                onSubmit={(submitEvent) => {
                  submitEvent.preventDefault();
                  upload();
                }}
              >
                <Panel title="Upload Form 16">
                  <div className="space-y-3">
                    {problem && <Notice tone="error" title={problem.message} />}
                    {success && <Notice tone="success" title={success} />}
                    <Field label="Form 16 PDF" hint="PDF, at most 10 MB" error={errorOf('file')}>
                      {(controlId) => (
                        <input
                          key={fileInputKey}
                          id={controlId}
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(changeEvent) => setFile(changeEvent.target.files?.[0] ?? null)}
                          className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-brand-700 hover:file:bg-brand-100"
                        />
                      )}
                    </Field>
                    <SelectInput
                      label="Part"
                      value={partType}
                      onChange={(changeEvent) => setPartType(changeEvent.target.value)}
                      options={PART_OPTIONS}
                      error={errorOf('partType')}
                    />
                  </div>
                </Panel>
                <Panel title="Computation summary (optional)">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {FORM16_SUMMARY_AMOUNTS.map(({ field, label }) => (
                      <TextInput
                        key={field}
                        label={label}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={summary[field]}
                        onChange={setSummaryField(field)}
                        error={errorOf(field)}
                      />
                    ))}
                    <SelectInput
                      label="Tax regime"
                      value={summary.taxRegime}
                      onChange={setSummaryField('taxRegime')}
                      options={REGIME_OPTIONS}
                      error={errorOf('taxRegime')}
                    />
                  </div>
                  <Field label="CA remarks" error={errorOf('caRemarks')} className="mt-3">
                    {(controlId, className) => (
                      <textarea
                        id={controlId}
                        rows={3}
                        maxLength={1000}
                        value={summary.caRemarks}
                        onChange={setSummaryField('caRemarks')}
                        className={`${className} resize-y`}
                      />
                    )}
                  </Field>
                </Panel>
                <div className="flex justify-end">
                  <Button type="submit" disabled={!file} isBusy={isUploading}>
                    Upload Form 16
                  </Button>
                </div>
              </form>
              <Panel title="Version history">
                <VersionHistory history={detail.data.history} onDownload={download} downloadingId={downloadingId} />
              </Panel>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
