/**
 * An executed case's three documents: each step as it is prepared (queued, in progress, ready, from
 * OFFBOARDING_PROGRESS events or the case as read), and a download button for each ready document this
 * person may download (a 60-second signed link from GET /api/nsk-bot/artifacts/:id/download).
 */

import { useState } from 'react';
import { requestArtifactDownload } from '../../api/nskBotApi.js';
import {
  ARTIFACT_DISPLAY,
  ARTIFACT_KINDS,
  OFFBOARDING_LABELS as L,
  OFFBOARDING_STATUS_DISPLAY,
  OFFBOARDING_STATUSES,
} from '../../constants/nskBot.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { CheckBadgeIcon, DownloadIcon } from '../Icons.jsx';
import { Badge, Button, Notice, Spinner, openSignedUrl } from '../ui.jsx';

function stepState(offboardingCase, kind) {
  if (offboardingCase.artifacts.some((artifact) => artifact.kind === kind)) return 'ready';
  if (offboardingCase.progress?.currentStep === kind) return 'working';
  return 'waiting';
}

/** @param {{ offboardingCase: object }} props */
export default function OffboardingDocuments({ offboardingCase }) {
  const [downloadingId, setDownloadingId] = useState(null);
  const [error, setError] = useState(null);
  const status = OFFBOARDING_STATUS_DISPLAY[offboardingCase.status];

  async function download(artifact) {
    setDownloadingId(artifact.id);
    setError(null);
    try {
      const { download: link } = await requestArtifactDownload(artifact.id);
      openSignedUrl(link.url);
    } catch (downloadError) {
      setError(toDisplayError(downloadError).message);
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="space-y-2" data-testid="offboarding-documents" data-status={offboardingCase.status}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{L.DOCUMENTS}</h4>
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
      </div>
      <ol className="space-y-1.5">
        {ARTIFACT_KINDS.map((kind) => {
          const state = stepState(offboardingCase, kind);
          const artifact = offboardingCase.artifacts.find((item) => item.kind === kind);
          return (
            <li
              key={kind}
              data-step={kind}
              data-state={state}
              className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2 ring-1 ring-slate-200"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                {state === 'ready' && <CheckBadgeIcon className="h-4 w-4 shrink-0 text-emerald-600" />}
                {state === 'working' && <Spinner className="h-4 w-4 shrink-0 text-brand-500" />}
                {state === 'waiting' && <span className="h-4 w-4 shrink-0 rounded-full ring-1 ring-slate-300" />}
                <span className="truncate">{ARTIFACT_DISPLAY[kind]}</span>
              </span>
              {artifact?.downloadable && (
                <Button
                  size="sm"
                  variant="secondary"
                  isBusy={downloadingId === artifact.id}
                  onClick={() => download(artifact)}
                  aria-label={`${L.DOWNLOAD} ${ARTIFACT_DISPLAY[kind]}`}
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                  {L.DOWNLOAD}
                </Button>
              )}
              {!artifact && (
                <span className="text-xs text-slate-400">{state === 'working' ? L.PROGRESS : L.WAITING}</span>
              )}
            </li>
          );
        })}
      </ol>
      {offboardingCase.status === OFFBOARDING_STATUSES.FAILED && offboardingCase.lastErrorCode && (
        <p className="text-xs text-rose-700">{L.ERROR_CODE(offboardingCase.lastErrorCode)}</p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
