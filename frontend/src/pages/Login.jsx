/**
 * Login page: exchanges email and password for a JWT through POST /api/auth/login.
 *
 * Component lifecycle
 *   1. Mount: the form renders empty. PublicOnlyRoute (App.jsx) has already redirected
 *      signed-in users to /dashboard.
 *   2. Editing: validation is derived from the current values on every render. A field's
 *      error appears after it is blurred or after a submit attempt.
 *   3. Submit: invalid input focuses the first invalid field and sends nothing. Otherwise the
 *      form locks, the request is sent, and on success the session is recorded and the user is
 *      redirected to /dashboard. On 401 the password is cleared and refocused for a retry.
 *   4. Unmount: an in-flight request is aborted.
 *
 * State flow
 *   formValues ─► clientFieldErrors (derived) ─┐
 *   touchedFields / hasAttemptedSubmit ────────┴─► inline field messages
 *   isSubmitting ─► locked <fieldset> and spinner button
 *   submissionError ─► dismissible banner above the form
 *
 * Security considerations
 *   - Only presence and email format are checked here. Password strength rules are not
 *     applied at login: accounts may predate a policy change, and revealing the policy on
 *     every attempt helps nobody but an attacker.
 *   - A 401 always shows the same "email or password is incorrect" banner. The backend
 *     answers unknown emails and wrong passwords identically, and the UI keeps it that way.
 *   - The password is cleared from state after a failed attempt, so it does not linger in
 *     memory longer than needed, and it is never logged or persisted.
 *   - The session JWT arrives as an HttpOnly cookie this code cannot read; only the public
 *     profile and CSRF token are kept, in memory (auth/AuthContext.jsx).
 *   - Repeated attempts are rate-limited by the backend (429); its message is shown as-is.
 *   - Double submission is blocked by a synchronous ref guard plus the disabled fieldset.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, requestLogin } from '../api/authApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import AuthLayout from '../components/AuthLayout.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { validateLoginForm } from '../validation/authFormValidation.js';

const INITIAL_FORM_VALUES = Object.freeze({ email: '', password: '' });

/** Order in which fields appear, used to focus the first invalid one on submit. */
const LOGIN_FIELD_ORDER = Object.freeze(['email', 'password']);

const HTTP_STATUS_UNAUTHORIZED = 401;

