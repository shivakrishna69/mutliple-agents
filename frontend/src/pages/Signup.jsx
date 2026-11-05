/**
 * Register: POST /api/auth/signup { firstName, lastName, email, phoneNumber, password,
 * confirmPassword, acceptTerms }.
 *
 *   202  the account waits for its email to be confirmed: on to "check your email" with the
 *        server's message, the address, the code length and when another email may be asked for
 *   400  the server's message for each field, under that field
 *   429  (another email a moment ago, or too many signups from this network) the server's message
 *
 * The page checks nothing itself: the strength meter and checklist come from the server's password
 * policy, and only the server decides what is acceptable. The terms link to the company's own
 * documents when it has set them (company branding).
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { requestSignup } from '../api/authApi.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import { LockIcon, MailIcon, PhoneIcon, UserCircleIcon } from '../components/Icons.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { CheckboxField } from '../components/auth/AuthNotices.jsx';
import PasswordStrength from '../components/auth/PasswordStrength.jsx';
import TermsAgreement from '../components/auth/TermsAgreement.jsx';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const PASSWORD_REQUIREMENTS_ID = 'signup-password-requirements';

const INITIAL_VALUES = Object.freeze({
  firstName: '',
  lastName: '',
  email: '',
  phoneNumber: '',
  password: '',
  confirmPassword: '',
});

export default function Signup() {
  const navigate = useNavigate();
  const { branding, passwordPolicy } = usePublicAuthSettings();
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();
  const [values, setValues] = useState(INITIAL_VALUES);
  const [acceptTerms, setAcceptTerms] = useState(false);

  const updateField = (changeEvent) =>
    setValues((previous) => ({ ...previous, [changeEvent.target.name]: changeEvent.target.value }));

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    const accepted = await run((signal) =>
      requestSignup(
        {
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          phoneNumber: values.phoneNumber,
          password: values.password,
          confirmPassword: values.confirmPassword,
          acceptTerms,
        },
        { signal },
      ),
    );
    if (!accepted) return;
    navigate(`${ROUTE_PATHS.CHECK_EMAIL}?email=${encodeURIComponent(accepted.email)}`, {
      state: {
        notice: accepted.message,
        resendAfterSeconds: accepted.resendAfterSeconds,
        codeDigits: accepted.codeDigits,
      },
    });
  }

  const textField = (fieldId, label, props) => (
    <FormField
      fieldId={fieldId}
      label={label}
      fieldValue={values[fieldId]}
      errorMessage={fieldErrors[fieldId]}
      onFieldChange={updateField}
      {...props}
    />
  );

  return (
    <AuthShell
      branding={branding}
      activeLink="signup"
      title="Create your account"
      description="We will email you a code to confirm your address."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to={ROUTE_PATHS.LOGIN}
            className="rounded font-semibold text-brand-600 hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.SIGNUP_FAILED}
            message={error.message}
            requestId={error.requestId}
            onDismiss={clearError}
          />
        )}
        <fieldset disabled={isSubmitting} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {textField('firstName', 'First name', {
              placeholder: 'Jane',
              autoCompleteHint: 'given-name',
              leadingIcon: <UserCircleIcon className="h-5 w-5" />,
            })}
            {textField('lastName', 'Last name', {
              placeholder: 'Cooper',
              autoCompleteHint: 'family-name',
              leadingIcon: <UserCircleIcon className="h-5 w-5" />,
            })}
          </div>
          {textField('email', 'Work email address', {
            inputType: 'email',
            placeholder: 'you@company.com',
            autoCompleteHint: 'email',
            leadingIcon: <MailIcon className="h-5 w-5" />,
          })}
          {textField('phoneNumber', 'Phone number', {
            inputType: 'tel',
            placeholder: '98765 43210',
            autoCompleteHint: 'tel',
            leadingIcon: <PhoneIcon className="h-5 w-5" />,
          })}
          <div>
            <PasswordField
              fieldId="password"
              label="Password"
              placeholder="Create a strong password"
              fieldValue={values.password}
              errorMessage={fieldErrors.password}
              autoCompleteHint="new-password"
              describedByIds={passwordPolicy ? [PASSWORD_REQUIREMENTS_ID] : []}
              leadingIcon={<LockIcon className="h-5 w-5" />}
              onFieldChange={updateField}
            />
            <PasswordStrength
              password={values.password}
              passwordPolicy={passwordPolicy}
              listId={PASSWORD_REQUIREMENTS_ID}
            />
          </div>
          <PasswordField
            fieldId="confirmPassword"
            label="Confirm password"
            placeholder="Re-enter your password"
            fieldValue={values.confirmPassword}
            errorMessage={fieldErrors.confirmPassword}
            autoCompleteHint="new-password"
            leadingIcon={<LockIcon className="h-5 w-5" />}
            onFieldChange={updateField}
          />
          <CheckboxField
            fieldId="acceptTerms"
            checked={acceptTerms}
            onChange={setAcceptTerms}
            errorMessage={fieldErrors.acceptTerms}
          >
            <TermsAgreement branding={branding} />
          </CheckboxField>
        </fieldset>
        <SubmitButton isSubmitting={isSubmitting} idleLabel="Create account" loadingLabel="Creating account…" />
      </form>
    </AuthShell>
  );
}
