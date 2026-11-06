/**
 * "Verify your email": type the code from the confirmation email, or ask for a new email.
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
import { MailIcon } from '../components/Icons.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { CodeEntry } from '../components/auth/AuthFields.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { SuccessNotice } from '../components/auth/AuthNotices.jsx';
import { AUTH_SLIDES } from '../constants/authScreens.js';
import { AUTH_LINK_CLASS } from '../constants/formStyles.js';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useCountdown } from '../hooks/useCountdown.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const MAIL_APPS = Object.freeze([
  { label: 'Open Gmail', href: 'https://mail.google.com/' },
  { label: 'Open Outlook', href: 'https://outlook.live.com/mail/' },
]);
const stack = 'space-y-[clamp(0.85rem,2.2vh,1.3rem)]';

export default function CheckEmail() {
  const navigate = useNavigate();
  const { establishSession } = useAuth();
  const { state: arrival } = useLocation();
  const [searchParams] = useSearchParams();
  const { branding, options } = usePublicAuthSettings();
  const confirmation = useAuthRequest();
  const resend = useAuthRequest();
  const countdown = useCountdown(arrival?.resendAfterSeconds ?? 0);

  const knownEmail = searchParams.get('email') ?? '';
  const [email, setEmail] = useState(knownEmail);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState(arrival?.notice ?? null);
  const codeDigits = options?.verificationCodeDigits ?? arrival?.codeDigits ?? null;

  async function handleConfirm(submitEvent) {
    submitEvent.preventDefault();
    setNotice(null);
    resend.clearError();
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
    confirmation.clearError();
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

  return (
    <AuthShell
      branding={branding}
      slides={AUTH_SLIDES.VERIFY_EMAIL}
      title="Verify Your Email"
      description={
        knownEmail ? (
          <>
            Enter the {codeDigits ?? 6}-digit code sent to{' '}
            <strong className="font-semibold text-slate-900">{knownEmail}</strong> to finish setting up your account.
          </>
        ) : (
          'Enter the address you signed up with and the code from the email.'
        )
      }
      footer={
        <>
          Wrong email address?{' '}
          <Link to={ROUTE_PATHS.SIGNUP} className={AUTH_LINK_CLASS}>
            Sign up again
          </Link>
          <span className="mx-2 text-slate-300" aria-hidden="true">
            ·
          </span>
          <Link to={ROUTE_PATHS.LOGIN} className={AUTH_LINK_CLASS}>
            Back to Sign In
          </Link>
        </>
      }
    >
      <form onSubmit={handleConfirm} noValidate className={stack}>
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
        <fieldset disabled={confirmation.isSubmitting} className={stack}>
          {!knownEmail && (
            <FormField
              appearance="auth"
              fieldId="email"
              label="Email"
              inputType="email"
              placeholder="example@gmail.com"
              fieldValue={email}
              errorMessage={confirmation.fieldErrors.email ?? resend.fieldErrors.email}
              autoCompleteHint="email"
              leadingIcon={<MailIcon className="h-5 w-5" />}
              onFieldChange={(changeEvent) => setEmail(changeEvent.target.value)}
            />
          )}
          {codeDigits && (
            <CodeEntry
              label="Verification Code"
              length={codeDigits}
              value={code}
              onChange={setCode}
              errorMessage={confirmation.fieldErrors.code}
              hasError={Boolean(confirmation.error)}
              secondsLeft={countdown.secondsLeft}
              onResend={handleResend}
              isResending={resend.isSubmitting}
              autoFocus={Boolean(knownEmail)}
            />
          )}
        </fieldset>
        <SubmitButton
          appearance="auth"
          isSubmitting={confirmation.isSubmitting}
          idleLabel="Verify & Continue"
          loadingLabel="Verifying…"
        />
        <div className="grid grid-cols-2 gap-3">
          {MAIL_APPS.map((mailApp) => (
            <a
              key={mailApp.href}
              href={mailApp.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-slate-300 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
            >
              {mailApp.label}
            </a>
          ))}
        </div>
      </form>
    </AuthShell>
  );
}
