/**
 * Employee CSV import (HR and admins), in three steps:
 *
 *   1. Upload    POST /api/employees/bulk-upload: the file is checked row by row; nobody is created
 *   2. Review    the problems per row and the departments the file adds, then start the import
 *                (POST /:jobId/confirm). Rows with problems are skipped; fix them and upload again.
 *   3. Follow    GET /:jobId every IMPORT_POLL_INTERVAL_MS while it runs, then every row's outcome
 *                (GET /:jobId/results) with a CSV download.
 *
 * Each imported person gets an employee ID, a company email and an invitation. When the invitation
 * could not be emailed, its activation link is in the results for HR to share; it is kept only in
 * this page's memory and the downloaded file, never in the browser's storage.
 */

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  requestEmployeeImport,
  requestEmployeeImportResults,
  requestEmployeeImportStart,
  requestEmployeeImportUpload,
  requestEmployeeImports,
} from '../../api/peopleApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  IMPORT_ACTIVE_STATUSES,
  IMPORT_COLUMN_GUIDE,
  IMPORT_DELIVERY_DISPLAY,
  IMPORT_JOB_STATUS_DISPLAY,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_POLL_INTERVAL_MS,
  IMPORT_ROW_STATUS_DISPLAY,
  IMPORT_TEMPLATE_COLUMNS,
  IMPORT_TEMPLATE_EXAMPLE_ROWS,
  IMPORT_TEMPLATE_FILE_NAME,
} from '../../constants/employeeImport.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { downloadCsv, toCsv } from '../../utils/csv.js';
import { DocumentIcon, DownloadIcon, UploadIcon } from '../Icons.jsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  Notice,
  ProgressBar,
  formatBytes,
  formatDateTime,
} from '../ui.jsx';

function downloadTemplate() {
  downloadCsv(IMPORT_TEMPLATE_FILE_NAME, toCsv(IMPORT_TEMPLATE_COLUMNS, IMPORT_TEMPLATE_EXAMPLE_ROWS));
}

function downloadResults(job, rows) {
  const header = [
    'row',
    'name',
    'personal_email',
    'department_code',
    'status',
    'employee_id',
    'company_email',
    'invitation',
    'activation_link',
    'problems',
  ];
  const dataRows = rows.map((row) => [
    row.rowNumber,
    row.name,
    row.personalEmail,
    row.departmentCode,
    IMPORT_ROW_STATUS_DISPLAY[row.status]?.label ?? row.status,
    row.employeeCode,
    row.companyEmail,
    row.delivery ? (IMPORT_DELIVERY_DISPLAY[row.delivery] ?? row.delivery) : '',
    row.activationLink,
    [...row.issues.map((issue) => `${issue.field}: ${issue.message}`), row.message].filter(Boolean).join('; '),
  ]);
  const baseName = job.fileName.replace(/\.csv$/i, '');
  downloadCsv(`${baseName}-results.csv`, toCsv(header, dataRows));
}

// --- Step 1: upload ---------------------------------------------------------------------------------

