/**
 * Document self-service vault (/api/vault).
 *
 *   Everyone with an employee profile: list their own documents (employeeId "me"), upload new ones,
 *   and download through a short-lived signed URL (the browser never holds storage credentials;
 *   files are encrypted at rest and every access is audited by the backend).
 *   HR and admins: pick any employee, see the documents shared with their role, upload on the
 *   employee's behalf (choosing which roles may read it) and verify pending documents.
 *
 * Generated documents (payslips) live in Payroll; this panel links there.
 * Upload limits mirror the backend (PDF, JPEG or PNG, at most 10 MB); the backend re-checks the
 * real file type from its content, so the client-side check is only for fast feedback.
 */

import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { requestDocumentDownload, requestDocumentUpload, requestDocumentVerification, requestEmployeeDocuments, requestWorkforceRisk } from '../../api/workforceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ROUTE_PATHS, USER_ROLES } from '../../constants/routes.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { CheckBadgeIcon, DocumentIcon, DownloadIcon, ShieldIcon, UploadIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, SelectInput, formatBytes, formatDate, openSignedUrl } from '../ui.jsx';

const DOCUMENT_TYPES = Object.freeze([
  { value: 'Offer_Letter', label: 'Offer letter' },
  { value: 'Appraisal_Doc', label: 'Appraisal document' },
  { value: 'Gov_ID', label: 'Government ID' },
]);
const DOCUMENT_TYPE_LABELS = Object.fromEntries(DOCUMENT_TYPES.map((documentType) => [documentType.value, documentType.label]));
const ACCEPTED_CONTENT_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function UploadDropzone({ employeeId, canChooseRoles, onUploaded }) {
  const { csrfToken } = useAuth();
  const fileInputRef = useRef(null);
  const [chosenFile, setChosenFile] = useState(null);
  const [documentType, setDocumentType] = useState(DOCUMENT_TYPES[0].value);
  const [accessibleRoles, setAccessibleRoles] = useState(['hr']);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  function chooseFile(candidateFile) {
    setUploadError(null);
    if (!candidateFile) return;
    if (!ACCEPTED_CONTENT_TYPES.includes(candidateFile.type)) {
      setUploadError({ message: 'Only PDF, JPEG or PNG files can be stored.' });
      return;
    }
    if (candidateFile.size > MAX_FILE_BYTES) {
      setUploadError({ message: `The file is ${formatBytes(candidateFile.size)}; the limit is 10 MB.` });
      return;
    }
    setChosenFile(candidateFile);
  }

  async function handleUpload() {
    setIsUploading(true);
    setUploadError(null);
    try {
      await requestDocumentUpload({ file: chosenFile, employeeId, documentType, accessibleRoles: canChooseRoles ? accessibleRoles : undefined }, csrfToken);
      setChosenFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onUploaded();
    } catch (caughtError) {
      setUploadError(toDisplayError(caughtError));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      <label
        onDragOver={(dragEvent) => { dragEvent.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(dropEvent) => { dropEvent.preventDefault(); setIsDragging(false); chooseFile(dropEvent.dataTransfer.files?.[0]); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-slate-50/60 hover:border-indigo-400'}`}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200">
          <UploadIcon className="h-6 w-6" />
        </span>
        <span className="mt-3 text-sm font-semibold text-slate-800">{chosenFile ? chosenFile.name : 'Drop a file or click to browse'}</span>
        <span className="mt-1 text-xs text-slate-500">{chosenFile ? formatBytes(chosenFile.size) : 'PDF, JPEG or PNG · up to 10 MB'}</span>
        <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" className="sr-only" onChange={(changeEvent) => chooseFile(changeEvent.target.files?.[0])} />
      </label>
      <SelectInput label="Document type" value={documentType} onChange={(changeEvent) => setDocumentType(changeEvent.target.value)} options={DOCUMENT_TYPES} />
      {canChooseRoles && (
        <fieldset>
          <legend className="text-xs font-semibold tracking-wide text-slate-600 uppercase">Also readable by</legend>
          <div className="mt-2 flex gap-3">
            {['hr', 'admin'].map((roleName) => (
              <label key={roleName} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200">
                <input
                  type="checkbox"
                  checked={accessibleRoles.includes(roleName)}
                  onChange={(changeEvent) => setAccessibleRoles(changeEvent.target.checked ? [...accessibleRoles, roleName] : accessibleRoles.filter((existingRole) => existingRole !== roleName))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                {roleName === 'hr' ? 'HR' : 'Admins'}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {uploadError && <Notice tone="error" title={uploadError.message} onDismiss={() => setUploadError(null)} />}
      <Button className="w-full" onClick={handleUpload} isBusy={isUploading} disabled={!chosenFile}>
        <ShieldIcon className="h-4 w-4" /> Upload securely
      </Button>
    </div>
  );
}

function DocumentRow({ vaultDocument, canVerify, onChanged }) {
  const { csrfToken } = useAuth();
  const [busyAction, setBusyAction] = useState(null);
  const [rowError, setRowError] = useState(null);

  async function handleDownload() {
    setBusyAction('download');
    setRowError(null);
    try {
      const { download } = await requestDocumentDownload(vaultDocument.id);
      openSignedUrl(download.url);
    } catch (downloadError) {
      setRowError(toDisplayError(downloadError));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleVerify() {
    setBusyAction('verify');
    setRowError(null);
    try {
      await requestDocumentVerification(vaultDocument.id, csrfToken);
      onChanged();
    } catch (verifyError) {
      setRowError(toDisplayError(verifyError));
    } finally {
      setBusyAction(null);
    }
  }

  const isVerified = vaultDocument.status === 'Verified';
  return (
    <li className="p-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-4">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${vaultDocument.contentType === 'application/pdf' ? 'bg-rose-50 text-rose-600' : 'bg-sky-50 text-sky-600'}`}>
          <DocumentIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-slate-900">{vaultDocument.originalFileName}</p>
          <p className="text-xs text-slate-500">
            {DOCUMENT_TYPE_LABELS[vaultDocument.documentType] ?? vaultDocument.documentType} · {formatBytes(vaultDocument.sizeBytes)} · {formatDate(vaultDocument.createdAt)}
          </p>
          <p className="mt-0.5 truncate font-mono text-[0.65rem] text-slate-400" title={`SHA-256 ${vaultDocument.sha256Checksum}`}>
            sha256 {vaultDocument.sha256Checksum?.slice(0, 16)}…
          </p>
        </div>
        <Badge tone={isVerified ? 'emerald' : 'amber'}>{isVerified ? 'Verified' : 'Pending verification'}</Badge>
        <div className="flex gap-2">
          {canVerify && !isVerified && (
            <Button variant="success" size="sm" isBusy={busyAction === 'verify'} disabled={busyAction !== null} onClick={handleVerify}>
              <CheckBadgeIcon className="h-4 w-4" /> Verify
            </Button>
          )}
          <Button variant="secondary" size="sm" isBusy={busyAction === 'download'} disabled={busyAction !== null} onClick={handleDownload}>
            <DownloadIcon className="h-4 w-4" /> Open
          </Button>
        </div>
      </div>
      {rowError && (
        <div className="mt-3">
          <Notice tone="error" title={rowError.message} onDismiss={() => setRowError(null)} />
        </div>
      )}
    </li>
  );
}

export default function DocumentVaultPanel() {
  const { currentUser } = useAuth();
  const isRecordsAdmin = [USER_ROLES.ADMIN, USER_ROLES.HR].includes(currentUser.role);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('me');
  const documentsResource = useApiResource((signal) => requestEmployeeDocuments(selectedEmployeeId, signal), [selectedEmployeeId]);
  const rosterResource = useApiResource((signal) => requestWorkforceRisk({ limit: 500 }, signal), [], { enabled: isRecordsAdmin });

  const employeeOptions = useMemo(
    () => [
      { value: 'me', label: 'My documents' },
      ...[...(rosterResource.data?.employees ?? [])]
        .sort((first, second) => (first.name ?? '').localeCompare(second.name ?? ''))
        .map((employee) => ({ value: employee.employeeId, label: `${employee.name ?? 'Unnamed'} · ${employee.designation ?? ''}` })),
    ],
    [rosterResource.data],
  );

  const resolvedEmployeeId = documentsResource.data?.meta?.employeeId ?? (selectedEmployeeId === 'me' ? null : selectedEmployeeId);
  const documents = documentsResource.data?.documents ?? [];
  const isOwnVault = selectedEmployeeId === 'me';
  const hasNoProfile = isOwnVault && documentsResource.error?.status === 404;

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        {isRecordsAdmin && (
          <SelectInput label="Employee" value={selectedEmployeeId} onChange={(changeEvent) => setSelectedEmployeeId(changeEvent.target.value)} options={employeeOptions} className="max-w-md" />
        )}
        <Card title={isOwnVault ? 'My documents' : 'Employee documents'} subtitle="Encrypted at rest · every access is audited · links expire after a minute" bodyClassName="p-0">
          {documentsResource.isLoading && !documentsResource.data && <LoadingBlock label="Loading documents…" />}
          {hasNoProfile && (
            <div className="p-6">
              <EmptyState Icon={DocumentIcon} title="No employee profile" description="The document vault is available once HR links your account to an employee profile." />
            </div>
          )}
          {documentsResource.error && !hasNoProfile && (
            <div className="p-6">
              <Notice tone="error" title={documentsResource.error.message} />
            </div>
          )}
          {documentsResource.data && documents.length === 0 && (
            <div className="p-6">
              <EmptyState Icon={DocumentIcon} title="No documents yet" description={isOwnVault ? 'Upload your ID or letters; HR verifies them.' : 'Nothing has been shared with your role for this employee.'} />
            </div>
          )}
          {documents.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {documents.map((vaultDocument) => (
                <DocumentRow key={vaultDocument.id} vaultDocument={vaultDocument} canVerify={isRecordsAdmin && !isOwnVault} onChanged={documentsResource.reload} />
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="space-y-6">
        {resolvedEmployeeId && (
          <Card title="Upload a document" subtitle={isOwnVault ? 'Stored in your personal vault' : 'Stored in the selected employee’s vault'}>
            <UploadDropzone employeeId={resolvedEmployeeId} canChooseRoles={isRecordsAdmin} onUploaded={documentsResource.reload} />
          </Card>
        )}
        <Card title="Generated documents">
          <p className="text-sm text-slate-600">Payslips are generated as signed PDFs with a public verification ID.</p>
          <Link to={ROUTE_PATHS.PAYROLL} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-indigo-600 hover:text-indigo-500">
            {isRecordsAdmin ? 'Generate or view payslips' : 'View my payslips'} →
          </Link>
        </Card>
      </div>
    </div>
  );
}
