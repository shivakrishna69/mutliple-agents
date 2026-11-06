/**
 * Forgot password: POST /api/auth/password/forgot { email }.
 *
 * The server answers the same for every address (it never says whether one has an account) and
 * emails a 6-digit code with a link. On its answer the person goes on to "reset your password"
 * (/reset-password?email=) with the server's message and when another code may be asked for, to
 * type the code. A 429 (a code was sent a moment ago) shows the server's message, with a way on to
 * the code that is already on its way.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AUTH_ERROR_CODES, requestPasswordResetEmail } from '../api/authApi.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import { ArrowLeftIcon, ArrowRightIcon, KeyIcon, MailIcon } from '../components/Icons.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import AuthShell, { CompanyLogo } from '../components/auth/AuthShell.jsx';
import { AUTH_SLIDES } from '../constants/authScreens.js';
import { AUTH_LINK_CLASS } from '../constants/formStyles.js';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const resetPageFor = (email) => `${ROUTE_PATHS.RESET_PASSWORD_WITH_CODE}?email=${encodeURIComponent(email.trim())}`;

export default function ForgotPassword() {
  const navigate = useNavigate();
  const { branding } = usePublicAuthSettings();
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();
  const [email, setEmail] = useState('');
  const [waitSeconds, setWaitSeconds] = useState(0);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setWaitSeconds(0);
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
      navigate(resetPageFor(email), { state: { notice: sent.message, resendAfterSeconds: sent.resendAfterSeconds } });
    } else if (refusal?.code === AUTH_ERROR_CODES.EMAIL_COOLDOWN) {
      setWaitSeconds(refusal.context?.retryAfterSeconds ?? 0);
    }
  }

  return (
    <AuthShell
      branding={branding}
      slides={AUTH_SLIDES.FORGOT_PASSWORD}
      surface="panel"
      header={
        <>
          <Link
            to={ROUTE_PATHS.LOGIN}
            className="inline-flex items-center gap-2 rounded text-sm font-medium text-slate-500 transition hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back to Sign In
          </Link>
          <CompanyLogo branding={branding} />
        </>
      }
      icon={
        <span className="flex h-[clamp(2.75rem,6vh,3.5rem)] w-[clamp(2.75rem,6vh,3.5rem)] items-center justify-center rounded-2xl border border-brand-100 bg-brand-50 text-brand-600 shadow-sm">
          <KeyIcon className="h-6 w-6" />
        </span>
      }
      title="Forgot Password?"
      description="Don't worry, it happens. Enter your registered email address and we'll send a 6-digit verification code to reset your password."
      footer={
        <div className="border-t border-slate-100 pt-[clamp(0.9rem,2.4vh,1.4rem)]">
          Remembered your password?{' '}
          <Link to={ROUTE_PATHS.LOGIN} className={AUTH_LINK_CLASS}>
            Back to Sign In
          </Link>
        </div>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-[clamp(0.9rem,2.4vh,1.35rem)]">
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.REQUEST_FAILED}
            message={error.message}
            requestId={error.requestId}
            onDismiss={clearError}
          />
        )}
        <fieldset disabled={isSubmitting}>
          <FormField
            appearance="auth"
            fieldId="email"
            label="Registered Email"
            inputType="email"
            placeholder="you@example.com"
            fieldValue={email}
            errorMessage={fieldErrors.email}
            autoCompleteHint="email"
            leadingIcon={<MailIcon className="h-5 w-5" />}
            onFieldChange={(changeEvent) => setEmail(changeEvent.target.value)}
          />
        </fieldset>
        <SubmitButton
          appearance="auth"
          isSubmitting={isSubmitting}
          idleLabel="Send Verification Code"
          loadingLabel="Sending…"
          trailingIcon={<ArrowRightIcon className="h-4 w-4" />}
        />
        {waitSeconds > 0 && (
          <p className="text-center text-sm text-slate-600">
            <Link to={resetPageFor(email)} state={{ resendAfterSeconds: waitSeconds }} className={AUTH_LINK_CLASS}>
              Enter the code already sent
            </Link>
          </p>
        )}
      </form>
    </AuthShell>
  );
}
