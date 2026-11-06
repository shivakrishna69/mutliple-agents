/**
 * Register: POST /api/auth/signup { firstName, lastName, email, phoneCountry, phoneNumber,
 * dateOfBirth, gender, password, confirmPassword, acceptTerms }.
 *
 *   202  the account waits for its email to be confirmed: on to "verify your email" with the
 *        server's message, the address, the code length and when another email may be asked for
 *   400  the server's message for each field, under that field
 *   429  (another email a moment ago, or too many signups from this network) the server's message
 *
 * The page checks nothing itself: only the server decides what is acceptable. The phone countries,
 * the starting country, the gender choices and the minimum age come from the server
 * (GET /api/auth/options); the date of birth is typed as mm/dd/yyyy and sent as YYYY-MM-DD.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { requestSignup } from '../api/authApi.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import FormField from '../components/FormField.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SubmitButton from '../components/SubmitButton.jsx';
import { BirthDateField, PhoneNumberField, SelectField } from '../components/auth/AuthFields.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { CheckboxField } from '../components/auth/AuthNotices.jsx';
import TermsAgreement from '../components/auth/TermsAgreement.jsx';
import { AUTH_SLIDES } from '../constants/authScreens.js';
import { AUTH_LINK_CLASS } from '../constants/formStyles.js';
import { BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useAuthRequest } from '../hooks/useAuthRequest.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';
import { toIsoBirthDate } from '../utils/birthDates.js';

const INITIAL_VALUES = Object.freeze({
  firstName: '',
  lastName: '',
  email: '',
  phoneCountry: null,
  phoneNumber: '',
  dateOfBirth: '',
  gender: '',
  password: '',
  confirmPassword: '',
});

const fieldGap = 'gap-x-[clamp(0.75rem,1.2vw,1.1rem)] gap-y-[clamp(0.6rem,1.7vh,1rem)]';

export default function Signup() {
  const navigate = useNavigate();
  const { branding, options } = usePublicAuthSettings();
  const { run, isSubmitting, error, fieldErrors, clearError } = useAuthRequest();
  const [values, setValues] = useState(INITIAL_VALUES);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const phoneCountry = values.phoneCountry ?? options?.defaultPhoneCountry ?? '';

  const setValue = (field) => (value) => setValues((previous) => ({ ...previous, [field]: value }));
  const updateField = (changeEvent) => setValue(changeEvent.target.name)(changeEvent.target.value);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    const accepted = await run((signal) =>
      requestSignup(
        {
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          phoneCountry: phoneCountry || undefined,
          phoneNumber: values.phoneNumber,
          dateOfBirth: toIsoBirthDate(values.dateOfBirth),
          gender: values.gender,
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
      appearance="auth"
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
      slides={AUTH_SLIDES.SIGN_UP}
      title="Create your Account"
      description="Create your account to get started"
      footer={
        <>
          Already have an account?{' '}
          <Link to={ROUTE_PATHS.LOGIN} className={AUTH_LINK_CLASS}>
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-[clamp(0.8rem,2.2vh,1.3rem)]">
        {error && (
          <ErrorBanner
            title={BANNER_TITLES.SIGNUP_FAILED}
            message={error.message}
            requestId={error.requestId}
            onDismiss={clearError}
          />
        )}
        <fieldset disabled={isSubmitting} className={`grid sm:grid-cols-2 ${fieldGap}`}>
          {textField('firstName', 'First Name', { placeholder: 'First name', autoCompleteHint: 'given-name' })}
          {textField('lastName', 'Last Name', { placeholder: 'Last name', autoCompleteHint: 'family-name' })}
          {textField('email', 'Email', {
            inputType: 'email',
            placeholder: 'example@gmail.com',
            autoCompleteHint: 'email',
          })}
          <PhoneNumberField
            fieldId="phoneNumber"
            label="Phone Number"
            countries={options?.phoneCountries ?? []}
            countryCode={phoneCountry}
            onCountryChange={setValue('phoneCountry')}
            value={values.phoneNumber}
            onChange={setValue('phoneNumber')}
            errorMessage={fieldErrors.phoneNumber}
            countryErrorMessage={fieldErrors.phoneCountry}
          />
          <BirthDateField
            fieldId="dateOfBirth"
            label="Date of Birth"
            value={values.dateOfBirth}
            onChange={setValue('dateOfBirth')}
            minimumAgeYears={options?.minimumSignupAgeYears}
            errorMessage={fieldErrors.dateOfBirth}
          />
          <SelectField
            fieldId="gender"
            label="Gender"
            placeholder="Select gender"
            choices={options?.genders ?? []}
            value={values.gender}
            onChange={setValue('gender')}
            errorMessage={fieldErrors.gender}
          />
          <PasswordField
            appearance="auth"
            fieldId="password"
            label="Password"
            placeholder="Minimum 8 characters"
            fieldValue={values.password}
            errorMessage={fieldErrors.password}
            autoCompleteHint="new-password"
            onFieldChange={updateField}
          />
          <PasswordField
            appearance="auth"
            fieldId="confirmPassword"
            label="Confirm Password"
            placeholder="Confirm password"
            fieldValue={values.confirmPassword}
            errorMessage={fieldErrors.confirmPassword}
            autoCompleteHint="new-password"
            onFieldChange={updateField}
          />
          <div className="sm:col-span-2">
            <CheckboxField
              fieldId="acceptTerms"
              checked={acceptTerms}
              onChange={setAcceptTerms}
              errorMessage={fieldErrors.acceptTerms}
            >
              <TermsAgreement branding={branding} />
            </CheckboxField>
          </div>
        </fieldset>
        <SubmitButton
          appearance="auth"
          isSubmitting={isSubmitting}
          idleLabel="Create Account"
          loadingLabel="Creating account…"
        />
      </form>
    </AuthShell>
  );
}