function UploadCard({ onChecked }) {
  const { csrfToken } = useAuth();
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  async function uploadFile(candidateFile) {
    setUploadError(null);
    if (!candidateFile) return;
    if (!candidateFile.name.toLowerCase().endsWith('.csv')) {
      setUploadError({ message: 'Choose a .csv file. In Excel or Google Sheets, use “Save as / Download → CSV”.' });
      return;
    }
    if (candidateFile.size > IMPORT_MAX_FILE_BYTES) {
      setUploadError({
        message: `The file is ${formatBytes(candidateFile.size)}; the limit is ${formatBytes(IMPORT_MAX_FILE_BYTES)}.`,
      });
      return;
    }
    setIsUploading(true);
    try {
      const { job } = await requestEmployeeImportUpload(candidateFile, csrfToken);
      onChecked(job);
    } catch (caughtError) {
      setUploadError(toDisplayError(caughtError));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <Card
      title="Import employees from a CSV"
      subtitle="The file is checked first; nobody is added until you start the import."
      actions={
        <Button variant="secondary" size="sm" onClick={downloadTemplate}>
          <DownloadIcon className="h-4 w-4" /> Download template
        </Button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <label
            onDragOver={(dragEvent) => {
              dragEvent.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(dropEvent) => {
              dropEvent.preventDefault();
              setIsDragging(false);
              if (!isUploading) uploadFile(dropEvent.dataTransfer.files?.[0]);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${isDragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50/60 hover:border-brand-400'}`}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-brand-600 shadow-sm ring-1 ring-slate-200">
              <UploadIcon className="h-6 w-6" />
            </span>
            <span className="mt-3 text-sm font-semibold text-slate-800">
              {isUploading ? 'Checking the file…' : 'Drop a CSV file or click to browse'}
            </span>
            <span className="mt-1 text-xs text-slate-500">
              One row per person · up to {formatBytes(IMPORT_MAX_FILE_BYTES)}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="Employee CSV file"
              disabled={isUploading}
              onChange={(changeEvent) => uploadFile(changeEvent.target.files?.[0])}
            />
          </label>
          {uploadError && <Notice tone="error" title={uploadError.message} onDismiss={() => setUploadError(null)} />}
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">Columns</p>
          <dl className="mt-2 space-y-2 text-sm">
            {IMPORT_COLUMN_GUIDE.map(({ column, meaning }) => (
              <div key={column}>
                <dt className="font-mono text-xs text-slate-900">{column}</dt>
                <dd className="text-xs text-slate-500">{meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Card>
  );
}

// --- Steps 2 and 3: review, follow, results -----------------------------------------------------------

function CountBadges({ counts }) {
  const entries = [
    ['Rows', counts.total, 'slate'],
    ['Ready', counts.valid, 'emerald'],
    ['With problems', counts.invalid, counts.invalid > 0 ? 'rose' : 'slate'],
    ['Invited', counts.created, 'brand'],
    ['Failed', counts.failed, counts.failed > 0 ? 'rose' : 'slate'],
    ['Emailed', counts.emailed, 'sky'],
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([label, value, tone]) => (
        <Badge key={label} tone={tone}>
          {label}: {value}
        </Badge>
      ))}
    </div>
  );
}

function ReviewSection({ job, onStarted }) {
  const { csrfToken } = useAuth();
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState(null);

  async function startImport() {
    setIsStarting(true);
    setStartError(null);
    try {
      const { job: startedJob } = await requestEmployeeImportStart(job.id, csrfToken);
      onStarted(startedJob);
    } catch (caughtError) {
      setStartError(toDisplayError(caughtError));
    } finally {
      setIsStarting(false);
    }
  }

  const readyCount = job.counts.valid;
  return (
    <div className="space-y-5">
      {job.ignoredColumns?.length > 0 && (
        <Notice tone="info" title="Some columns were not recognised and are ignored">
          {job.ignoredColumns.join(', ')}
        </Notice>
      )}
      {job.departmentsToCreate.length > 0 && (
        <Notice tone="info" title="These departments are new and will be created">
          {job.departmentsToCreate.map((department) => `${department.name} (${department.code})`).join(', ')}
        </Notice>
      )}
      {job.issues.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Problems ({job.counts.invalid} {job.counts.invalid === 1 ? 'row' : 'rows'} will be skipped)
          </p>
          <div className="mt-2 max-h-80 overflow-auto rounded-xl ring-1 ring-slate-200 scroll-thin">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-3 py-2 font-semibold">Line</th>
                  <th className="px-3 py-2 font-semibold">Column</th>
                  <th className="px-3 py-2 font-semibold">Problem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {job.issues.map((issue) => (
                  <tr key={`${issue.rowNumber}-${issue.field}-${issue.message}`}>
                    <td className="px-3 py-2 text-slate-500">{issue.rowNumber}</td>
                    <td className="px-3 py-2 font-mono text-xs">{issue.field}</td>
                    <td className="px-3 py-2 text-slate-700">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {startError && <Notice tone="error" title={startError.message} onDismiss={() => setStartError(null)} />}
      {readyCount === 0 ? (
        <Notice tone="warning" title="No row can be imported">
          Fix the problems in your file and upload it again.
        </Notice>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {job.counts.invalid > 0 && (
            <p className="text-xs text-slate-500">You can also fix the file and upload it again instead.</p>
          )}
          <Button onClick={startImport} isBusy={isStarting}>
            Import {readyCount} {readyCount === 1 ? 'person' : 'people'}
          </Button>
        </div>
      )}
    </div>
  );
}

function CopyLinkButton({ link }) {
  const [hasCopied, setHasCopied] = useState(false);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setHasCopied(true);
    } catch {
      setHasCopied(false);
    }
  }
  return (
    <Button size="sm" variant="secondary" onClick={copyLink}>
      {hasCopied ? 'Copied ✓' : 'Copy link'}
    </Button>
  );
}

function ResultsSection({ job }) {
  const resultsResource = useApiResource((signal) => requestEmployeeImportResults(job.id, signal), [job.id]);
  const rows = resultsResource.data?.rows ?? [];
  const linksToShare = rows.filter((row) => row.activationLink).length;

  if (resultsResource.isLoading && !resultsResource.data) return <LoadingBlock label="Loading results…" />;
  if (resultsResource.error) return <Notice tone="error" title={resultsResource.error.message} />;
  return (
    <div className="space-y-4">
      {linksToShare > 0 && (
        <Notice
          tone="warning"
          title={`${linksToShare} invitation ${linksToShare === 1 ? 'link was' : 'links were'} not emailed`}
        >
          Share each link with its person yourself (the downloaded file has them all). Each link works once.
        </Notice>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => downloadResults(job, rows)}>
          <DownloadIcon className="h-4 w-4" /> Download results
        </Button>
      </div>
      <div className="max-h-[32rem] overflow-auto rounded-xl ring-1 ring-slate-200 scroll-thin">
        <table className="min-w-full text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-3 py-2 font-semibold">Line</th>
              <th className="px-3 py-2 font-semibold">Person</th>
              <th className="px-3 py-2 font-semibold">Employee ID</th>
              <th className="px-3 py-2 font-semibold">Company email</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Invitation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => {
              const statusDisplay = IMPORT_ROW_STATUS_DISPLAY[row.status] ?? { label: row.status, tone: 'slate' };
              const problem = row.issues.map((issue) => issue.message).join('; ') || row.message;
              return (
                <tr key={row.rowNumber} className="align-top">
                  <td className="px-3 py-2 text-slate-500">{row.rowNumber}</td>
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-900">{row.name || '—'}</p>
                    <p className="text-xs text-slate-500">{row.personalEmail || '—'}</p>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.employeeCode ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{row.companyEmail ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
                    {problem && <p className="mt-1 max-w-xs text-xs text-rose-700">{problem}</p>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {row.delivery && <p>{IMPORT_DELIVERY_DISPLAY[row.delivery] ?? row.delivery}</p>}
                    {row.activationLink && (
                      <div className="mt-1">
                        <CopyLinkButton link={row.activationLink} />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImportJobCard({ initialJob, onClose, onFinished }) {
  const [job, setJob] = useState(initialJob);
  const [pollError, setPollError] = useState(null);
  const isActive = IMPORT_ACTIVE_STATUSES.includes(job.status);
  const notifyFinished = useEffectEvent(() => onFinished());

  // A job opened from the list comes without its problems; load it whole once.
  useEffect(() => {
    if (initialJob.issues?.length || initialJob.counts.invalid === 0) return undefined;
    const loadController = new AbortController();
    requestEmployeeImport(initialJob.id, loadController.signal)
      .then(({ job: fullJob }) => setJob((previousJob) => ({ ...fullJob, ignoredColumns: previousJob.ignoredColumns })))
      .catch((caughtError) => {
        if (!loadController.signal.aborted) setPollError(toDisplayError(caughtError));
      });
    return () => loadController.abort();
  }, [initialJob]);

  // While the import runs, check it again every few seconds; stop when it finishes or on leaving.
  useEffect(() => {
    if (!isActive) return undefined;
    const pollController = new AbortController();
    const pollTimer = window.setTimeout(async () => {
      try {
        const { job: latestJob } = await requestEmployeeImport(job.id, pollController.signal);
        setPollError(null);
        setJob((previousJob) => ({ ...latestJob, ignoredColumns: previousJob.ignoredColumns }));
        if (!IMPORT_ACTIVE_STATUSES.includes(latestJob.status)) notifyFinished();
      } catch (caughtError) {
        if (pollController.signal.aborted) return;
        setPollError(toDisplayError(caughtError));
        // Try again on the next tick: a brief network blip should not stop the progress display.
        setJob((previousJob) => ({ ...previousJob }));
      }
    }, IMPORT_POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(pollTimer);
      pollController.abort();
    };
  }, [job, isActive]);

  const statusDisplay = IMPORT_JOB_STATUS_DISPLAY[job.status] ?? { label: job.status, tone: 'slate' };
  const processedCount = job.counts.created + job.counts.failed;
  const progressPercent = job.counts.valid > 0 ? (processedCount / job.counts.valid) * 100 : 0;
  return (
    <Card
      title={job.fileName}
      subtitle={`Uploaded ${formatDateTime(job.createdAt)} by ${job.createdBy.name}`}
      actions={
        <div className="flex items-center gap-3">
          <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Back to imports
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <CountBadges counts={job.counts} />
        {job.status === 'validated' && <ReviewSection job={job} onStarted={setJob} />}
        {isActive && (
          <div className="space-y-2">
            <ProgressBar value={progressPercent} label="Import progress" />
            <p className="text-xs text-slate-500">
              {processedCount} of {job.counts.valid} done. You can leave this page; the import keeps running.
            </p>
          </div>
        )}
        {pollError && <Notice tone="warning" title={`Could not refresh this import: ${pollError.message}`} />}
        {job.status === 'completed' && <ResultsSection job={job} />}
      </div>
    </Card>
  );
}

function RecentImports({ jobsResource, onOpen }) {
  const jobs = jobsResource.data?.jobs ?? [];
  return (
    <Card title="Recent imports" bodyClassName="p-0">
      {jobsResource.isLoading && !jobsResource.data && <LoadingBlock label="Loading imports…" />}
      {jobsResource.error && (
        <div className="p-6">
          <Notice tone="error" title={jobsResource.error.message} />
        </div>
      )}
      {jobsResource.data && jobs.length === 0 && (
        <div className="p-6">
          <EmptyState Icon={DocumentIcon} title="No imports yet" description="Uploaded files appear here." />
        </div>
      )}
      <ul className="divide-y divide-slate-100">
        {jobs.map((job) => {
          const statusDisplay = IMPORT_JOB_STATUS_DISPLAY[job.status] ?? { label: job.status, tone: 'slate' };
          return (
            <li key={job.id} className="flex flex-wrap items-center gap-4 px-5 py-3 sm:px-6">
              <div className="min-w-48 flex-1">
                <p className="text-sm font-semibold text-slate-900">{job.fileName}</p>
                <p className="text-xs text-slate-500">
                  {formatDateTime(job.createdAt)} · {job.createdBy.name} · {job.counts.total} rows, {job.counts.created}{' '}
                  invited
                </p>
              </div>
              <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
              <Button variant="secondary" size="sm" onClick={() => onOpen(job)}>
                Open
              </Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** `onImported` runs when an import finishes, so the page can refresh its invitations. */
export default function EmployeeImportPanel({ onImported }) {
  const jobsResource = useApiResource((signal) => requestEmployeeImports(signal), []);
  const [openJob, setOpenJob] = useState(null);

  function closeJob() {
    setOpenJob(null);
    jobsResource.reload();
  }

  if (openJob) {
    return <ImportJobCard key={openJob.id} initialJob={openJob} onClose={closeJob} onFinished={onImported} />;
  }
  return (
    <div className="space-y-6">
      <UploadCard onChecked={setOpenJob} />
      <RecentImports jobsResource={jobsResource} onOpen={setOpenJob} />
    </div>
  );
}
