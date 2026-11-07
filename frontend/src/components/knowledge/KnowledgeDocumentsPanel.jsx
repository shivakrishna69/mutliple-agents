/**
 * A department knowledge base's documents (GET/POST /api/departments/:departmentId/agent/documents,
 * DELETE .../documents/:docId):
 *
 *   - Drop files here or choose them (PDF, Word, Markdown, text: settings.limits). Each is uploaded on
 *     its own and the backend says how it went; it decides the type from the content, not the name.
 *   - The list refreshes itself every DOCUMENTS_REFRESH_INTERVAL_MS while any document is still being
 *     read and indexed, and stops when none is.
 *   - A failed document shows the backend's reason. Deleting asks first; a document whose delete had
 *     to wait for the index shows "Deleting" and can be deleted again.
 *   - While the agent is paused, no documents are taken.
 */

import { useEffect, useRef, useState } from 'react';
import {
  requestKnowledgeDocumentDeletion,
  requestKnowledgeDocumentUpload,
  requestKnowledgeDocuments,
} from '../../api/knowledgeApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  AGENT_STATUSES,
  DOCUMENTS_REFRESH_INTERVAL_MS,
  DOCUMENT_STATUS_DISPLAY,
  IN_PROGRESS_DOCUMENT_STATUSES,
} from '../../constants/knowledge.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { DocumentIcon, UploadIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, formatBytes, formatDateTime } from '../ui.jsx';

const DELETING_STATUS = 'DELETING';

