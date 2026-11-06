/**
 * "Reset your password", in two ways:
 *
 *   /reset-password?email=   from "forgot password": type the emailed 6-digit code and the new
 *                            password. "Resend" asks POST /api/auth/password/forgot again once the
 *                            server's wait is over. Opened without ?email=, it asks for the address.
 *   /reset-password/:token   the emailed link: GET /api/auth/password/reset/:token says whether it
 *                            still works (if not, the server's message and a way to ask again)
 *
 *   POST /api/auth/password/reset { email, code | token, password, confirmPassword }
 *       changed: every device is signed out, so on to sign in with the server's message
 *
 * The strength bar comes from the server's password policy; the server checks the password itself
 * and its messages appear under each field.
 */

import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ApiError,
  AUTH_ERROR_CODES,
  requestPasswordReset,
  requestPasswordResetEmail,
  requestResetLinkStatus,
} from '../api/authApi.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import { MailIcon } from '../components/Icons.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { CodeEntry } from '../components/auth/AuthFields.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { SuccessNotice } from '../components/auth/AuthNotices.jsx';
import PasswordStrength from '../components/auth/PasswordStrength.jsx';
import { AUTH_SLIDES } from '../constants/authScreens.js';
import { AUTH_LINK_CLASS } from '../constants/formStyles.js';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { useCountdown } from '../hooks/useCountdown.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const PASSWORD_REQUIREMENTS_ID = 'reset-password-requirements';
const LINK_STATES = Object.freeze({ CHECKING: 'checking', USABLE: 'usable', UNUSABLE: 'unusable' });
const stack = 'space-y-[clamp(0.85rem,2.2vh,1.3rem)]';

/** Whether the emailed link still works; a code needs no check before it is typed. */
function useResetLinkState(token) {
  const [linkState, setLinkState] = useState(token ? LINK_STATES.CHECKING : LINK_STATES.USABLE);
  const [linkMessage, setLinkMessage] = useState(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    requestResetLinkStatus(token, { signal: controller.signal }).then(
      () => setLinkState(LINK_STATES.USABLE),
      (statusError) => {
        if (controller.signal.aborted) return;
        setLinkMessage(statusError instanceof ApiError ? statusError.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR);
        setLinkState(LINK_STATES.UNUSABLE);
      },
    );
    return () => controller.abort();
  }, [token]);
  return { linkState, linkMessage };
}

