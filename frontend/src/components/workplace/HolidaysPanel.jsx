/**
 * Holidays (HR and admins), by calendar year: company-wide ones, and ones for chosen offices. Two
 * holidays may not fall on the same date for the same office; the backend says so when they do.
 *
 *   GET /api/work-calendar/holidays?year=&officeLocationId= · POST /api/work-calendar/holidays
 *   PATCH /api/work-calendar/holidays/:id (with the version loaded) · DELETE …/:id
 *
 * Changing holidays changes what future leave costs; leave already approved keeps its price.
 */

import { useState } from 'react';
import {
  requestHolidayCreation,
  requestHolidayDeletion,
  requestHolidays,
  requestHolidayUpdate,
  requestOffices,
} from '../../api/workplaceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { formatCalendarDate } from '../../utils/dates.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { FlagIcon, PlusIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, SelectInput, TextInput } from '../ui.jsx';

const ALL_OFFICES = '';
const YEARS_AROUND_TODAY = [-1, 0, 1];

function HolidayForm({ holiday, offices, defaultYear, onSaved, onCancel }) {
  const { csrfToken } = useAuth();
  const isEditing = Boolean(holiday);
  const [form, setForm] = useState({
    name: holiday?.name ?? '',
    date: holiday?.date ?? `${defaultYear}-01-01`,
    officeLocationIds: holiday?.officeLocationIds ?? [],
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const appliesToAllOffices = form.officeLocationIds.length === 0;
  const fieldErrors = saveError?.fieldErrors ?? {};

  function toggleOffice(officeId) {
    const officeLocationIds = form.officeLocationIds.includes(officeId)
      ? form.officeLocationIds.filter((id) => id !== officeId)
      : [...form.officeLocationIds, officeId];
    setForm({ ...form, officeLocationIds });
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      if (isEditing) await requestHolidayUpdate(holiday.id, { ...form, version: holiday.version }, csrfToken);
      else await requestHolidayCreation(form, csrfToken);
      onSaved(form.date);
    } catch (holidayError) {
      setSaveError(toDisplayError(holidayError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card title={isEditing ? `Edit ${holiday.name}` : 'Add a holiday'}>
      <form onSubmit={handleSubmit} className="space-y-5">
        {saveError && <Notice tone="error" title={saveError.message} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Holiday name"
            value={form.name}
            onChange={(changeEvent) => setForm({ ...form, name: changeEvent.target.value })}
            error={fieldErrors.name}
            placeholder="Diwali"
            required
          />
          <TextInput
            label="Date"
            type="date"
            value={form.date}
            onChange={(changeEvent) => setForm({ ...form, date: changeEvent.target.value })}
            error={fieldErrors.date}
            required
          />
        </div>
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900">Applies to</legend>
          <div className="mt-2 space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="holiday-scope"
                checked={appliesToAllOffices}
                onChange={() => setForm({ ...form, officeLocationIds: [] })}
              />
              Every office
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="holiday-scope"
                checked={!appliesToAllOffices}
                disabled={offices.length === 0}
                onChange={() => offices[0] && setForm({ ...form, officeLocationIds: [offices[0].id] })}
              />
              Only some offices
            </label>
            {!appliesToAllOffices && (
              <div className="ml-6 flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label="Offices">
                {offices.map((office) => (
                  <label key={office.id} className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 text-indigo-600"
                      checked={form.officeLocationIds.includes(office.id)}
                      onChange={() => toggleOffice(office.id)}
                    />
                    {office.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          {fieldErrors.officeLocationIds && (
            <p className="mt-1 text-xs text-rose-600">{fieldErrors.officeLocationIds}</p>
          )}
        </fieldset>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving}>
            {isEditing ? 'Save holiday' : 'Add holiday'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function HolidayRow({ holiday, officeNameById, onEdit, onRemoved }) {
  const { csrfToken } = useAuth();
  const [isRemoving, setIsRemoving] = useState(false);
  const [rowError, setRowError] = useState(null);

  async function removeHoliday() {
    if (!window.confirm(`Remove ${holiday.name} on ${formatCalendarDate(holiday.date)}?`)) return;
    setIsRemoving(true);
    setRowError(null);
    try {
      await requestHolidayDeletion(holiday.id, csrfToken);
      onRemoved();
    } catch (removeError) {
      setRowError(toDisplayError(removeError));
      setIsRemoving(false);
    }
  }

  return (
    <li className="px-5 py-3.5 sm:px-6">
      <div className="flex flex-wrap items-center gap-4">
        <p className="w-32 text-sm font-medium text-slate-500">
          {formatCalendarDate(holiday.date, { weekday: 'short', day: 'numeric', month: 'short' })}
        </p>
        <p className="min-w-48 flex-1 text-sm font-semibold text-slate-900">{holiday.name}</p>
        <div className="flex flex-wrap gap-1.5">
          {holiday.appliesToAllOffices ? (
            <Badge tone="indigo">Every office</Badge>
          ) : (
            holiday.officeLocationIds.map((officeId) => (
              <Badge key={officeId}>{officeNameById.get(officeId) ?? 'Removed office'}</Badge>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" isBusy={isRemoving} onClick={removeHoliday}>
            Remove
          </Button>
        </div>
      </div>
      {rowError && (
        <div className="mt-3">
          <Notice tone="error" title={rowError.message} onDismiss={() => setRowError(null)} />
        </div>
      )}
    </li>
  );
}

export default function HolidaysPanel() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [officeFilter, setOfficeFilter] = useState(ALL_OFFICES);
  // null: no form; 'new': adding; a holiday: editing it.
  const [editing, setEditing] = useState(null);
  const officesResource = useApiResource((signal) => requestOffices(signal), []);
  const holidaysResource = useApiResource(
    (signal) => requestHolidays({ year, officeLocationId: officeFilter || undefined }, signal),
    [year, officeFilter],
  );
  const offices = officesResource.data?.offices ?? [];
  const officeNameById = new Map(offices.map((office) => [office.id, office.name]));
  const holidays = holidaysResource.data?.holidays ?? [];

  function handleSaved(savedDate) {
    setEditing(null);
    const savedYear = Number(savedDate.slice(0, 4));
    if (savedYear !== year) setYear(savedYear);
    else holidaysResource.reload();
  }

  return (
    <div className="space-y-6">
      {editing && (
        <HolidayForm
          key={editing === 'new' ? 'new' : editing.id}
          holiday={editing === 'new' ? null : editing}
          offices={offices}
          defaultYear={year}
          onSaved={handleSaved}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card
        title="Holidays"
        subtitle="Holidays are not working days, so leave over them costs nothing."
        bodyClassName="p-0"
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <SelectInput
              label="Year"
              value={String(year)}
              onChange={(changeEvent) => setYear(Number(changeEvent.target.value))}
              options={YEARS_AROUND_TODAY.map((offset) => ({
                value: String(currentYear + offset),
                label: String(currentYear + offset),
              }))}
            />
            <SelectInput
              label="Office"
              value={officeFilter}
              onChange={(changeEvent) => setOfficeFilter(changeEvent.target.value)}
              options={[
                { value: ALL_OFFICES, label: 'All holidays' },
                ...offices.map((office) => ({ value: office.id, label: office.name })),
              ]}
            />
            {!editing && (
              <Button size="sm" onClick={() => setEditing('new')}>
                <PlusIcon className="h-4 w-4" /> Add holiday
              </Button>
            )}
          </div>
        }
      >
        {holidaysResource.isLoading && !holidaysResource.data && <LoadingBlock label="Loading holidays…" />}
        {holidaysResource.error && (
          <div className="p-6">
            <Notice tone="error" title={holidaysResource.error.message} />
          </div>
        )}
        {holidaysResource.data && holidays.length === 0 && (
          <div className="p-6">
            <EmptyState Icon={FlagIcon} title={`No holidays in ${year}`} description="Add the year's holidays here." />
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {holidays.map((holiday) => (
            <HolidayRow
              key={holiday.id}
              holiday={holiday}
              officeNameById={officeNameById}
              onEdit={() => setEditing(holiday)}
              onRemoved={holidaysResource.reload}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}
