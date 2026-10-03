/**
 * Public payslip verification (no sign-in): GET /api/payroll/payslips/verify/:verificationId.
 *
 * A verifier (a bank, a landlord) enters the ID printed on the payslip, or opens the QR/link
 * (?id=PS-…). The backend answers whether the payslip is authentic, with a masked employee name,
 * the period and net pay. Optionally the verifier drops the PDF they were given: its SHA-256 is
 * computed in this browser (the file is never uploaded) and compared with the fingerprint of the
 * PDF that was issued, which proves the copy was not edited.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { requestPayslipVerification } from '../api/workforceApi.js';
import BrandMark from '../components/BrandMark.jsx';
import { CheckBadgeIcon, ShieldIcon, UploadIcon } from '../components/Icons.jsx';
import { Badge, Button, MONTH_NAMES, Notice, formatDate, formatInr } from '../components/ui.jsx';
import { ROUTE_PATHS } from '../constants/routes.js';
import { toDisplayError } from '../hooks/useApiResource.js';

const VERIFICATION_ID_PATTERN = /^PS-\d{6}-[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;

async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byteValue) => byteValue.toString(16).padStart(2, '0')).join('');
}

export default function PayslipVerification() {
  const [searchParameters, setSearchParameters] = useSearchParams();
  const [verificationId, setVerificationId] = useState(searchParameters.get('id') ?? '');
  const [verification, setVerification] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [isChecking, setIsChecking] = useState(false);
  const [fileCheck, setFileCheck] = useState(null); // { fileName, matches }

  async function verify(idToCheck) {
    const normalizedId = idToCheck.trim().toUpperCase();
    setVerification(null);
    setFileCheck(null);
    setLookupError(null);
    if (!VERIFICATION_ID_PATTERN.test(normalizedId)) {
      setLookupError({ message: 'That does not look like a payslip verification ID (PS-YYYYMM-XXXX-XXXX-XXXX-XXXX).' });
      return;
    }
    setIsChecking(true);
    setSearchParameters({ id: normalizedId }, { replace: true });
    try {
      const { verification: verificationResult } = await requestPayslipVerification(normalizedId);
      setVerification(verificationResult);
    } catch (verificationError) {
      if (verificationError.status === 404) setLookupError({ message: 'No payslip was issued with this ID. The document may be forged.' });
      else if (verificationError.status === 503) setLookupError({ message: 'Payslip verification is temporarily unavailable. Please try again later.' });
      else setLookupError(toDisplayError(verificationError));
    } finally {
      setIsChecking(false);
    }
  }

  // A link with ?id= is verified once on arrival (the ref also absorbs StrictMode's double effect).
  const hasVerifiedLinkRef = useRef(false);
  useEffect(() => {
    const idFromLink = searchParameters.get('id');
    if (idFromLink && !hasVerifiedLinkRef.current) {
      hasVerifiedLinkRef.current = true;
      verify(idFromLink);
    }
    // Only on first load: later lookups are started by the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFileChosen(changeEvent) {
    const chosenFile = changeEvent.target.files?.[0];
    if (!chosenFile || !verification) return;
    const fileDigest = await sha256Hex(chosenFile);
    setFileCheck({ fileName: chosenFile.name, matches: fileDigest === verification.documentSha256 });
  }

  const period = verification?.period;
  return (
    <main className="relative min-h-dvh overflow-hidden bg-slate-950 px-4 py-10 text-white sm:py-16">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[30rem] w-[60rem] -translate-x-1/2 rounded-full bg-indigo-600/25 blur-3xl" aria-hidden="true" />
      <div className="relative mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <BrandMark tone="light" />
          <Link to={ROUTE_PATHS.LOGIN} className="text-sm text-slate-400 hover:text-white">
            Sign in →
          </Link>
        </div>

        <div className="mt-12 text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 shadow-lg shadow-indigo-500/30">
            <ShieldIcon className="h-7 w-7" />
          </span>
          <h1 className="mt-5 text-3xl font-bold tracking-tight sm:text-4xl">Verify a payslip</h1>
          <p className="mt-3 text-slate-400">Enter the verification ID printed at the bottom of the payslip.</p>
        </div>

        <form
          className="mt-8 flex flex-col gap-3 sm:flex-row"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            verify(verificationId);
          }}
        >
          <input
            value={verificationId}
            onChange={(changeEvent) => setVerificationId(changeEvent.target.value)}
            placeholder="PS-202610-XXXX-XXXX-XXXX-XXXX"
            aria-label="Verification ID"
            className="flex-1 rounded-xl border-0 bg-white/10 px-4 py-3 font-mono text-sm tracking-wide text-white ring-1 ring-white/15 placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-400 focus:outline-none"
          />
          <Button type="submit" isBusy={isChecking} disabled={!verificationId.trim()}>
            Verify
          </Button>
        </form>

        {lookupError && (
          <div className="mt-6">
            <Notice tone="error" title="Not verified">
              {lookupError.message}
            </Notice>
          </div>
        )}

        {verification && (
          <section className="mt-8 overflow-hidden rounded-3xl bg-white text-slate-900 shadow-2xl shadow-black/40">
            <div className={`flex items-center gap-3 px-6 py-5 ${verification.authentic ? 'bg-gradient-to-r from-emerald-500 to-teal-500' : 'bg-gradient-to-r from-rose-500 to-pink-500'} text-white`}>
              <CheckBadgeIcon className="h-8 w-8" />
              <div>
                <p className="text-lg font-bold">{verification.authentic ? 'Authentic payslip' : 'Integrity check failed'}</p>
                <p className="text-sm text-white/85">Issued by {verification.issuer}</p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-5 p-6 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Employee</dt>
                <dd className="mt-1 font-semibold">{verification.employeeName}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Pay period</dt>
                <dd className="mt-1 font-semibold">{period ? `${MONTH_NAMES[period.month - 1]} ${period.year}` : '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Net pay</dt>
                <dd className="mt-1 text-lg font-bold">{formatInr(verification.netPay, { precise: true })}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Status</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <Badge tone={verification.status === 'Issued' ? 'emerald' : 'amber'}>{verification.status}</Badge>
                  <span className="text-xs text-slate-500">rev. {verification.revision}</span>
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-slate-500">Issued</dt>
                <dd className="mt-1 font-medium">{formatDate(verification.issuedAt)}</dd>
              </div>
            </dl>
            {verification.status !== 'Issued' && (
              <div className="px-6 pb-4">
                <Notice tone="warning" title="A newer revision of this payslip exists">
                  Ask the employee for the latest version.
                </Notice>
              </div>
            )}
            <div className="border-t border-slate-100 bg-slate-50 p-6">
              <p className="text-sm font-semibold">Check the PDF you received</p>
              <p className="mt-1 text-xs text-slate-500">Its fingerprint is computed in your browser; the file is not uploaded.</p>
              <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-5 text-sm font-medium text-slate-600 hover:border-indigo-400 hover:text-indigo-600">
                <UploadIcon className="h-5 w-5" /> Choose payslip PDF
                <input type="file" accept="application/pdf" className="sr-only" onChange={handleFileChosen} />
              </label>
              {fileCheck && (
                <div className="mt-3">
                  <Notice tone={fileCheck.matches ? 'success' : 'error'} title={fileCheck.matches ? 'The file is the original, unmodified payslip' : 'The file does not match the issued payslip'}>
                    {fileCheck.fileName}
                  </Notice>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
