/**
 * Signup page: creates an account through POST /api/auth/signup and signs the user in.
 *
 * Component lifecycle
 *   1. Mount: the form renders empty. PublicOnlyRoute (App.jsx) has already redirected
 *      signed-in users to /dashboard, so this page is only seen when signed out.
 *   2. Editing: each keystroke updates `formValues`; validation is recomputed from the
 *      values on every render (it is derived, never stored), so it cannot go stale.
 *      Errors for a field appear once that field has been blurred or a submit was attempted;
 *      the password checklist and the password-match check update live while typing.
 *   3. Submit: if any field is invalid, focus moves to the first invalid field and no request
 *      is sent. Otherwise the form is locked, the request is sent, and on success the session
 *      is recorded in AuthContext and the user is redirected to /dashboard.
 *   4. Unmount: an in-flight request is aborted so its result cannot update a page that is gone.
 *
 * State flow
 *   formValues ─┬─► clientFieldErrors (derived) ─┐
 *               └─► passwordRuleResults (derived)├─► visibleFieldErrors ─► inline messages
 *   touchedFields / hasAttemptedSubmit ──────────┤
 *   serverFieldErrors (from a 400 response) ─────┘
 *   isSubmitting ─► locked <fieldset> and spinner button
 *   submissionError ─► dismissible banner above the form
 *
 * Security considerations
 *   - Client-side validation is for fast feedback only; the backend re-validates everything.
 *   - The password is sent once and never logged or stored. The session JWT is set by the
 *     backend as an HttpOnly cookie, which this code cannot read; only the public profile and
 *     the CSRF token are kept, in memory (auth/AuthContext.jsx).
 *   - The same rules are enforced by the backend, which rejects a weak password whatever
 *     client sent it; the checks here exist to give instant feedback.
 *   - No `role` is sent: the backend creates every self-registered account as a customer.
 *   - Double submission is blocked twice: a ref guard (synchronous, so two clicks in the same
 *     tick cannot both pass) and the disabled fieldset (visual and keyboard lock).
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, requestSignup } from '../api/authApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import AuthLayout from '../components/AuthLayout.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { API_MESSAGES, BANNER_TITLES, FORM_MESSAGES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { evaluatePasswordRules, validateSignupForm } from '../validation/authFormValidation.js';

const INITIAL_FORM_VALUES = Object.freeze({ name: '', email: '', password: '', confirmPassword: '' });

/** Order in which fields appear, used to focus the first invalid one on submit. */
const SIGNUP_FIELD_ORDER = Object.freeze(['name', 'email', 'password', 'confirmPassword']);

const PASSWORD_REQUIREMENTS_LIST_ID = 'password-requirements';

