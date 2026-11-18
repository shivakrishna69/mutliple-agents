/**
 * Offer settings (Offers → Offer settings): what every offer letter says, and the salary structure
 * policy offers are worked out with (GET/PATCH /api/hr/onboarding/settings).
 *
 *   Signatory            name and title printed in both signature blocks (an offer cannot be sent
 *                        without the name)
 *   Standard terms       probation, notice period, offer validity, weekly hours and working days/times
 *   Clauses & annexures  confidentiality, IP assignment, non-solicitation (with its months),
 *                        background verification, the stock option note, further terms and the
 *                        joining documents (one per line)
 *   Salary split policy  Basic as a share of CTC, HRA as a share of Basic (50% cities and elsewhere),
 *                        PF on the whole Basic, gratuity inside the CTC
 *
 * Who may change what follows the backend: the terms need manage_offers, the policy
 * manage_compensation; anyone else sees them read-only. Only what changed is sent, with the version
 * loaded, so two people editing at once cannot overwrite each other. Every message is the backend's.
 */

import { useState } from 'react';
import { requestOfferSettingsUpdate } from '../../api/offersApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { hasCapability } from '../../auth/capabilities.js';
import { CAPABILITIES } from '../../constants/capabilities.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { settingsChangeRequest, settingsFormFrom } from '../../utils/offerSettings.js';
import Dialog from '../Dialog.jsx';
import { Button, Field, Notice, TextInput, Toggle } from '../ui.jsx';

export const SIGNATORY_FIELD = 'signatoryName';

function Section({ title, description, children, columns = 2 }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</legend>
      {description && <p className="-mt-1 text-xs text-slate-500">{description}</p>}
      <div className={columns === 2 ? 'grid gap-3 sm:grid-cols-2' : 'space-y-3'}>{children}</div>
    </fieldset>
  );
}

function TextArea({ label, hint, error, rows = 4, ...props }) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(controlId, className) => (
        <textarea
          id={controlId}
          rows={rows}
          className={`${className} resize-y`}
          aria-invalid={Boolean(error) || undefined}
          {...props}
        />
      )}
    </Field>
  );
}

const yesNo = (value) => (value ? 'Yes' : 'No');

