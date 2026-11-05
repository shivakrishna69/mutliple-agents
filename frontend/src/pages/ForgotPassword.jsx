/**
 * Forgot password: POST /api/auth/password/forgot { email }.
 *
 * The server answers the same for every address (it never says whether one has an account), so
 * this page shows its message, how long the link works (passwordResetLinkMinutes) and when another
 * email may be asked for. A 429 says how long to wait. The company's support address is offered for
 * anyone locked out.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { AUTH_ERROR_CODES, requestPasswordResetEmail } from '../api/authApi.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import { ArrowLeftIcon, MailIcon, QuestionIcon } from '../components/Icons.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { SuccessNotice } from '../components/auth/AuthNotices.jsx';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { formatCountdown, useCountdown } from '../hooks/useCountdown.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const linkClass =
  'rounded font-semibold text-brand-600 hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export default function ForgotPassword() {
  const { branding, options } = usePublicAuthSettings();
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();
  const countdown = useCountdown(0);
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState(null);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setNotice(null);
    let refusal = null;
    const sent = await run(async (signal) => {
      try {
        return await requestPasswordResetEmail(email, { signal });
      } catch (requestError) {
        refusal = requestError;
        throw requestError;
      }
    });
    if (sent) {
      setNotice(sent.message);
      countdown.start(sent.resendAfterSeconds);
    } else if (refusal?.code === AUTH_ERROR_CODES.EMAIL_COOLDOWN) {
      countdown.start(refusal.context?.retryAfterSeconds ?? 0);
    }
  }

  const isWaiting = countdown.secondsLeft > 0;

  return (
    <AuthShell
      branding={branding}
      title="Forgot your password?"
      description={
        options
          ? `Enter your work email and we will send you a link to choose a new password. It works for ${options.passwordResetLinkMinutes} minutes.`
          : 'Enter your work email and we will send you a link to choose a new password.'
      }
      footer={
        <Link to={ROUTE_PATHS.LOGIN} className={`inline-flex items-center gap-1.5 ${linkClass}`}>
          <ArrowLeftIcon className="h-4 w-4" />
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {notice && <SuccessNotice>{notice}</SuccessNotice>}
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.REQUEST_FAILED}
            message={error.message}
            requestId={error.requestId}
            onDismiss={clearError}
          />
        )}
        <fieldset disabled={isSubmitting} className="space-y-5">
          <FormField
            fieldId="email"
            label="Work email address"
            inputType="email"
            placeholder="you@company.com"
            fieldValue={email}
            errorMessage={fieldErrors.email}
            autoCompleteHint="email"
            leadingIcon={<MailIcon className="h-5 w-5" />}
            onFieldChange={(changeEvent) => setEmail(changeEvent.target.value)}
          />
        </fieldset>
        {isWaiting ? (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-center text-sm text-slate-600" aria-live="polite">
            You can ask for another email in{' '}
            <span className="font-semibold text-brand-700">{formatCountdown(countdown.secondsLeft)}</span>
          </p>
        ) : (
          <SubmitButton
            isSubmitting={isSubmitting}
            idleLabel={notice ? 'Send another link' : 'Send reset link'}
            loadingLabel="Sending…"
          />
        )}
        {branding?.supportEmail && (
          <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <QuestionIcon className="h-5 w-5 shrink-0 text-slate-400" />
            <p>
              Can&apos;t get into your email?{' '}
              <a href={`mailto:${branding.supportEmail}`} className={linkClass}>
                Contact support
              </a>
            </p>
          </div>
        )}
      </form>
    </AuthShell>
  );
}