export default function Signup() {
  // ==========================================================================
  // State & Hook Definitions
  // ==========================================================================

  const navigate = useNavigate();
  const { establishSession } = useAuth();

  const [formValues, setFormValues] = useState(INITIAL_FORM_VALUES);
  const [touchedFields, setTouchedFields] = useState({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState({});
  const [submissionError, setSubmissionError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // State updates are asynchronous, so `isSubmitting` alone cannot stop two clicks fired in
  // the same tick. This ref flips synchronously and is the authoritative double-submit guard.
  const isSubmittingRef = useRef(false);
  const activeRequestControllerRef = useRef(null);

  const nameInputRef = useRef(null);
  const emailInputRef = useRef(null);
  const passwordInputRef = useRef(null);
  const confirmPasswordInputRef = useRef(null);
  const inputRefsByField = {
    name: nameInputRef,
    email: emailInputRef,
    password: passwordInputRef,
    confirmPassword: confirmPasswordInputRef,
  };

  // Abort an in-flight signup if the user navigates away before it completes.
  useEffect(() => () => activeRequestControllerRef.current?.abort(), []);

  // ==========================================================================
  // Validation & Regex Logic
  // ==========================================================================
  //
  // Rules live in validation/authFormValidation.js and constants/validation.js, shared with
  // the parity test against the backend validator. In brief:
  //   name      1–100 characters after trimming
  //   email     EMAIL_PATTERN /^[^\s@]+@[^\s@]+\.[^\s@]+$/ (one "@", a dotted domain, no
  //             whitespace), at most 254 characters after lowercasing and trimming
  //   password  8+ characters, at most 72 UTF-8 bytes, and at least one match each for
  //             /[A-Z]/, /[a-z]/, /\d/ and /[^A-Za-z0-9\s]/ (a symbol)
  //   confirm   exactly equal to password
  // Both values below are derived from the current form values on every render, never stored,
  // so they cannot go stale.
  const clientFieldErrors = validateSignupForm(formValues);
  const passwordRuleResults = evaluatePasswordRules(formValues.password);

  // Shown as soon as the confirmation field has any input, so the user sees a mismatch
  // while typing instead of only after leaving the field.
  const passwordMatchError =
    formValues.confirmPassword.length > 0 && formValues.confirmPassword !== formValues.password
      ? FORM_MESSAGES.PASSWORDS_DO_NOT_MATCH
      : null;

  /** The message to display under a field: client errors once the field is touched, else server errors. */
  function resolveVisibleFieldError(fieldName) {
    const isFieldRevealed = hasAttemptedSubmit || touchedFields[fieldName];
    if (isFieldRevealed && clientFieldErrors[fieldName]) return clientFieldErrors[fieldName];
    if (fieldName === 'confirmPassword' && passwordMatchError) return passwordMatchError;
    return serverFieldErrors[fieldName] ?? null;
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  /** Updates one field and clears any server error for it, since the value it described changed. */
  function handleFieldChange(changeEvent) {
    const { name: fieldName, value: fieldValue } = changeEvent.target;
    setFormValues((previousValues) => ({ ...previousValues, [fieldName]: fieldValue }));
    setServerFieldErrors((previousErrors) => {
      if (!(fieldName in previousErrors)) return previousErrors;
      const { [fieldName]: clearedError, ...remainingErrors } = previousErrors;
      return remainingErrors;
    });
  }

  /** Marks a field as touched so its validation errors start showing. */
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
   * Validates, sends the signup request, stores the session, and redirects.
   * Expected failures become a banner (and inline field errors when the server sent them);
   * an aborted request (page unmounted) is ignored silently.
   */
  async function handleFormSubmit(submitEvent) {
    submitEvent.preventDefault();
    if (isSubmittingRef.current) return;

    setHasAttemptedSubmit(true);
    const firstInvalidField = SIGNUP_FIELD_ORDER.find((fieldName) => clientFieldErrors[fieldName]);
    if (firstInvalidField) {
      inputRefsByField[firstInvalidField].current?.focus();
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setSubmissionError(null);
    setServerFieldErrors({});

    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;

    try {
      const authResult = await requestSignup(
        {
          name: formValues.name.trim(),
          email: formValues.email.trim(),
          password: formValues.password,
        },
        { signal: requestController.signal },
      );

      // The session cookies were set by the response; record the user and CSRF token in memory.
      establishSession(authResult);

      // Navigation trigger: the account exists and the session is active, so leave the
      // signup page. `replace` swaps /signup out of the history stack, so the browser's
      // Back button from the dashboard does not return to a form for an account that
      // already exists.
      navigate(ROUTE_PATHS.DASHBOARD, { replace: true });
    } catch (signupError) {
      if (requestController.signal.aborted) return;

      if (signupError instanceof ApiError) {
        setSubmissionError({
          message: signupError.message,
          // Reference ids help support trace server faults; for 4xx the message says it all.
          requestId: signupError.status >= 500 ? signupError.requestId : null,
        });
        setServerFieldErrors(signupError.fieldErrors);
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
  }

  // ==========================================================================
  // JSX Render Blocks
  // ==========================================================================

  return (
    <AuthLayout
      heading="Create your account"
      subheading="Get help from our support team and AI assistants."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to={ROUTE_PATHS.LOGIN}
            className="rounded font-semibold text-indigo-600 transition-colors hover:text-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleFormSubmit} noValidate className="space-y-5">
        {submissionError && (
          <ErrorBanner
            title={BANNER_TITLES.SIGNUP_FAILED}
            message={submissionError.message}
            requestId={submissionError.requestId}
            onDismiss={handleBannerDismiss}
          />
        )}

        {/* A disabled fieldset disables every input inside it, locking the form while submitting. */}
        <fieldset disabled={isSubmitting} className="space-y-5">
          <FormField
            fieldId="name"
            label="Full name"
            fieldValue={formValues.name}
            errorMessage={resolveVisibleFieldError('name')}
            autoCompleteHint="name"
            inputRef={nameInputRef}
            onFieldChange={handleFieldChange}
            onFieldBlur={handleFieldBlur}
          />

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
            autoCompleteHint="new-password"
            inputRef={passwordInputRef}
            describedByIds={[PASSWORD_REQUIREMENTS_LIST_ID]}
            onFieldChange={handleFieldChange}
            onFieldBlur={handleFieldBlur}
          >
            <ul id={PASSWORD_REQUIREMENTS_LIST_ID} className="mt-3 space-y-1.5 text-sm">
              {passwordRuleResults.map((ruleResult) => (
                <li
                  key={ruleResult.ruleId}
                  className={`flex items-center gap-2 transition-colors ${
                    ruleResult.isSatisfied ? 'text-emerald-700' : 'text-slate-500'
                  }`}
                >
                  <svg
                    className={`h-4 w-4 shrink-0 ${ruleResult.isSatisfied ? 'text-emerald-500' : 'text-slate-300'}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span>
                    {ruleResult.description}
                    <span className="sr-only">{ruleResult.isSatisfied ? ' (met)' : ' (not met)'}</span>
                  </span>
                </li>
              ))}
            </ul>
          </FormField>

          <FormField
            fieldId="confirmPassword"
            label="Confirm password"
            inputType="password"
            fieldValue={formValues.confirmPassword}
            errorMessage={resolveVisibleFieldError('confirmPassword')}
            autoCompleteHint="new-password"
            inputRef={confirmPasswordInputRef}
            onFieldChange={handleFieldChange}
            onFieldBlur={handleFieldBlur}
          />
        </fieldset>

        <SubmitButton isSubmitting={isSubmitting} idleLabel="Create account" loadingLabel="Creating account…" />
      </form>
    </AuthLayout>
  );
}