export default function OfferSettingsDialog({ settings, choices, focusField = null, onSaved, onClose }) {
  const { currentUser, csrfToken } = useAuth();
  const canEditTerms = hasCapability(currentUser, CAPABILITIES.MANAGE_OFFERS);
  const canEditCompensation = hasCapability(currentUser, CAPABILITIES.MANAGE_COMPENSATION);
  const [form, setForm] = useState(() => settingsFormFrom(settings));
  const [problem, setProblem] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const limits = choices.limits;

  const setTerm = (field) => (changeEvent) =>
    setForm({ ...form, offerTerms: { ...form.offerTerms, [field]: changeEvent.target.value } });
  const setCompensation = (field, value) =>
    setForm({ ...form, compensation: { ...form.compensation, [field]: value } });
  const errorOf = (group, field) => problem?.fieldErrors?.[`${group}.${field}`] ?? problem?.fieldErrors?.[field];

  const term = (field, label, props = {}) => (
    <TextInput
      label={label}
      value={form.offerTerms[field]}
      onChange={setTerm(field)}
      error={errorOf('offerTerms', field)}
      disabled={!canEditTerms}
      data-autofocus={field === focusField || undefined}
      {...props}
    />
  );
  const termText = (field, label, props = {}) => (
    <TextArea
      label={label}
      value={form.offerTerms[field]}
      onChange={setTerm(field)}
      error={errorOf('offerTerms', field)}
      disabled={!canEditTerms}
      {...props}
    />
  );
  const rate = (field, label, props = {}) => (
    <TextInput
      label={label}
      type="number"
      step="0.01"
      value={form.compensation[field]}
      onChange={(changeEvent) => setCompensation(field, changeEvent.target.value)}
      error={errorOf('compensation', field)}
      {...props}
    />
  );

  async function save() {
    const request = settingsChangeRequest(form, settings, { canEditTerms, canEditCompensation });
    if (!request) {
      onClose();
      return;
    }
    setIsSaving(true);
    setProblem(null);
    try {
      const result = await requestOfferSettingsUpdate(request, csrfToken);
      onSaved(result.settings, result.notice);
    } catch (saveError) {
      setProblem(toDisplayError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  const canSave = canEditTerms || canEditCompensation;
  const { compensation } = form;

  return (
    <Dialog title="Offer settings" size="lg" onClose={onClose}>
      <form
        className="space-y-6"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          save();
        }}
      >
        {problem && <Notice tone="error" title={problem.message} />}
        {!canEditTerms && (
          <Notice tone="info" title="The offer terms are read-only for your role; HR and administrators change them." />
        )}

        <Section title="Signatory" description="Printed in the signature blocks of every offer letter.">
          {term(SIGNATORY_FIELD, 'Signatory name', {
            maxLength: limits.signatoryMaxLength,
            hint: 'Required before an offer can be sent',
          })}
          {term('signatoryTitle', 'Signatory designation', {
            maxLength: limits.signatoryMaxLength,
            placeholder: 'e.g. Manager - HR',
          })}
        </Section>

        <Section title="Standard terms">
          {term('probationMonths', 'Probation (months)', {
            type: 'number',
            min: 0,
            max: limits.probationMonthsMax,
          })}
          {term('noticePeriodDays', 'Notice period (days)', {
            type: 'number',
            min: 0,
            max: limits.noticePeriodDaysMax,
          })}
          {term('offerValidityDays', 'Offer open for (days)', {
            type: 'number',
            min: 1,
            max: limits.offerValidityDaysMax,
          })}
          {term('weeklyWorkingHours', 'Working hours a week', {
            type: 'number',
            min: 1,
            max: limits.weeklyWorkingHoursMax,
          })}
          {term('shiftTimings', 'Working days and times', {
            maxLength: limits.shiftTimingsMaxLength,
            placeholder: 'e.g. 9:30 am to 6:30 pm, Monday to Friday',
            className: 'sm:col-span-2',
          })}
        </Section>

        <Section title="Clauses and annexures" columns={1}>
          {termText('confidentialityClause', 'Confidentiality', { maxLength: limits.legalClauseMaxLength })}
          {termText('ipAssignmentClause', 'Intellectual property assignment', {
            maxLength: limits.legalClauseMaxLength,
          })}
          {termText('nonSolicitationClause', 'Non-solicitation', { maxLength: limits.legalClauseMaxLength })}
          {term('nonSolicitationMonths', 'Non-solicitation after leaving (months)', {
            type: 'number',
            min: 0,
            max: limits.nonSolicitationMonthsMax,
          })}
          {termText('backgroundVerificationClause', 'Background verification', {
            maxLength: limits.legalClauseMaxLength,
          })}
          {termText('esopNote', 'Stock options and benefits note', { rows: 2, maxLength: limits.esopNoteMaxLength })}
          {termText('additionalClauses', 'Further terms', {
            hint: `One per line, at most ${limits.clausesMax} of up to ${limits.clauseMaxLength} characters`,
          })}
          {termText('joiningChecklist', 'Documents to submit on joining', {
            rows: 6,
            hint: `One per line, at most ${limits.checklistItemsMax} of up to ${limits.checklistItemMaxLength} characters`,
          })}
        </Section>

        <Section
          title="Salary split policy"
          description="How every new offer’s CTC is split; offers already saved keep their figures."
        >
          {canEditCompensation ? (
            <>
              {rate('basicShareBasisPoints', 'Basic (% of CTC)', {
                min: limits.basicShareMinBasisPoints / 100,
                max: limits.basicShareMaxBasisPoints / 100,
              })}
              <div className="hidden sm:block" />
              {rate('hraFiftyPercentCityBasisPoints', 'HRA in metro cities (% of Basic)', {
                min: 0,
                max: limits.hraMaxBasisPoints / 100,
                hint: 'Delhi, Mumbai, Kolkata, Chennai and the other 50% cities',
              })}
              {rate('hraOtherCityBasisPoints', 'HRA elsewhere (% of Basic)', {
                min: 0,
                max: limits.hraMaxBasisPoints / 100,
              })}
              <Toggle
                label="PF on the whole Basic"
                description="Off: on Basic up to the statutory wage ceiling"
                checked={compensation.pfOnFullBasic}
                onChange={(checked) => setCompensation('pfOnFullBasic', checked)}
              />
              <Toggle
                label="Gratuity inside the CTC"
                description="Counted as an employer contribution within the CTC"
                checked={compensation.includeGratuityInCtc}
                onChange={(checked) => setCompensation('includeGratuityInCtc', checked)}
              />
            </>
          ) : (
            <dl className="grid gap-2 text-sm sm:col-span-2 sm:grid-cols-2" aria-label="Salary split policy">
              {[
                ['Basic (% of CTC)', `${compensation.basicShareBasisPoints}%`],
                ['HRA in metro cities (% of Basic)', `${compensation.hraFiftyPercentCityBasisPoints}%`],
                ['HRA elsewhere (% of Basic)', `${compensation.hraOtherCityBasisPoints}%`],
                ['PF on the whole Basic', yesNo(compensation.pfOnFullBasic)],
                ['Gratuity inside the CTC', yesNo(compensation.includeGratuityInCtc)],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
                  <dt className="text-slate-600">{label}</dt>
                  <dd className="font-medium text-slate-900">{value}</dd>
                </div>
              ))}
              <p className="text-xs text-slate-500 sm:col-span-2">
                Read-only: people who manage compensation (administrators, HR and finance) change the policy.
              </p>
            </dl>
          )}
        </Section>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="ghost" onClick={onClose}>
            {canSave ? 'Cancel' : 'Close'}
          </Button>
          {canSave && (
            <Button type="submit" isBusy={isSaving}>
              Save settings
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
