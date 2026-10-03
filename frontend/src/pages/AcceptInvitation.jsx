/**
 * Public page behind the emailed link: /invite/:token.
 *
 *   1. GET /api/invitations/:token shows who invited the person and as what (or why the link
 *      cannot be used: invalid, expired, already used).
 *   2. The person chooses a password (same strength rules and checklist as signup).
 *   3. POST /api/invitations/:token/accept creates the account and employee record and signs them
 *      in; the session is handed to AuthContext and they land on the dashboard.
 *
 * The token stays in the URL only; it is never stored. The backend sends Referrer-Policy:
 * no-referrer for these routes, and this page links only to the app itself.
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { requestInvitationAcceptance, requestInvitationPreview } from '../api/peopleApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import AuthLayout from '../components/AuthLayout.jsx';
import PasswordChecklist from '../components/PasswordChecklist.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { LoadingBlock, Notice, formatDate } from '../components/ui.jsx';
import { ROUTE_PATHS } from '../constants/routes.js';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';
import { evaluatePasswordRules } from '../validation/authFormValidation.js';

const PASSWORD_REQUIREMENTS_LIST_ID = 'invite-password-requirements';

export default function AcceptInvitation() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { establishSession } = useAuth();
  const { data, error, isLoading } = useApiResource((signal) => requestInvitationPreview(token, signal), [token]);
  const [formValues, setFormValues] = useState({ password: '', confirmPassword: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const passwordRuleResults = evaluatePasswordRules(formValues.password);

  function handleFieldChange(changeEvent) {
    const { name: fieldName, value: fieldValue } = changeEvent.target;
    setFormValues((previousValues) => ({ ...previousValues, [fieldName]: fieldValue }));
    setFieldErrors((previousErrors) => ({ ...previousErrors, [fieldName]: undefined }));
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    const nextErrors = {};
    if (!passwordRuleResults.every((ruleResult) => ruleResult.isSatisfied)) nextErrors.password = 'Choose a password that meets every rule below';
    if (formValues.confirmPassword !== formValues.password) nextErrors.confirmPassword = 'The passwords do not match';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const authResult = await requestInvitationAcceptance(token, formValues.password);
      establishSession(authResult);
      navigate(ROUTE_PATHS.DASHBOARD, { replace: true });
    } catch (acceptError) {
      const displayError = toDisplayError(acceptError);
      if (displayError.fieldErrors.password) setFieldErrors({ password: displayError.fieldErrors.password });
      else setSubmitError(displayError);
      setIsSubmitting(false);
    }
  }

  if (isLoading && !data) {
    return (
      <AuthLayout heading="Opening your invitation" subheading="One moment…">
        <LoadingBlock />
      </AuthLayout>
    );
  }

  if (error) {
    return (
      <AuthLayout heading="This invitation can't be used" subheading="Invitation links work once and expire after a few days.">
        <Notice tone="error" title={error.message} />
        <p className="mt-6 text-sm text-slate-600">
          Already activated your account?{' '}
          <Link to={ROUTE_PATHS.LOGIN} className="font-semibold text-indigo-600 hover:text-indigo-500">
            Sign in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  const invitation = data.invitation;
  return (
    <AuthLayout
      heading={`Welcome to ${invitation.companyName}, ${invitation.name.split(' ')[0]}!`}
      subheading={`You're joining as ${invitation.designation}${invitation.departmentName ? `, ${invitation.departmentName}` : ''}. Choose a password to activate your account.`}
      footer={
        <p className="text-sm text-slate-600">
          Already activated?{' '}
          <Link to={ROUTE_PATHS.LOGIN} className="font-semibold text-indigo-600 hover:text-indigo-500">
            Sign in
          </Link>
        </p>
      }
    >
      <div className="mb-6 rounded-xl bg-indigo-50 px-4 py-3 text-sm ring-1 ring-indigo-100">
        <p className="text-xs font-semibold tracking-wide text-indigo-500 uppercase">Your sign-in email</p>
        <p className="mt-0.5 font-semibold text-indigo-950">{invitation.email}</p>
        <p className="mt-1 text-xs text-indigo-700/80">This link is valid until {formatDate(invitation.expiresAt)}.</p>
      </div>
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <PasswordField
          fieldId="password"
          label="Password"
          placeholder="Create a strong password"
          fieldValue={formValues.password}
          errorMessage={fieldErrors.password}
          autoCompleteHint="new-password"
          describedByIds={[PASSWORD_REQUIREMENTS_LIST_ID]}
          onFieldChange={handleFieldChange}
          onFieldBlur={() => {}}
        >
          <PasswordChecklist listId={PASSWORD_REQUIREMENTS_LIST_ID} ruleResults={passwordRuleResults} />
        </PasswordField>
        <PasswordField
          fieldId="confirmPassword"
          label="Confirm password"
          placeholder="Re-enter your password"
          fieldValue={formValues.confirmPassword}
          errorMessage={fieldErrors.confirmPassword}
          autoCompleteHint="new-password"
          onFieldChange={handleFieldChange}
          onFieldBlur={() => {}}
        />
        {submitError && <Notice tone="error" title={submitError.message} onDismiss={() => setSubmitError(null)} />}
        <SubmitButton isSubmitting={isSubmitting} idleLabel="Activate my account" loadingLabel="Activating…" />
      </form>
    </AuthLayout>
  );
}
