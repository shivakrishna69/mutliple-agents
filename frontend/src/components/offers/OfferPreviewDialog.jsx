/**
 * The offer letter as the candidate would receive it, before anything is sent: the watermarked
 * preview PDF from POST /calculate (includePreview), shown in the page, with a download link for
 * browsers that do not show PDFs inline. The PDF lives only in this page's memory (an object URL,
 * released when the dialog closes).
 */

import { useEffect, useMemo } from 'react';
import Dialog from '../Dialog.jsx';

function pdfUrlOf(base64) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}

export default function OfferPreviewDialog({ preview, candidateName, onClose }) {
  const url = useMemo(() => pdfUrlOf(preview.base64), [preview.base64]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <Dialog title={`Offer letter preview: ${candidateName}`} size="lg" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          This preview is marked as a draft and is not locked. The letter that is sent carries no watermark and opens
          with the candidate&apos;s date of birth.
        </p>
        <iframe title="Offer letter" src={url} className="h-[70vh] w-full rounded-xl ring-1 ring-slate-200" />
        <a
          href={url}
          download={`Offer-letter-preview-${candidateName.replace(/\s+/g, '-')}.pdf`}
          className="inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          Download the preview
        </a>
      </div>
    </Dialog>
  );
}
