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
 *      is sent. Otherwise the form is locked and the request is sent. On success the form is
 *      replaced by the backend's own message (check your email to confirm the address); no
 *      session starts until the emailed link is opened.
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
import { Link } from 'react-router';
import { ApiError, requestSignup } from '../api/authApi.js';
import AuthLayout from '../components/AuthLayout.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import PasswordChecklist from '../components/PasswordChecklist.jsx';
import PasswordField from '../components/PasswordField.jsx';
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

  const [formValues, setFormValues] = useState(INITIAL_FORM_VALUES);
  const [touchedFields, setTouchedFields] = useState({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState({});
  const [submissionError, setSubmissionError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The backend's answer to a successful signup: { message, email }. Shown instead of the form.
  const [signupConfirmation, setSignupConfirmation] = useState(null);

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
      const signupResult = await requestSignup(
        {
          name: formValues.name.trim(),
          email: formValues.email.trim(),
          password: formValues.password,
        },
        { signal: requestController.signal },
      );

      // No session yet: the account waits for its email to be confirmed through the emailed link.
      setSignupConfirmation(signupResult);
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

  if (signupConfirmation) {
    return (
      <AuthLayout heading="Create your account" subheading={signupConfirmation.email}>
        <p role="status" className="rounded-xl bg-brand-50 p-4 text-sm text-slate-700">
          {signupConfirmation.message}
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      heading="Create your account"
      subheading="Get help from our support team and AI assistants."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to={ROUTE_PATHS.LOGIN}
            className="rounded font-semibold text-brand-600 transition-colors hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
            placeholder="Jane Cooper"
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
            placeholder="you@company.com"
            fieldValue={formValues.email}
            errorMessage={resolveVisibleFieldError('email')}
            autoCompleteHint="email"
            inputRef={emailInputRef}
            onFieldChange={handleFieldChange}
            onFieldBlur={handleFieldBlur}
          />

          <PasswordField
            fieldId="password"
            label="Password"
            placeholder="Create a strong password"
            fieldValue={formValues.password}
            errorMessage={resolveVisibleFieldError('password')}
            autoCompleteHint="new-password"
            inputRef={passwordInputRef}
            describedByIds={[PASSWORD_REQUIREMENTS_LIST_ID]}
            onFieldChange={handleFieldChange}
            onFieldBlur={handleFieldBlur}
          >
            <PasswordChecklist listId={PASSWORD_REQUIREMENTS_LIST_ID} ruleResults={passwordRuleResults} />
          </PasswordField>

          <PasswordField
            fieldId="confirmPassword"
            label="Confirm password"
            placeholder="Re-enter your password"
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
