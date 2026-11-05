/**
 * Public page behind the emailed invitation link: /invite/:token.
 *
 *   1. GET /api/invitations/:token shows who the invitation is for, from whom, as what, and the
 *      employee ID issued with it, or the server's reason it cannot be used (invalid, expired, used).
 *   2. The person chooses a password (the server's strength meter and checklist), repeats it, and
 *      agrees to the terms.
 *   3. POST /api/invitations/:token/accept { password, confirmPassword, acceptTerms } creates the
 *      account and employee record and signs them in; every refusal is the server's message, under
 *      the field it concerns.
 *
 * The token stays in the URL only; it is never stored. The backend sends Referrer-Policy:
 * no-referrer for these routes.
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { requestInvitationAcceptance, requestInvitationPreview } from '../api/peopleApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { BuildingIcon, LockIcon, QuestionIcon, UserCircleIcon } from '../components/Icons.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { LoadingBlock, formatDate } from '../components/ui.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { CheckboxField } from '../components/auth/AuthNotices.jsx';
import PasswordStrength from '../components/auth/PasswordStrength.jsx';
import TermsAgreement from '../components/auth/TermsAgreement.jsx';
import { INVITATION_HERO } from '../constants/authScreens.js';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const PASSWORD_REQUIREMENTS_ID = 'invite-password-requirements';
const linkClass =
  'rounded font-semibold text-brand-600 hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

const initialsOf = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

function InvitationCard({ invitation }) {
  const role = [invitation.designation, invitation.departmentName].filter(Boolean).join(', ');
  return (
    <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start gap-4">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold text-brand-700"
          aria-hidden="true"
        >
          {initialsOf(invitation.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">{invitation.name}</p>
          <p className="truncate text-sm text-slate-600">{invitation.email}</p>
          <ul className="mt-2 space-y-1 text-xs text-slate-500">
            <li className="flex items-center gap-1.5">
              <BuildingIcon className="h-4 w-4" />
              <span>
                {invitation.companyName}
                {invitation.employeeCode ? ` · ${invitation.employeeCode}` : ''}
              </span>
            </li>
            <li className="flex items-center gap-1.5">
              <UserCircleIcon className="h-4 w-4" />
              <span>
                {role}
                {invitation.inviterName ? ` · invited by ${invitation.inviterName}` : ''}
              </span>
            </li>
          </ul>
        </div>
      </div>
      <p className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-500">
        This link works until {formatDate(invitation.expiresAt)}.
      </p>
    </div>
  );
}

export default function AcceptInvitation() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { establishSession } = useAuth();
  const { branding, passwordPolicy } = usePublicAuthSettings();
  const preview = useApiResource((signal) => requestInvitationPreview(token, signal), [token]);
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    const session = await run(() => requestInvitationAcceptance(token, { password, confirmPassword, acceptTerms }));
    if (!session) return;
    establishSession(session);
    navigate(ROUTE_PATHS.DASHBOARD, { replace: true });
  }

  const signInFooter = (
    <>
      Already activated?{' '}
      <Link to={ROUTE_PATHS.LOGIN} className={linkClass}>
        Sign in
      </Link>
    </>
  );

  if (preview.isLoading && !preview.data) {
    return (
      <AuthShell branding={branding} hero={INVITATION_HERO} title="Opening your invitation">
        <LoadingBlock />
      </AuthShell>
    );
  }

  if (preview.error) {
    return (
      <AuthShell branding={branding} hero={INVITATION_HERO} title="This invitation can't be used" footer={signInFooter}>
        <ErrorBanner title={BANNER_TITLES.LINK_NOT_USABLE} message={preview.error.message} />
      </AuthShell>
    );
  }

  const { invitation } = preview.data;
  return (
    <AuthShell
      branding={branding}
      hero={INVITATION_HERO}
      title={`Welcome, ${invitation.name.split(' ')[0]}!`}
      description="Set your password to activate your account."
      footer={signInFooter}
    >
      <InvitationCard invitation={invitation} />
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
              label="Password"
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
            label="Confirm password"
            placeholder="Re-enter your password"
            fieldValue={confirmPassword}
            errorMessage={fieldErrors.confirmPassword}
            autoCompleteHint="new-password"
            leadingIcon={<LockIcon className="h-5 w-5" />}
            onFieldChange={(changeEvent) => setConfirmPassword(changeEvent.target.value)}
          />
          <CheckboxField
            fieldId="acceptTerms"
            checked={acceptTerms}
            onChange={setAcceptTerms}
            errorMessage={fieldErrors.acceptTerms}
          >
            <TermsAgreement branding={{ ...branding, name: invitation.companyName }} />
          </CheckboxField>
        </fieldset>
        <SubmitButton isSubmitting={isSubmitting} idleLabel="Activate my account" loadingLabel="Activating…" />
      </form>
      {branding?.supportEmail && (
        <div className="mt-6 flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <span className="flex items-center gap-2">
            <QuestionIcon className="h-5 w-5 text-slate-400" />
            Having trouble with this invitation?
          </span>
          <a href={`mailto:${branding.supportEmail}`} className={linkClass}>
            Contact HR
          </a>
        </div>
      )}
    </AuthShell>
  );
}
