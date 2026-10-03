/**
 * Account: the signed-in user's profile and password change, rendered inside AppShell.
 *
 * Change password (POST /api/auth/password)
 *   - Validation mirrors the backend (validation/authFormValidation.js validateChangePasswordForm):
 *     current password required; the new one must pass the signup strength rules and differ from
 *     the current one; the confirmation must match exactly. Errors show once a field is blurred or
 *     a submit was attempted; the checklist and the match check update live.
 *   - On success the backend signs out every other device and issues a new session for this
 *     browser. The returned `{ user, csrfToken }` replaces the in-memory session (the old CSRF
 *     token no longer works), the form is cleared, and a confirmation is shown.
 *   - A wrong current password comes back as a 400 with an inline error on that field.
 *   - Passwords are held only in component state while typing and cleared after success.
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError, requestChangePassword } from '../api/authApi.js';
import { HTTP_STATUS_UNAUTHORIZED } from '../api/httpClient.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { KeyIcon, ShieldIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import PasswordChecklist from '../components/PasswordChecklist.jsx';
import PasswordField from '../components/PasswordField.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { API_MESSAGES, BANNER_TITLES, FORM_MESSAGES, SUCCESS_MESSAGES } from '../constants/messages.js';
import { ROLE_DISPLAY } from '../constants/routes.js';
import { evaluatePasswordRules, validateChangePasswordForm } from '../validation/authFormValidation.js';

const INITIAL_FORM_VALUES = Object.freeze({ currentPassword: '', newPassword: '', confirmPassword: '' });
const FIELD_ORDER = Object.freeze(['currentPassword', 'newPassword', 'confirmPassword']);
const NEW_PASSWORD_REQUIREMENTS_ID = 'new-password-requirements';

const memberSinceFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

function formatMemberSince(isoTimestamp) {
  const parsedDate = isoTimestamp ? new Date(isoTimestamp) : null;
  return parsedDate && !Number.isNaN(parsedDate.getTime()) ? memberSinceFormatter.format(parsedDate) : '—';
}

function ProfileRow({ label, children }) {
  return (
    <div className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-sm font-medium text-slate-900">{children}</dd>
    </div>
  );
}

function ChangePasswordForm() {
  const { csrfToken, establishSession, markSessionEnded } = useAuth();

  const [formValues, setFormValues] = useState(INITIAL_FORM_VALUES);
  const [touchedFields, setTouchedFields] = useState({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState({});
  const [submissionError, setSubmissionError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Remounts the password fields after success so each visibility toggle resets to hidden.
  const [formGeneration, setFormGeneration] = useState(0);

  const isSubmittingRef = useRef(false);
  const activeRequestControllerRef = useRef(null);
  const inputRefsByField = {
    currentPassword: useRef(null),
    newPassword: useRef(null),
    confirmPassword: useRef(null),
  };

  useEffect(() => () => activeRequestControllerRef.current?.abort(), []);

  const clientFieldErrors = validateChangePasswordForm(formValues);
  const passwordRuleResults = evaluatePasswordRules(formValues.newPassword);
  const passwordMatchError =
    formValues.confirmPassword.length > 0 && formValues.confirmPassword !== formValues.newPassword ? FORM_MESSAGES.PASSWORDS_DO_NOT_MATCH : null;

  function resolveVisibleFieldError(fieldName) {
    const isFieldRevealed = hasAttemptedSubmit || touchedFields[fieldName];
    if (isFieldRevealed && clientFieldErrors[fieldName]) return clientFieldErrors[fieldName];
    if (fieldName === 'confirmPassword' && passwordMatchError) return passwordMatchError;
    return serverFieldErrors[fieldName] ?? null;
  }

  function handleFieldChange(changeEvent) {
    const { name: fieldName, value: fieldValue } = changeEvent.target;
    setFormValues((previousValues) => ({ ...previousValues, [fieldName]: fieldValue }));
    setSuccessMessage(null);
    setServerFieldErrors((previousErrors) => {
      if (!(fieldName in previousErrors)) return previousErrors;
      const { [fieldName]: clearedError, ...remainingErrors } = previousErrors;
      return remainingErrors;
    });
  }

  function handleFieldBlur(blurEvent) {
    const fieldName = blurEvent.target.name;
    setTouchedFields((previousTouched) => (previousTouched[fieldName] ? previousTouched : { ...previousTouched, [fieldName]: true }));
  }

  async function handleFormSubmit(submitEvent) {
    submitEvent.preventDefault();
    if (isSubmittingRef.current) return;

    setHasAttemptedSubmit(true);
    const firstInvalidField = FIELD_ORDER.find((fieldName) => clientFieldErrors[fieldName]);
    if (firstInvalidField) {
      inputRefsByField[firstInvalidField].current?.focus();
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setSubmissionError(null);
    setServerFieldErrors({});
    setSuccessMessage(null);

    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;

    try {
      const sessionResult = await requestChangePassword(
        { currentPassword: formValues.currentPassword, newPassword: formValues.newPassword },
        csrfToken,
        { signal: requestController.signal },
      );
      establishSession(sessionResult);
      setFormValues(INITIAL_FORM_VALUES);
      setTouchedFields({});
      setHasAttemptedSubmit(false);
      setFormGeneration((previousGeneration) => previousGeneration + 1);
      setSuccessMessage(SUCCESS_MESSAGES.PASSWORD_CHANGED);
    } catch (changeError) {
      if (requestController.signal.aborted) return;
      if (changeError instanceof ApiError && changeError.status === HTTP_STATUS_UNAUTHORIZED) {
        markSessionEnded();
        return;
      }
      if (changeError instanceof ApiError) {
        setServerFieldErrors(changeError.fieldErrors);
        // A field-level error is shown inline; a banner is only needed for anything else.
        if (Object.keys(changeError.fieldErrors).length === 0) {
          setSubmissionError({ message: changeError.message, requestId: changeError.status >= 500 ? changeError.requestId : null });
        } else if (changeError.fieldErrors.currentPassword) {
          inputRefsByField.currentPassword.current?.focus();
        }
      } else {
        setSubmissionError({ message: API_MESSAGES.UNEXPECTED_SERVER_ERROR, requestId: null });
      }
    } finally {
      if (activeRequestControllerRef.current === requestController) activeRequestControllerRef.current = null;
      if (!requestController.signal.aborted) {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    }
  }

  return (
    <form onSubmit={handleFormSubmit} noValidate className="space-y-5" key={formGeneration}>
      {submissionError && (
        <ErrorBanner title={BANNER_TITLES.PASSWORD_CHANGE_FAILED} message={submissionError.message} requestId={submissionError.requestId} onDismiss={() => setSubmissionError(null)} />
      )}
      {successMessage && (
        <p role="status" className="flex items-start gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-600/20 ring-inset">
          <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0" />
          {successMessage}
        </p>
      )}

      <fieldset disabled={isSubmitting} className="space-y-5">
        <PasswordField
          fieldId="currentPassword"
          label="Current password"
          placeholder="Enter your current password"
          fieldValue={formValues.currentPassword}
          errorMessage={resolveVisibleFieldError('currentPassword')}
          autoCompleteHint="current-password"
          inputRef={inputRefsByField.currentPassword}
          onFieldChange={handleFieldChange}
          onFieldBlur={handleFieldBlur}
        />
        <PasswordField
          fieldId="newPassword"
          label="New password"
          placeholder="Create a strong password"
          fieldValue={formValues.newPassword}
          errorMessage={resolveVisibleFieldError('newPassword')}
          autoCompleteHint="new-password"
          inputRef={inputRefsByField.newPassword}
          describedByIds={[NEW_PASSWORD_REQUIREMENTS_ID]}
          onFieldChange={handleFieldChange}
          onFieldBlur={handleFieldBlur}
        >
          <PasswordChecklist listId={NEW_PASSWORD_REQUIREMENTS_ID} ruleResults={passwordRuleResults} />
        </PasswordField>
        <PasswordField
          fieldId="confirmPassword"
          label="Confirm new password"
          placeholder="Re-enter the new password"
          fieldValue={formValues.confirmPassword}
          errorMessage={resolveVisibleFieldError('confirmPassword')}
          autoCompleteHint="new-password"
          inputRef={inputRefsByField.confirmPassword}
          onFieldChange={handleFieldChange}
          onFieldBlur={handleFieldBlur}
        />
      </fieldset>

      <div className="sm:w-56">
        <SubmitButton isSubmitting={isSubmitting} idleLabel="Update password" loadingLabel="Updating…" />
      </div>
    </form>
  );
}

export default function Account() {
  const { currentUser } = useAuth();
  const roleDisplay = ROLE_DISPLAY[currentUser.role];

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-8 lg:py-10">
      <PageHeader title="Account" description="Your profile and sign-in security." />

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm lg:col-span-2">
          <div className="h-20 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" aria-hidden="true" />
          <div className="px-6 pb-6">
            <span className="-mt-8 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-950 text-xl font-bold text-white ring-4 ring-white" aria-hidden="true">
              {currentUser.name.trim().charAt(0).toUpperCase()}
            </span>
            <h2 className="mt-3 text-lg font-semibold text-slate-900">{currentUser.name}</h2>
            <p className="text-sm text-slate-500">{currentUser.email}</p>
            <dl className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
              <ProfileRow label="Role">
                <RoleBadge role={currentUser.role} />
              </ProfileRow>
              <ProfileRow label="Access">
                <span className="font-normal text-slate-600">{roleDisplay?.description ?? '—'}</span>
              </ProfileRow>
              <ProfileRow label="Member since">{formatMemberSince(currentUser.createdAt)}</ProfileRow>
            </dl>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm lg:col-span-3 sm:p-8">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              <KeyIcon className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Change password</h2>
              <p className="mt-0.5 text-sm text-slate-500">You’ll stay signed in here; every other device will be signed out.</p>
            </div>
          </div>
          <div className="mt-6">
            <ChangePasswordForm />
          </div>
        </section>
      </div>
    </div>
  );
}
