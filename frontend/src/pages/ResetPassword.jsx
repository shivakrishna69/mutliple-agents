/**
 * The page the reset link opens (/reset-password/:token).
 *
 *   GET  /api/auth/password/reset/:token   is the link still good (and until when)? If not, the
 *                                          server's message and a way to ask for a new link
 *   POST /api/auth/password/reset { token, password, confirmPassword }
 *                                          changed: every device is signed out, so the server's
 *                                          message and a button to sign in with the new password
 *
 * The strength meter and checklist come from the server's password policy; the server checks the
 * password itself and its messages appear under each field.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, requestPasswordReset, requestResetLinkStatus } from '../api/authApi.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { LockIcon } from '../components/Icons.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { SuccessNotice } from '../components/auth/AuthNotices.jsx';
import PasswordStrength from '../components/auth/PasswordStrength.jsx';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const PASSWORD_REQUIREMENTS_ID = 'reset-password-requirements';
const LINK_STATES = Object.freeze({ CHECKING: 'checking', USABLE: 'usable', UNUSABLE: 'unusable', DONE: 'done' });
const buttonLinkClass =
  'inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export default function ResetPassword() {
  const { token } = useParams();
  const { branding, passwordPolicy } = usePublicAuthSettings();
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();
  const [linkState, setLinkState] = useState(LINK_STATES.CHECKING);
  const [serverMessage, setServerMessage] = useState(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    requestResetLinkStatus(token, { signal: controller.signal }).then(
      () => setLinkState(LINK_STATES.USABLE),
      (statusError) => {
        if (controller.signal.aborted) return;
        setServerMessage(statusError instanceof ApiError ? statusError.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR);
        setLinkState(LINK_STATES.UNUSABLE);
      },
    );
    return () => controller.abort();
  }, [token]);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    const changed = await run((signal) => requestPasswordReset({ token, password, confirmPassword }, { signal }));
    if (!changed) return;
    setServerMessage(changed.message);
    setPassword('');
    setConfirmPassword('');
    setLinkState(LINK_STATES.DONE);
  }

  const titles = {
    [LINK_STATES.CHECKING]: 'Checking your link…',
    [LINK_STATES.USABLE]: 'Choose a new password',
    [LINK_STATES.UNUSABLE]: 'Reset your password',
    [LINK_STATES.DONE]: 'Password changed',
  };

  return (
    <AuthShell branding={branding} title={titles[linkState]}>
      {linkState === LINK_STATES.UNUSABLE && (
        <div className="space-y-4">
          <ErrorBanner title={BANNER_TITLES.LINK_NOT_USABLE} message={serverMessage} />
          <Link
            to={ROUTE_PATHS.FORGOT_PASSWORD}
            className={`${buttonLinkClass} bg-brand-600 text-white shadow-lg shadow-brand-500/25 hover:bg-brand-500`}
          >
            Get a new link
          </Link>
        </div>
      )}

      {linkState === LINK_STATES.DONE && (
        <div className="space-y-4">
          <SuccessNotice>{serverMessage}</SuccessNotice>
          <Link
            to={ROUTE_PATHS.LOGIN}
            className={`${buttonLinkClass} bg-brand-600 text-white shadow-lg shadow-brand-500/25 hover:bg-brand-500`}
          >
            Sign in
          </Link>
        </div>
      )}

      {linkState === LINK_STATES.USABLE && (
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          {error && (
            <ErrorBanner
              title={BANNER_TITLES.REQUEST_FAILED}
              message={error.message}
              requestId={error.requestId}
              onDismiss={clearError}
            />
          )}
          <fieldset disabled={isSubmitting} className="space-y-5">
            <div>
              <PasswordField
                fieldId="password"
                label="New password"
                placeholder="Create a strong password"
                fieldValue={password}
                errorMessage={fieldErrors.password}
                autoCompleteHint="new-password"
                describedByIds={passwordPolicy ? [PASSWORD_REQUIREMENTS_ID] : []}
                leadingIcon={<LockIcon className="h-5 w-5" />}
                onFieldChange={(changeEvent) => setPassword(changeEvent.target.value)}
              />
              <PasswordStrength password={password} passwordPolicy={passwordPolicy} listId={PASSWORD_REQUIREMENTS_ID} />
            </div>
            <PasswordField
              fieldId="confirmPassword"
              label="Confirm new password"
              placeholder="Re-enter your new password"
              fieldValue={confirmPassword}
              errorMessage={fieldErrors.confirmPassword}
              autoCompleteHint="new-password"
              leadingIcon={<LockIcon className="h-5 w-5" />}
              onFieldChange={(changeEvent) => setConfirmPassword(changeEvent.target.value)}
            />
          </fieldset>
          <SubmitButton isSubmitting={isSubmitting} idleLabel="Change password" loadingLabel="Changing…" />
        </form>
      )}

      {linkState === LINK_STATES.CHECKING && (
        <p role="status" className="text-sm text-slate-600">
          One moment…
        </p>
      )}
    </AuthShell>
  );
}
