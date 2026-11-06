/**
 * Sign in: POST /api/auth/login { email, password, rememberDevice }.
 *
 *   success                 the session is recorded and the person goes to the dashboard
 *   403 EMAIL_NOT_VERIFIED  the email is not confirmed yet: on to "verify your email" with the
 *                           server's message, where the code can be typed or a new one asked for
 *   anything else           the server's message in a banner (wrong credentials, rate limits);
 *                           after a failed sign-in the password is cleared and focused again
 *
 * Arriving from a password reset, the server's "password changed" message is shown above the form.
 * Every message shown comes from the server; this page checks nothing itself. "Remember me" states
 * the server's REMEMBERED_SESSION_DAYS (GET /api/auth/options). The password is sent once and never
 * stored; the session lives in HttpOnly cookies this code cannot read.
 */

import { useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AUTH_ERROR_CODES, requestLogin } from '../api/authApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { CheckboxField, SuccessNotice } from '../components/auth/AuthNotices.jsx';
import { AUTH_SLIDES } from '../constants/authScreens.js';
import { AUTH_LINK_CLASS } from '../constants/formStyles.js';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

export default function Login() {
  const navigate = useNavigate();
  const { state: arrival } = useLocation();
  const { establishSession } = useAuth();
  const { branding, options } = usePublicAuthSettings();
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  const [notice, setNotice] = useState(arrival?.notice ?? null);
  const passwordInputRef = useRef(null);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setNotice(null);
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
      slides={AUTH_SLIDES.SIGN_IN}
      title="Welcome Back"
      description="Sign in to access your dashboard and workspace"
      footer={
        <>
          Don&apos;t have an account?{' '}
          <Link to={ROUTE_PATHS.SIGNUP} className={AUTH_LINK_CLASS}>
            Sign up
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-[clamp(0.9rem,2.4vh,1.35rem)]">
        {notice && <SuccessNotice>{notice}</SuccessNotice>}
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.LOGIN_FAILED}
            message={error.message}
            requestId={error.requestId}
            onDismiss={clearError}
          />
        )}
        <fieldset disabled={isSubmitting} className="space-y-[clamp(0.9rem,2.4vh,1.35rem)]">
          <FormField
            appearance="auth"
            fieldId="email"
            label="Work Email"
            inputType="email"
            placeholder="name@company.com"
            fieldValue={email}
            errorMessage={fieldErrors.email}
            autoCompleteHint="email"
            onFieldChange={(changeEvent) => setEmail(changeEvent.target.value)}
          />
          <PasswordField
            appearance="auth"
            fieldId="password"
            label="Password"
            placeholder="Enter your password"
            fieldValue={password}
            errorMessage={fieldErrors.password}
            autoCompleteHint="current-password"
            inputRef={passwordInputRef}
            onFieldChange={(changeEvent) => setPassword(changeEvent.target.value)}
          />
          <div className="flex items-center justify-between gap-4">
            <CheckboxField
              fieldId="rememberDevice"
              checked={rememberDevice}
              onChange={setRememberDevice}
              errorMessage={fieldErrors.rememberDevice}
            >
              {options ? `Remember me for ${options.rememberedSessionDays} days` : 'Remember me'}
            </CheckboxField>
            <Link to={ROUTE_PATHS.FORGOT_PASSWORD} className={`shrink-0 text-sm ${AUTH_LINK_CLASS}`}>
              Forgot password?
            </Link>
          </div>
        </fieldset>
        <SubmitButton appearance="auth" isSubmitting={isSubmitting} idleLabel="Sign In" loadingLabel="Signing in…" />
      </form>
    </AuthShell>
  );
}
