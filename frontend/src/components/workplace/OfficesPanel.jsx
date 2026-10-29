/**
 * Offices (HR and admins): each office's location, time zone, shift and weekly offs. Leave and
 * attendance use an employee's base office, so its calendar decides which days are working days.
 *
 *   GET /api/offices · POST /api/offices · PATCH /api/offices/:id (with the version loaded)
 *   DELETE /api/offices/:id (refused while employees, attendance or holidays refer to it)
 *
 * A new office takes the backend's defaults for weekly offs (Saturday and Sunday), late grace and
 * the half-day threshold when those are left blank; weekly offs are edited once the office exists.
 */

import { useMemo, useState } from 'react';
import {
  requestOfficeCreation,
  requestOfficeDeletion,
  requestOfficeUpdate,
  requestOffices,
} from '../../api/workplaceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  WEEKDAYS_FROM_MONDAY,
  browserTimeZone,
  describeWeeklyOffRule,
  timeZoneOptions,
} from '../../constants/workplace.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { MapPinIcon, PlusIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, SelectInput, TextInput } from '../ui.jsx';
import WeeklyOffEditor from './WeeklyOffEditor.jsx';

const toFormNumber = (value) => (value === null || value === undefined ? '' : String(value));
const toOptionalNumber = (value) => (value === '' ? undefined : Number(value));

function formFromOffice(office) {
  return {
    name: office?.name ?? '',
    code: office?.code ?? '',
    lat: toFormNumber(office?.coordinates.lat),
    lng: toFormNumber(office?.coordinates.lng),
    timeZone: office?.timeZone ?? browserTimeZone(),
    shiftStartLocalTime: office?.workday.shiftStartLocalTime ?? '',
    shiftEndLocalTime: office?.workday.shiftEndLocalTime ?? '',
    lateGraceMinutes: toFormNumber(office?.workday.lateGraceMinutes),
    halfDayAfterMinutes: toFormNumber(office?.workday.halfDayAfterMinutes),
    weeklyOffRules: office?.workday.weeklyOffRules ?? [],
  };
}

/** The request body: blank optional numbers are left to the backend's defaults. */
function officeInputFromForm(form, { includeWeeklyOffs }) {
  const workday = {
    shiftStartLocalTime: form.shiftStartLocalTime,
    shiftEndLocalTime: form.shiftEndLocalTime,
    lateGraceMinutes: toOptionalNumber(form.lateGraceMinutes),
    halfDayAfterMinutes: toOptionalNumber(form.halfDayAfterMinutes),
  };
  if (includeWeeklyOffs) workday.weeklyOffRules = form.weeklyOffRules;
  return {
    name: form.name,
    code: form.code,
    coordinates: { lat: Number(form.lat), lng: Number(form.lng) },
    timeZone: form.timeZone,
    workday,
  };
}

