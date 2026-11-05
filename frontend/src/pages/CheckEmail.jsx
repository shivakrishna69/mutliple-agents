/**
 * "Check your email": type the code from the confirmation email, or ask for a new email.
 *
 * Arrives from signup or sign-in with ?email= and, in the navigation state, the server's message
 * (notice), the code length and how long until another email may be asked for. Opened directly,
 * it asks for the address.
 *
 *   POST /api/auth/verify-email { email, code }   confirmed and signed in: on to the dashboard
 *   POST /api/auth/verify-email/resend { email }  a new code; the wait restarts from the server's
 *                                                 resendAfterSeconds (or a 429's retryAfterSeconds)
 *
 * Every message comes from the server. The code length is the server's (GET /api/auth/options).
 */

import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AUTH_ERROR_CODES, requestEmailConfirmation, requestVerificationEmail } from '../api/authApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import { ArrowLeftIcon, MailIcon } from '../components/Icons.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { SuccessNotice } from '../components/auth/AuthNotices.jsx';
import VerificationCodeInput from '../components/auth/VerificationCodeInput.jsx';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { formatCountdown, useCountdown } from '../hooks/useCountdown.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const CODE_LABEL_ID = 'verification-code-label';
const MAIL_APPS = Object.freeze([
  { label: 'Open Gmail', href: 'https://mail.google.com/' },
  { label: 'Open Outlook', href: 'https://outlook.live.com/mail/' },
]);
const secondaryButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60';
const linkClass =
  'rounded font-semibold text-brand-600 hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export default function CheckEmail() {
  const navigate = useNavigate();
  const { establishSession } = useAuth();
  const { state: arrival } = useLocation();
  const [searchParams] = useSearchParams();
  const { branding, options } = usePublicAuthSettings();
  const confirmation = useAuthRequest();
  const resend = useAuthRequest();
  const countdown = useCountdown(arrival?.resendAfterSeconds ?? 0);

  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState(arrival?.notice ?? null);
  const codeDigits = options?.verificationCodeDigits ?? arrival?.codeDigits ?? null;
  const knowsAddress = Boolean(searchParams.get('email'));

  async function handleConfirm(submitEvent) {
    submitEvent.preventDefault();
    setNotice(null);
    const confirmed = await confirmation.run((signal) => requestEmailConfirmation({ email, code }, { signal }));
    if (!confirmed) {
      setCode('');
      return;
    }
    establishSession(confirmed);
    navigate(ROUTE_PATHS.DASHBOARD, { replace: true });
  }

  async function handleResend() {
    setNotice(null);
    let refusal = null;
    const sent = await resend.run(async (signal) => {
      try {
        return await requestVerificationEmail(email, { signal });
      } catch (resendError) {
        refusal = resendError;
        throw resendError;
      }
    });
    if (sent) {
      setNotice(sent.message);
      setCode('');
      countdown.start(sent.resendAfterSeconds);
    } else if (refusal?.code === AUTH_ERROR_CODES.EMAIL_COOLDOWN) {
      countdown.start(refusal.context?.retryAfterSeconds ?? 0);
    }
  }

  const error = confirmation.error ?? resend.error;
  const isBusy = confirmation.isSubmitting || resend.isSubmitting;

  return (
    <AuthShell
      branding={branding}
      title="Check your email"
      description={
        knowsAddress ? (
          <>
            We sent a code and a confirmation link to{' '}
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-800">{email}</span>
          </>
        ) : (
          'Enter the address you signed up with and the code from the email.'
        )
      }
      footer={
        <Link to={ROUTE_PATHS.LOGIN} className={`inline-flex items-center gap-1.5 ${linkClass}`}>
          <ArrowLeftIcon className="h-4 w-4" />
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleConfirm} noValidate className="space-y-6">
        {notice && <SuccessNotice>{notice}</SuccessNotice>}
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.REQUEST_FAILED}
            message={error.message}
            requestId={error.requestId}
            onDismiss={() => {
              confirmation.clearError();
              resend.clearError();
            }}
          />
        )}
        <fieldset disabled={isBusy} className="space-y-6">
          {!knowsAddress && (
            <FormField
              fieldId="email"
              label="Email address"
              inputType="email"
              placeholder="you@company.com"
              fieldValue={email}
              errorMessage={confirmation.fieldErrors.email ?? resend.fieldErrors.email}
              autoCompleteHint="email"
              leadingIcon={<MailIcon className="h-5 w-5" />}
              onFieldChange={(changeEvent) => setEmail(changeEvent.target.value)}
            />
          )}
          {codeDigits && (
            <div>
              <p id={CODE_LABEL_ID} className="mb-2 text-sm font-medium text-slate-700">
                Confirmation code
              </p>
              <VerificationCodeInput
                length={codeDigits}
                value={code}
                onChange={setCode}
                labelId={CODE_LABEL_ID}
                hasError={Boolean(confirmation.fieldErrors.code || confirmation.error)}
                describedBy={confirmation.fieldErrors.code ? 'verification-code-error' : undefined}
                autoFocus={knowsAddress}
              />
              {confirmation.fieldErrors.code && (
                <p id="verification-code-error" className="mt-2 text-sm text-red-600">
                  {confirmation.fieldErrors.code}
                </p>
              )}
            </div>
          )}
        </fieldset>

        <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <span>Didn&apos;t get the email?</span>
          {countdown.secondsLeft > 0 ? (
            <span aria-live="polite">
              Resend in <span className="font-semibold text-brand-700">{formatCountdown(countdown.secondsLeft)}</span>
            </span>
          ) : (
            <button type="button" onClick={handleResend} disabled={isBusy} className={linkClass}>
              Resend email
            </button>
          )}
        </div>

        <SubmitButton
          isSubmitting={confirmation.isSubmitting}
          idleLabel="Verify and continue"
          loadingLabel="Verifying…"
        />

        <div className="grid grid-cols-2 gap-3">
          {MAIL_APPS.map((mailApp) => (
            <a key={mailApp.href} href={mailApp.href} target="_blank" rel="noreferrer" className={secondaryButtonClass}>
              {mailApp.label}
            </a>
          ))}
        </div>

        <p className="text-center text-sm text-slate-600">
          Wrong email address?{' '}
          <Link to={ROUTE_PATHS.SIGNUP} className={linkClass}>
            Sign up again
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
