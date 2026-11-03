/**
 * Company (admins): who the company is.
 *
 *   Name           in the app, in invitation and leave emails
 *   Short code     the prefix of employee IDs (NSK0001); 2-6 capital letters
 *   ID digits      how many digits IDs are padded to; IDs already issued never change
 *   Email domain   new people's company addresses are suggested in it (first.last@domain)
 *
 *   GET /api/company/settings · PATCH /api/company/settings (only the changed fields, with the version)
 *
 * The backend also keeps a logo address, brand colours and a time zone; they are not offered here
 * until the app uses them.
 */

import { useState } from 'react';
import { requestCompanySettings, requestCompanySettingsUpdate } from '../api/companyApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Button, Card, LoadingBlock, Notice, TextInput } from '../components/ui.jsx';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';

/** Mirrors backend COMPANY_LIMITS EMPLOYEE_ID_MIN_DIGITS / EMPLOYEE_ID_MAX_DIGITS (the backend checks). */
const EMPLOYEE_ID_DIGITS = Object.freeze({ min: 3, max: 8 });

function formFromSettings(settings) {
  return {
    name: settings.name,
    shortCode: settings.shortCode,
    employeeIdDigits: String(settings.employeeIdDigits),
    emailDomain: settings.emailDomain ?? '',
  };
}

/** The fields that differ from the saved settings, as the backend expects them. */
function changedFields(form, settings) {
  const submitted = {
    name: form.name.trim(),
    shortCode: form.shortCode.trim().toUpperCase(),
    employeeIdDigits: Number(form.employeeIdDigits),
    emailDomain: form.emailDomain.trim().toLowerCase() || null,
  };
  return Object.fromEntries(Object.entries(submitted).filter(([field, value]) => value !== settings[field]));
}

/** "NSK" and 4 -> "NSK0001": what the first ID with these settings looks like. */
function sampleEmployeeId(shortCode, digits) {
  const digitCount = Number(digits);
  if (!Number.isInteger(digitCount) || digitCount < 1) return '—';
  return `${shortCode.trim().toUpperCase() || '—'}${'1'.padStart(digitCount, '0')}`;
}

function CompanySettingsForm({ settings, onSaved }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState(() => formFromSettings(settings));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [hasSaved, setHasSaved] = useState(false);
  const update = (fieldName) => (changeEvent) => {
    setForm({ ...form, [fieldName]: changeEvent.target.value });
    setHasSaved(false);
  };
  const changes = changedFields(form, settings);
  const hasChanges = Object.keys(changes).length > 0;
  const fieldErrors = saveError?.fieldErrors ?? {};

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const { settings: savedSettings } = await requestCompanySettingsUpdate(
        { ...changes, version: settings.version },
        csrfToken,
      );
      setForm(formFromSettings(savedSettings));
      setHasSaved(true);
      onSaved(savedSettings);
    } catch (settingsError) {
      setSaveError(toDisplayError(settingsError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card title="Identity" subtitle="Shown across the app and in the emails people receive.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Company name"
            value={form.name}
            onChange={update('name')}
            error={fieldErrors.name}
            required
          />
          <TextInput
            label="Company email domain"
            value={form.emailDomain}
            onChange={update('emailDomain')}
            error={fieldErrors.emailDomain}
            placeholder="example.com"
            hint="New people get an address like first.last@ this domain. Leave blank if there is none yet."
          />
        </div>
      </Card>

      <Card
        title="Employee IDs"
        subtitle="Every person gets the next number once, and keeps it. Changes apply to IDs issued from now on."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <TextInput
            label="Short code"
            value={form.shortCode}
            onChange={update('shortCode')}
            error={fieldErrors.shortCode}
            hint="2 to 6 letters"
            maxLength={6}
            required
          />
          <TextInput
            label="Digits"
            type="number"
            min={EMPLOYEE_ID_DIGITS.min}
            max={EMPLOYEE_ID_DIGITS.max}
            step="1"
            value={form.employeeIdDigits}
            onChange={update('employeeIdDigits')}
            error={fieldErrors.employeeIdDigits}
            required
          />
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">IDs look like</p>
            <p className="mt-1.5 rounded-xl bg-slate-50 px-3.5 py-2.5 font-mono text-sm text-slate-900 ring-1 ring-slate-200">
              {sampleEmployeeId(form.shortCode, form.employeeIdDigits)}
            </p>
          </div>
        </div>
      </Card>

      {saveError && <Notice tone="error" title={saveError.message} onDismiss={() => setSaveError(null)} />}
      {hasSaved && <Notice tone="success" title="Company settings saved" onDismiss={() => setHasSaved(false)} />}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" disabled={!hasChanges || isSaving} onClick={() => setForm(formFromSettings(settings))}>
          Undo changes
        </Button>
        <Button type="submit" isBusy={isSaving} disabled={!hasChanges}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

export default function CompanySettings() {
  const settingsResource = useApiResource((signal) => requestCompanySettings(signal), []);
  const settings = settingsResource.data?.settings;
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title="Company" description="Your company's name, employee ID format and email domain." />
      {settingsResource.isLoading && !settings && <LoadingBlock label="Loading company settings…" />}
      {settingsResource.error && <Notice tone="error" title={settingsResource.error.message} />}
      {settings && (
        <CompanySettingsForm
          settings={settings}
          onSaved={(savedSettings) => settingsResource.setData({ settings: savedSettings })}
        />
      )}
    </div>
  );
}
