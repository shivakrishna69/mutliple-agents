/**
 * Sign in: POST /api/auth/login { email, password, rememberDevice }.
 *
 *   success                 the session is recorded and the person goes to the dashboard
 *   403 EMAIL_NOT_VERIFIED  the email is not confirmed yet: on to "check your email" with the
 *                           server's message, where the code can be typed or a new one asked for
 *   anything else           the server's message in a banner (wrong credentials, rate limits);
 *                           after a failed sign-in the password is cleared and focused again
 *
 * Every message shown comes from the server; this page checks nothing itself. "Remember this
 * device" states the server's REMEMBERED_SESSION_DAYS (GET /api/auth/options). The password is
 * sent once and never stored; the session lives in HttpOnly cookies this code cannot read.
 */

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AUTH_ERROR_CODES, requestLogin } from '../api/authApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import { LockIcon, MailIcon } from '../components/Icons.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { CheckboxField } from '../components/auth/AuthNotices.jsx';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const linkClass =
  'rounded font-semibold text-brand-600 transition-colors hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export default function Login() {
  const navigate = useNavigate();
  const { establishSession } = useAuth();
  const { branding, options } = usePublicAuthSettings();
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  const passwordInputRef = useRef(null);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    let refusal = null;
    const session = await run(async (signal) => {
      try {
        return await requestLogin({ email: email.trim(), password, rememberDevice }, { signal });
      } catch (loginError) {
        refusal = loginError;
        throw loginError;
      }
    });
    if (session) {
      establishSession(session);
      navigate(ROUTE_PATHS.DASHBOARD, { replace: true });
      return;
    }
    if (refusal?.code === AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED) {
      navigate(`${ROUTE_PATHS.CHECK_EMAIL}?email=${encodeURIComponent(email.trim())}`, {
        state: { notice: refusal.message },
      });
      return;
    }
    if (refusal) {
      setPassword('');
      requestAnimationFrame(() => passwordInputRef.current?.focus());
    }
  }

  return (
    <AuthShell
      branding={branding}
      activeLink="login"
      title="Welcome back"
      description="Sign in to your workspace."
      footer={
        <>
          Don&apos;t have an account?{' '}
          <Link to={ROUTE_PATHS.SIGNUP} className={linkClass}>
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.LOGIN_FAILED}
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
          <div>
            <PasswordField
              fieldId="password"
              label="Password"
              placeholder="Enter your password"
              fieldValue={password}
              errorMessage={fieldErrors.password}
              autoCompleteHint="current-password"
              inputRef={passwordInputRef}
              leadingIcon={<LockIcon className="h-5 w-5" />}
              onFieldChange={(changeEvent) => setPassword(changeEvent.target.value)}
            />
            <div className="mt-2 text-right text-sm">
              <Link to={ROUTE_PATHS.FORGOT_PASSWORD} className={linkClass}>
                Forgot password?
              </Link>
            </div>
          </div>
          <CheckboxField
            fieldId="rememberDevice"
            checked={rememberDevice}
            onChange={setRememberDevice}
            errorMessage={fieldErrors.rememberDevice}
          >
            {options ? `Remember this device for ${options.rememberedSessionDays} days` : 'Remember this device'}
          </CheckboxField>
        </fieldset>
        <SubmitButton isSubmitting={isSubmitting} idleLabel="Sign in" loadingLabel="Signing in…" />
      </form>
    </AuthShell>
  );
}