export default function ResetPassword() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const { state: arrival } = useLocation();
  const navigate = useNavigate();
  const { branding, options, passwordPolicy } = usePublicAuthSettings();
  const reset = useAuthRequest();
  const resend = useAuthRequest();
  const countdown = useCountdown(arrival?.resendAfterSeconds ?? 0);
  const { linkState, linkMessage } = useResetLinkState(token);

  const knownEmail = searchParams.get('email') ?? '';
  const [email, setEmail] = useState(knownEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState(arrival?.notice ?? null);
  const usesCode = !token;
  const codeDigits = options?.verificationCodeDigits ?? null;

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setNotice(null);
    resend.clearError();
    const proof = usesCode ? { email, code } : { token };
    let refusal = null;
    const changed = await reset.run(async (signal) => {
      try {
        return await requestPasswordReset({ ...proof, password, confirmPassword }, { signal });
      } catch (resetError) {
        refusal = resetError;
        throw resetError;
      }
    });
    if (!changed) {
      // A wrong or used-up code: clear the boxes for the next one.
      if (refusal?.code === AUTH_ERROR_CODES.RESET_CODE_INVALID) setCode('');
      return;
    }
    navigate(ROUTE_PATHS.LOGIN, { replace: true, state: { notice: changed.message } });
  }

  async function handleResend() {
    setNotice(null);
    reset.clearError();
    let refusal = null;
    const sent = await resend.run(async (signal) => {
      try {
        return await requestPasswordResetEmail(email, { signal });
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

  const footer = (
    <>
      Remembered your password?{' '}
      <Link to={ROUTE_PATHS.LOGIN} className={AUTH_LINK_CLASS}>
        Sign in
      </Link>
    </>
  );
  const shellProps = { branding, slides: AUTH_SLIDES.RESET_PASSWORD, footer };

  if (linkState === LINK_STATES.CHECKING) {
    return (
      <AuthShell {...shellProps} title="Reset Your Password">
        <p role="status" className="text-sm text-slate-500">
          Checking your link…
        </p>
      </AuthShell>
    );
  }

  if (linkState === LINK_STATES.UNUSABLE) {
    return (
      <AuthShell {...shellProps} title="Reset Your Password">
        <div className={stack}>
          <ErrorBanner title={BANNER_TITLES.LINK_NOT_USABLE} message={linkMessage} />
          <Link
            to={ROUTE_PATHS.FORGOT_PASSWORD}
            className="flex h-[clamp(2.75rem,5.8vh,3.35rem)] w-full items-center justify-center rounded-xl bg-brand-600 text-[15px] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(31,91,255,0.75)] transition hover:bg-brand-500 focus-visible:ring-4 focus-visible:ring-brand-200 focus-visible:outline-none"
          >
            Get a new code
          </Link>
        </div>
      </AuthShell>
    );
  }

  const description = !usesCode ? (
    'Choose your new password.'
  ) : knownEmail ? (
    <>
      Enter the {codeDigits ?? 6}-digit code sent to{' '}
      <strong className="font-semibold text-slate-900">{knownEmail}</strong> and choose your new password.
    </>
  ) : (
    'Enter your registered email, the code we sent to it, and your new password.'
  );
  const error = reset.error ?? resend.error;

  return (
    <AuthShell {...shellProps} title="Reset Your Password" description={description}>
      <form onSubmit={handleSubmit} noValidate className={stack}>
        {notice && <SuccessNotice>{notice}</SuccessNotice>}
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.REQUEST_FAILED}
            message={error.message}
            requestId={error.requestId}
            onDismiss={() => {
              reset.clearError();
              resend.clearError();
            }}
          />
        )}
        <fieldset disabled={reset.isSubmitting} className={stack}>
          {usesCode && !knownEmail && (
            <FormField
              appearance="auth"
              fieldId="email"
              label="Registered Email"
              inputType="email"
              placeholder="you@example.com"
              fieldValue={email}
              errorMessage={reset.fieldErrors.email ?? resend.fieldErrors.email}
              autoCompleteHint="email"
              leadingIcon={<MailIcon className="h-5 w-5" />}
              onFieldChange={(changeEvent) => setEmail(changeEvent.target.value)}
            />
          )}
          {usesCode && codeDigits && (
            <CodeEntry
              label="Verification Code"
              length={codeDigits}
              value={code}
              onChange={setCode}
              errorMessage={reset.fieldErrors.code}
              hasError={reset.error?.code === AUTH_ERROR_CODES.RESET_CODE_INVALID}
              secondsLeft={countdown.secondsLeft}
              onResend={handleResend}
              isResending={resend.isSubmitting}
              autoFocus={Boolean(knownEmail)}
            />
          )}
          <div>
            <PasswordField
              appearance="auth"
              fieldId="password"
              label="New Password"
              placeholder="Create a strong password"
              fieldValue={password}
              errorMessage={reset.fieldErrors.password}
              autoCompleteHint="new-password"
              describedByIds={passwordPolicy ? [PASSWORD_REQUIREMENTS_ID] : []}
              onFieldChange={(changeEvent) => setPassword(changeEvent.target.value)}
            />
            <PasswordStrength password={password} passwordPolicy={passwordPolicy} listId={PASSWORD_REQUIREMENTS_ID} />
          </div>
          <PasswordField
            appearance="auth"
            fieldId="confirmPassword"
            label="Confirm New Password"
            placeholder="Repeat new password"
            fieldValue={confirmPassword}
            errorMessage={reset.fieldErrors.confirmPassword}
            autoCompleteHint="new-password"
            onFieldChange={(changeEvent) => setConfirmPassword(changeEvent.target.value)}
          />
        </fieldset>
        <SubmitButton
          appearance="auth"
          isSubmitting={reset.isSubmitting}
          idleLabel="Reset Password & Continue"
          loadingLabel="Resetting…"
        />
      </form>
    </AuthShell>
  );
}
