/**
 * A department agent's settings (PATCH /api/departments/:departmentId/agent/settings): its name, the
 * department's instructions, Active or Paused, and its lead. Only the changed fields are sent, with
 * the version they were based on; an edit made meanwhile by someone else is refused (STALE_VERSION)
 * and the page offers to load the latest.
 *
 * The lead picker (GET /lead-candidates) searches the department's active employees as you type.
 * Only an administrator or the department head may change the lead (settings.permissions); a lead
 * sees who it is.
 */

import { useEffect, useState } from 'react';
import { requestKnowledgeSettingsUpdate, requestLeadCandidates } from '../../api/knowledgeApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { AGENT_STATUSES, LEAD_SEARCH_DEBOUNCE_MS } from '../../constants/knowledge.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { Button, Card, Field, Notice, SelectInput, TextInput, Toggle } from '../ui.jsx';

const NO_LEAD = '';
const STALE_VERSION_CODE = 'STALE_VERSION';

const personLabel = (person) => `${person.name} · ${person.email}`;

const formFromSettings = (settings) => ({
  name: settings.name,
  systemPrompt: settings.systemPrompt,
  status: settings.status,
  leadId: settings.lead?.id ?? NO_LEAD,
});

/** Only what differs from the saved settings, as the API takes it. */
function changesOf(form, settings) {
  const saved = formFromSettings(settings);
  const changes = {};
  if (form.name.trim() !== saved.name) changes.name = form.name.trim();
  if (form.systemPrompt !== saved.systemPrompt) changes.systemPrompt = form.systemPrompt;
  if (form.status !== saved.status) changes.status = form.status;
  if (form.leadId !== saved.leadId) changes.managedBy = form.leadId || null;
  return changes;
}

function useDebouncedValue(value, delayMs) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debouncedValue;
}

function LeadPicker({ departmentId, currentLead, value, onChange, error }) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), LEAD_SEARCH_DEBOUNCE_MS);
  const candidatesResource = useApiResource(
    (signal) => requestLeadCandidates(departmentId, debouncedSearch, signal),
    [departmentId, debouncedSearch],
  );
  const candidates = candidatesResource.data?.candidates ?? [];
  // Everyone shown so far (and the current lead), so the chosen person stays selectable whatever
  // the search lists now. Updated while rendering when a new list arrives.
  const [knownPeople, setKnownPeople] = useState(
    () => new Map(currentLead ? [[currentLead.id, personLabel(currentLead)]] : []),
  );
  const [seenCandidates, setSeenCandidates] = useState(null);
  if (candidatesResource.data && candidatesResource.data !== seenCandidates) {
    setSeenCandidates(candidatesResource.data);
    setKnownPeople(
      (previous) =>
        new Map([...previous, ...candidatesResource.data.candidates.map((person) => [person.id, personLabel(person)])]),
    );
  }
  const options = [
    { value: NO_LEAD, label: 'No lead' },
    ...candidates.map((person) => ({ value: person.id, label: personLabel(person) })),
  ];
  if (value && !candidates.some((person) => person.id === value) && knownPeople.has(value)) {
    options.push({ value, label: knownPeople.get(value) });
  }
  const hint = candidatesResource.error
    ? candidatesResource.error.message
    : candidatesResource.data?.hasMore
      ? 'Showing the first people by name; search to find others.'
      : 'Active employees of this department.';

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput
        label="Find a person"
        type="search"
        value={search}
        onChange={(changeEvent) => setSearch(changeEvent.target.value)}
        placeholder="Name or email"
        autoComplete="off"
      />
      <SelectInput
        label="Knowledge lead"
        value={value}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
        options={options}
        error={error}
        hint={hint}
      />
    </div>
  );
}

export default function KnowledgeSettingsPanel({ departmentId, settings, onSaved, onReload }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState(() => formFromSettings(settings));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedMessage, setSavedMessage] = useState(null);
  const changes = changesOf(form, settings);
  const hasChanges = Object.keys(changes).length > 0;
  const fieldErrors = saveError?.fieldErrors ?? {};
  const { limits, permissions } = settings;

  // New settings (saved here, or the latest loaded on request) replace the form, while rendering.
  const [formSettings, setFormSettings] = useState(settings);
  if (settings !== formSettings) {
    setFormSettings(settings);
    setForm(formFromSettings(settings));
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    if (!hasChanges) return;
    setIsSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    try {
      const result = await requestKnowledgeSettingsUpdate(
        departmentId,
        { ...changes, version: settings.version },
        csrfToken,
      );
      setSavedMessage(result.message);
      onSaved(result.settings);
    } catch (updateError) {
      setSaveError({ ...toDisplayError(updateError), code: updateError.code ?? null });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card title="Agent settings" subtitle="How this department's agent introduces itself and answers.">
      <form onSubmit={handleSubmit} className="space-y-6">
        {savedMessage && <Notice tone="success" title={savedMessage} onDismiss={() => setSavedMessage(null)} />}
        {saveError && (
          <Notice tone="error" title={saveError.message} onDismiss={() => setSaveError(null)}>
            {saveError.code === STALE_VERSION_CODE && (
              <Button variant="secondary" size="sm" className="mt-2" onClick={onReload}>
                Load the latest settings
              </Button>
            )}
          </Notice>
        )}

        <TextInput
          label="Agent name"
          value={form.name}
          onChange={(changeEvent) => setForm({ ...form, name: changeEvent.target.value })}
          maxLength={limits.nameMaxLength}
          error={fieldErrors.name}
          required
        />

        <Field
          label="Instructions"
          error={fieldErrors.systemPrompt}
          hint={`${form.systemPrompt.length.toLocaleString('en-IN')} of ${limits.systemPromptMaxLength.toLocaleString('en-IN')} characters. What the agent should focus on, how it should answer, and what it must not do.`}
        >
          {(controlId, inputClassName) => (
            <textarea
              id={controlId}
              className={`${inputClassName} min-h-40 resize-y`}
              value={form.systemPrompt}
              maxLength={limits.systemPromptMaxLength}
              onChange={(changeEvent) => setForm({ ...form, systemPrompt: changeEvent.target.value })}
              placeholder="Answer from the department handbook. Say when you do not know."
              aria-invalid={Boolean(fieldErrors.systemPrompt) || undefined}
            />
          )}
        </Field>

        <Toggle
          label="Agent active"
          description={
            form.status === AGENT_STATUSES.ACTIVE
              ? 'The agent is in use and takes new documents.'
              : 'Paused: no new documents are taken until it is active again.'
          }
          checked={form.status === AGENT_STATUSES.ACTIVE}
          onChange={(isActive) =>
            setForm({ ...form, status: isActive ? AGENT_STATUSES.ACTIVE : AGENT_STATUSES.PAUSED })
          }
        />

        {permissions.canAssignLead ? (
          <LeadPicker
            departmentId={departmentId}
            currentLead={settings.lead}
            value={form.leadId}
            onChange={(leadId) => setForm({ ...form, leadId })}
            error={fieldErrors.managedBy}
          />
        ) : (
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200/70">
            <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">Knowledge lead</p>
            <p className="mt-1 text-slate-800">{settings.lead ? personLabel(settings.lead) : 'No lead'}</p>
            <p className="mt-1 text-xs text-slate-500">
              Only an administrator or the department head can change the lead.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button
            variant="ghost"
            disabled={!hasChanges || isSaving}
            onClick={() => setForm(formFromSettings(settings))}
          >
            Discard changes
          </Button>
          <Button type="submit" isBusy={isSaving} disabled={!hasChanges}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}