function UploadDropzone({ limits, isPaused, isUploading, onFiles }) {
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const isDisabled = isPaused || isUploading;
  const extensions = limits.fileExtensions.map((extension) => `.${extension}`);

  return (
    <div
      onDragOver={(dragEvent) => {
        dragEvent.preventDefault();
        if (!isDisabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(dropEvent) => {
        dropEvent.preventDefault();
        setIsDragging(false);
        if (!isDisabled) onFiles([...(dropEvent.dataTransfer.files ?? [])]);
      }}
      className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition ${
        isDisabled
          ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-70'
          : isDragging
            ? 'border-brand-500 bg-brand-50'
            : 'border-slate-300 bg-slate-50/60 hover:border-brand-400'
      }`}
    >
      <UploadIcon className="h-8 w-8 text-brand-500" />
      <p className="mt-3 text-sm font-semibold text-slate-800">
        {isPaused
          ? 'This agent is paused: make it active in Settings to add documents'
          : isUploading
            ? 'Uploading…'
            : 'Drop documents here'}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {extensions.join(', ').toUpperCase()} · up to {formatBytes(limits.maxFileBytes)} each
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-4"
        disabled={isDisabled}
        onClick={() => fileInputRef.current?.click()}
      >
        Choose files
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={extensions.join(',')}
        className="sr-only"
        aria-label="Documents to upload"
        tabIndex={-1}
        disabled={isDisabled}
        onChange={(changeEvent) => {
          onFiles([...(changeEvent.target.files ?? [])]);
          changeEvent.target.value = '';
        }}
      />
    </div>
  );
}

function DocumentRow({ document, isDeleting, onDelete }) {
  const display = DOCUMENT_STATUS_DISPLAY[document.status];
  const isStuckDeleting = document.status === DELETING_STATUS;
  return (
    <>
      <tr className="align-top">
        <td className="px-5 py-3.5 sm:px-6">
          <p className="font-medium break-all text-slate-900">{document.originalName}</p>
          <p className="mt-0.5 text-xs text-slate-500">{formatBytes(document.fileSize)}</p>
        </td>
        <td className="px-3 py-3.5">
          <Badge tone={display.tone}>{display.label}</Badge>
        </td>
        <td className="px-3 py-3.5 text-slate-700 tabular-nums">{document.chunkCount}</td>
        <td className="px-3 py-3.5 text-slate-700">{document.uploadedBy?.name ?? '—'}</td>
        <td className="px-3 py-3.5 whitespace-nowrap text-slate-600">{formatDateTime(document.createdAt)}</td>
        <td className="px-5 py-3.5 text-right sm:px-6">
          <Button
            variant="ghost"
            size="sm"
            isBusy={isDeleting}
            onClick={() => onDelete(document)}
            aria-label={`${isStuckDeleting ? 'Delete again' : 'Delete'} ${document.originalName}`}
          >
            {isStuckDeleting ? 'Delete again' : 'Delete'}
          </Button>
        </td>
      </tr>
      {document.errorMessage && (
        <tr>
          <td colSpan={6} className="px-5 pb-3.5 sm:px-6">
            <Notice tone="error" title={`${document.originalName} could not be added`}>
              {document.errorMessage}
            </Notice>
          </td>
        </tr>
      )}
    </>
  );
}

export default function KnowledgeDocumentsPanel({ departmentId, settings }) {
  const { csrfToken } = useAuth();
  const documentsResource = useApiResource((signal) => requestKnowledgeDocuments(departmentId, signal), [departmentId]);
  const documents = documentsResource.data?.documents ?? [];
  const [uploadResults, setUploadResults] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);
  const isProcessing = documents.some((document) => IN_PROGRESS_DOCUMENT_STATUSES.includes(document.status));
  const { reload } = documentsResource;

  // While anything is still being read and indexed, look again shortly; stop when nothing is.
  useEffect(() => {
    if (!isProcessing || documentsResource.isLoading) return undefined;
    const timer = setTimeout(reload, DOCUMENTS_REFRESH_INTERVAL_MS);
    return () => clearTimeout(timer);
    // documentsResource.data: a new list (after each load) starts the next wait.
  }, [isProcessing, documentsResource.isLoading, reload, documentsResource.data]);

  async function uploadFiles(files) {
    if (files.length === 0) return;
    setIsUploading(true);
    setActionNotice(null);
    const results = [];
    for (const file of files) {
      try {
        const { message } = await requestKnowledgeDocumentUpload(departmentId, file, csrfToken);
        results.push({ fileName: file.name, tone: 'success', message });
      } catch (uploadError) {
        results.push({ fileName: file.name, tone: 'error', message: toDisplayError(uploadError).message });
      }
    }
    setUploadResults(results);
    setIsUploading(false);
    reload();
  }

  async function deleteDocument(document) {
    if (!window.confirm(`Remove ${document.originalName} from the knowledge base? The agent will no longer use it.`)) {
      return;
    }
    setDeletingId(document.id);
    setActionNotice(null);
    try {
      const { message } = await requestKnowledgeDocumentDeletion(departmentId, document.id, csrfToken);
      setActionNotice({ tone: 'success', message });
    } catch (deleteError) {
      setActionNotice({ tone: 'error', message: toDisplayError(deleteError).message });
    } finally {
      setDeletingId(null);
      reload();
    }
  }

  return (
    <div className="space-y-6">
      <Card
        title="Add documents"
        subtitle="Handbooks, policies and guides the agent should answer from. Each is read and indexed in the background."
      >
        <div className="space-y-4">
          <UploadDropzone
            limits={settings.limits}
            isPaused={settings.status !== AGENT_STATUSES.ACTIVE}
            isUploading={isUploading}
            onFiles={uploadFiles}
          />
          {uploadResults.length > 0 && (
            <ul className="space-y-2" aria-label="Upload results">
              {uploadResults.map((result, index) => (
                <li key={`${result.fileName}-${index}`}>
                  <Notice tone={result.tone} title={result.fileName}>
                    {result.message}
                  </Notice>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card
        title="Documents"
        subtitle={
          isProcessing
            ? 'Some documents are still being read; this list updates by itself.'
            : `${documents.length} of at most ${settings.limits.maxDocuments} documents.`
        }
        bodyClassName="p-0"
      >
        {actionNotice && (
          <div className="px-5 pt-5 sm:px-6">
            <Notice tone={actionNotice.tone} title={actionNotice.message} onDismiss={() => setActionNotice(null)} />
          </div>
        )}
        {documentsResource.isLoading && !documentsResource.data && <LoadingBlock label="Loading documents…" />}
        {documentsResource.error && (
          <div className="p-6">
            <Notice tone="error" title={documentsResource.error.message} />
          </div>
        )}
        {documentsResource.data && documents.length === 0 && (
          <div className="p-6">
            <EmptyState
              Icon={DocumentIcon}
              title="No documents yet"
              description="Add the first one above; it is ready for the agent within a minute or so."
            />
          </div>
        )}
        {documents.length > 0 && (
          <div className="relative overflow-x-auto scroll-thin">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-100 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-5 py-3 sm:px-6">
                    Document
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Chunks
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Uploaded by
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Uploaded
                  </th>
                  <th scope="col" className="px-5 py-3 sm:px-6">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {documents.map((document) => (
                  <DocumentRow
                    key={document.id}
                    document={document}
                    isDeleting={deletingId === document.id}
                    onDelete={deleteDocument}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