export default function Login() {
  // ==========================================================================
  // State & Hook Definitions
  // ==========================================================================

  const navigate = useNavigate();
  const { establishSession } = useAuth();

  const [formValues, setFormValues] = useState(INITIAL_FORM_VALUES);
  const [touchedFields, setTouchedFields] = useState({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [submissionError, setSubmissionError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Synchronous double-submit guard; see Signup.jsx for why state alone is not enough.
  const isSubmittingRef = useRef(false);
  const activeRequestControllerRef = useRef(null);

  const emailInputRef = useRef(null);
  const passwordInputRef = useRef(null);
  const inputRefsByField = { email: emailInputRef, password: passwordInputRef };

  // Abort an in-flight login if the user navigates away before it completes.
  useEffect(() => () => activeRequestControllerRef.current?.abort(), []);

  // ==========================================================================
  // Validation & Regex Logic
  // ==========================================================================
  //
  // validation/authFormValidation.js: the email must match EMAIL_PATTERN
  // /^[^\s@]+@[^\s@]+\.[^\s@]+$/ (one "@", a dotted domain, no whitespace) and be at most 254
  // characters; the password must be non-blank. Strength rules are deliberately not applied
  // at login. Derived from the current values on every render, never stored.
  const clientFieldErrors = validateLoginForm(formValues);

  /** The message to display under a field once it has been touched or a submit was attempted. */
  function resolveVisibleFieldError(fieldName) {
    const isFieldRevealed = hasAttemptedSubmit || touchedFields[fieldName];
    return isFieldRevealed ? clientFieldErrors[fieldName] ?? null : null;
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  function handleFieldChange(changeEvent) {
    const { name: fieldName, value: fieldValue } = changeEvent.target;
    setFormValues((previousValues) => ({ ...previousValues, [fieldName]: fieldValue }));
  }

  function handleFieldBlur(blurEvent) {
    const fieldName = blurEvent.target.name;
    setTouchedFields((previousTouched) =>
      previousTouched[fieldName] ? previousTouched : { ...previousTouched, [fieldName]: true },
    );
  }

  function handleBannerDismiss() {
    setSubmissionError(null);
  }

  /**
   * Validates, sends the login request, stores the session, and redirects.
   * 401 shows the invalid-credentials banner and resets the password field; other failures
   * show the API client's message; an aborted request is ignored.
   */
  async function handleFormSubmit(submitEvent) {
    submitEvent.preventDefault();
    if (isSubmittingRef.current) return;

    setHasAttemptedSubmit(true);
    const firstInvalidField = LOGIN_FIELD_ORDER.find((fieldName) => clientFieldErrors[fieldName]);
    if (firstInvalidField) {
      inputRefsByField[firstInvalidField].current?.focus();
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setSubmissionError(null);

    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;
    let shouldRefocusPassword = false;

    try {
      const authResult = await requestLogin(
        { email: formValues.email.trim(), password: formValues.password },
        { signal: requestController.signal },
      );

      // The session cookies were set by the response; record the user and CSRF token in memory.
      establishSession(authResult);

      // Navigation trigger: credentials were accepted and the session is active.
      // `replace` removes /login from history so Back from the dashboard does not
      // show the login form to a signed-in user.
      navigate(ROUTE_PATHS.DASHBOARD, { replace: true });
    } catch (loginError) {
      if (requestController.signal.aborted) return;

      if (loginError instanceof ApiError && loginError.status === HTTP_STATUS_UNAUTHORIZED) {
        setSubmissionError({ message: API_MESSAGES.INVALID_CREDENTIALS, requestId: null });
        setFormValues((previousValues) => ({ ...previousValues, password: '' }));
        // The password must not count as "touched-and-empty" right after we cleared it.
        setTouchedFields((previousTouched) => ({ ...previousTouched, password: false }));
        setHasAttemptedSubmit(false);
        shouldRefocusPassword = true;
      } else if (loginError instanceof ApiError) {
        setSubmissionError({
          message: loginError.message,
          requestId: loginError.status >= 500 ? loginError.requestId : null,
        });
      } else {
        setSubmissionError({ message: API_MESSAGES.UNEXPECTED_SERVER_ERROR, requestId: null });
      }
    } finally {
      if (activeRequestControllerRef.current === requestController) {
        activeRequestControllerRef.current = null;
      }
      if (!requestController.signal.aborted) {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    }

    // Focus only after the fieldset is re-enabled; a disabled input cannot receive focus.
    if (shouldRefocusPassword) {
      requestAnimationFrame(() => passwordInputRef.current?.focus());
    }
  }

  // ==========================================================================
  // JSX Render Blocks
  // ==========================================================================

  return (
    <AuthLayout
      heading="Sign in to your account"
      subheading="Welcome back. Enter your details to continue."
      footer={
        <>
          Don&apos;t have an account?{' '}
          <Link
            to={ROUTE_PATHS.SIGNUP}
            className="rounded font-semibold text-indigo-600 transition-colors hover:text-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={handleFormSubmit} noValidate className="space-y-5">
        {submissionError && (
          <ErrorBanner
            title={BANNER_TITLES.LOGIN_FAILED}
            message={submissionError.message}
            requestId={submissionError.requestId}
            onDismiss={handleBannerDismiss}
          />
        )}

        <fieldset disabled={isSubmitting} className="space-y-5">
          <FormField
            fieldId="email"
            label="Email address"
            inputType="email"
            fieldValue={formValues.email}
            errorMessage={resolveVisibleFieldError('email')}
            autoCompleteHint="email"
            inputRef={emailInputRef}
            onFieldChange={handleFieldChange}
            onFieldBlur={handleFieldBlur}
          />

          <FormField
            fieldId="password"
            label="Password"
            inputType="password"
            fieldValue={formValues.password}
            errorMessage={resolveVisibleFieldError('password')}
            autoCompleteHint="current-password"
            inputRef={passwordInputRef}
            onFieldChange={handleFieldChange}
            onFieldBlur={handleFieldBlur}
          />
        </fieldset>

        <SubmitButton isSubmitting={isSubmitting} idleLabel="Sign in" loadingLabel="Signing in…" />
      </form>
    </AuthLayout>
  );
}