function OfficeForm({ office, onSaved, onCancel }) {
  const { csrfToken } = useAuth();
  const isEditing = Boolean(office);
  const [form, setForm] = useState(() => formFromOffice(office));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // The zone the form started with stays selectable even if the browser does not list it.
  const zoneOptions = useMemo(() => timeZoneOptions(office?.timeZone ?? browserTimeZone()), [office]);
  const update = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });
  const fieldErrors = saveError?.fieldErrors ?? {};

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const officeInput = officeInputFromForm(form, { includeWeeklyOffs: isEditing });
      const { office: savedOffice } = isEditing
        ? await requestOfficeUpdate(office.id, { ...officeInput, version: office.version }, csrfToken)
        : await requestOfficeCreation(officeInput, csrfToken);
      onSaved(savedOffice);
    } catch (officeError) {
      setSaveError(toDisplayError(officeError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card
      title={isEditing ? `Edit ${office.name}` : 'Add an office'}
      subtitle={
        isEditing
          ? 'Changes apply to attendance and leave from now on.'
          : 'Saturday and Sunday are off to begin with; change the weekly offs after saving.'
      }
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {saveError && <Notice tone="error" title={saveError.message} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <TextInput
            label="Office name"
            value={form.name}
            onChange={update('name')}
            error={fieldErrors.name}
            required
          />
          <TextInput
            label="Office code"
            value={form.code}
            onChange={update('code')}
            error={fieldErrors.code}
            hint="Short and unique, e.g. BLR-HQ"
            required
          />
          <SelectInput
            label="Time zone"
            value={form.timeZone}
            onChange={update('timeZone')}
            error={fieldErrors.timeZone}
            options={zoneOptions}
          />
          <TextInput
            label="Latitude"
            type="number"
            step="any"
            value={form.lat}
            onChange={update('lat')}
            error={fieldErrors['coordinates.lat']}
            required
          />
          <TextInput
            label="Longitude"
            type="number"
            step="any"
            value={form.lng}
            onChange={update('lng')}
            error={fieldErrors['coordinates.lng'] ?? fieldErrors.coordinates}
            required
          />
          <div />
          <TextInput
            label="Shift starts"
            type="time"
            value={form.shiftStartLocalTime}
            onChange={update('shiftStartLocalTime')}
            error={fieldErrors['workday.shiftStartLocalTime']}
            required
          />
          <TextInput
            label="Shift ends"
            type="time"
            value={form.shiftEndLocalTime}
            onChange={update('shiftEndLocalTime')}
            error={fieldErrors['workday.shiftEndLocalTime']}
            required
          />
          <div />
          <TextInput
            label="Late grace (minutes)"
            type="number"
            min="0"
            step="1"
            value={form.lateGraceMinutes}
            onChange={update('lateGraceMinutes')}
            error={fieldErrors['workday.lateGraceMinutes']}
            hint={isEditing ? undefined : 'Leave blank for the standard grace'}
          />
          <TextInput
            label="Half day after (minutes)"
            type="number"
            min="1"
            step="1"
            value={form.halfDayAfterMinutes}
            onChange={update('halfDayAfterMinutes')}
            error={fieldErrors['workday.halfDayAfterMinutes']}
            hint={isEditing ? undefined : 'Leave blank for the standard threshold'}
          />
        </div>
        {isEditing && (
          <WeeklyOffEditor
            rules={form.weeklyOffRules}
            onChange={(weeklyOffRules) => setForm({ ...form, weeklyOffRules })}
            error={fieldErrors['workday.weeklyOffRules']}
          />
        )}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving}>
            {isEditing ? 'Save office' : 'Add office'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function OfficeRow({ office, onEdit, onRemoved }) {
  const { csrfToken } = useAuth();
  const [isRemoving, setIsRemoving] = useState(false);
  const [rowError, setRowError] = useState(null);
  // In week order, Monday first, as the editor lists them.
  const weeklyOffs = [...office.workday.weeklyOffRules].sort(
    (first, second) => WEEKDAYS_FROM_MONDAY.indexOf(first.weekday) - WEEKDAYS_FROM_MONDAY.indexOf(second.weekday),
  );

  async function removeOffice() {
    if (!window.confirm(`Remove ${office.name}? This cannot be undone.`)) return;
    setIsRemoving(true);
    setRowError(null);
    try {
      await requestOfficeDeletion(office.id, csrfToken);
      onRemoved();
    } catch (removeError) {
      setRowError(toDisplayError(removeError));
      setIsRemoving(false);
    }
  }

  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-48 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {office.name} <span className="font-normal text-slate-500">· {office.code}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {office.timeZone} · shift {office.workday.shiftStartLocalTime}–{office.workday.shiftEndLocalTime}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {weeklyOffs.length === 0 ? (
            <Badge tone="amber">No weekly offs</Badge>
          ) : (
            weeklyOffs.map((rule) => (
              <Badge key={rule.weekday} tone="indigo">
                {describeWeeklyOffRule(rule)}
              </Badge>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" isBusy={isRemoving} onClick={removeOffice}>
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

export default function OfficesPanel() {
  const officesResource = useApiResource((signal) => requestOffices(signal), []);
  // null: no form; 'new': adding; an office: editing it.
  const [editing, setEditing] = useState(null);
  const offices = officesResource.data?.offices ?? [];

  function handleSaved() {
    setEditing(null);
    officesResource.reload();
  }

  return (
    <div className="space-y-6">
      {editing && (
        <OfficeForm
          key={editing === 'new' ? 'new' : editing.id}
          office={editing === 'new' ? null : editing}
          onSaved={handleSaved}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card
        title="Offices"
        subtitle="Each employee's base office decides their working days, holidays and time zone."
        bodyClassName="p-0"
        actions={
          !editing && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <PlusIcon className="h-4 w-4" /> Add office
            </Button>
          )
        }
      >
        {officesResource.isLoading && !officesResource.data && <LoadingBlock label="Loading offices…" />}
        {officesResource.error && (
          <div className="p-6">
            <Notice tone="error" title={officesResource.error.message} />
          </div>
        )}
        {officesResource.data && offices.length === 0 && (
          <div className="p-6">
            <EmptyState
              Icon={MapPinIcon}
              title="No offices yet"
              description="Add your first office, then assign employees to it."
            />
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {offices.map((office) => (
            <OfficeRow
              key={office.id}
              office={office}
              onEdit={() => setEditing(office)}
              onRemoved={officesResource.reload}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}
