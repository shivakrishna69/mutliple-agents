/**
 * Departments (HR and admins): the units people belong to, each with a code (ENG), a web address
 * name (engineering, kept when the department is renamed), an optional cost centre, the department
 * it sits under and its head.
 *
 *   GET /api/departments?includeInactive=true · POST /api/departments
 *   PATCH /api/departments/:id (only the changed fields, with the version; isActive to deactivate)
 *   DELETE /api/departments/:id (refused while people, sub-departments or invitations refer to it)
 *   GET /api/employees (to choose a head)
 *
 * Inactive departments keep their people and history but take no new invitations or imports.
 */

import { useState } from 'react';
import {
  requestDepartmentCreation,
  requestDepartmentDeletion,
  requestDepartmentUpdate,
  requestDepartments,
} from '../../api/companyApi.js';
import { requestEmployees } from '../../api/workplaceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { BuildingIcon, PlusIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, SelectInput, TextInput } from '../ui.jsx';

const NONE = '';

function formFromDepartment(department) {
  return {
    name: department?.name ?? '',
    code: department?.code ?? '',
    slug: department?.slug ?? '',
    budgetCode: department?.budgetCode ?? '',
    parentDepartmentId: department?.parentDepartmentId ?? NONE,
    departmentHeadId: department?.departmentHeadId ?? NONE,
  };
}

/** The request body: codes uppercased, blanks as null (a new department leaves them out). */
function departmentInputFromForm(form) {
  return {
    name: form.name.trim(),
    code: form.code.trim().toUpperCase(),
    slug: form.slug.trim().toLowerCase() || null,
    budgetCode: form.budgetCode.trim().toUpperCase() || null,
    parentDepartmentId: form.parentDepartmentId || null,
    departmentHeadId: form.departmentHeadId || null,
  };
}

function changedFields(input, department) {
  return Object.fromEntries(Object.entries(input).filter(([field, value]) => value !== department[field]));
}

const withoutBlanks = (input) => Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));

function DepartmentForm({ department, departments, employees, onSaved, onCancel }) {
  const { csrfToken } = useAuth();
  const isEditing = Boolean(department);
  const [form, setForm] = useState(() => formFromDepartment(department));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const update = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });
  const fieldErrors = saveError?.fieldErrors ?? {};

  // A department cannot sit under itself; the backend also refuses loops further up.
  const parentOptions = [
    { value: NONE, label: 'None (top level)' },
    ...departments
      .filter((candidate) => candidate.id !== department?.id && candidate.isActive)
      .map((candidate) => ({ value: candidate.id, label: `${candidate.name} · ${candidate.code}` })),
  ];
  const headOptions = [
    { value: NONE, label: 'No head yet' },
    ...employees.map((employee) => ({
      value: employee.employeeId,
      label: `${employee.name} · ${employee.designation}`,
    })),
  ];

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const input = departmentInputFromForm(form);
      if (isEditing) {
        const changes = changedFields(input, department);
        if (Object.keys(changes).length === 0) {
          onCancel();
          return;
        }
        await requestDepartmentUpdate(department.id, { ...changes, version: department.version }, csrfToken);
      } else {
        await requestDepartmentCreation(withoutBlanks(input), csrfToken);
      }
      onSaved();
    } catch (departmentError) {
      setSaveError(toDisplayError(departmentError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card
      title={isEditing ? `Edit ${department.name}` : 'Add a department'}
      subtitle={
        isEditing
          ? 'Renaming keeps the web address name, so links and dashboards keep working.'
          : 'The web address name is made from the name when left blank.'
      }
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {saveError && <Notice tone="error" title={saveError.message} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <TextInput
            label="Department name"
            value={form.name}
            onChange={update('name')}
            error={fieldErrors.name}
            placeholder="Engineering"
            required
          />
          <TextInput
            label="Code"
            value={form.code}
            onChange={update('code')}
            error={fieldErrors.code}
            placeholder="ENG"
            hint="Used in CSV imports and reports"
            required
          />
          <TextInput
            label="Web address name"
            value={form.slug}
            onChange={update('slug')}
            error={fieldErrors.slug}
            placeholder="engineering"
            hint="Lowercase letters, digits and dashes"
          />
          <TextInput
            label="Cost centre"
            value={form.budgetCode}
            onChange={update('budgetCode')}
            error={fieldErrors.budgetCode}
            placeholder="CC-100"
            hint="Optional"
          />
          <SelectInput
            label="Part of"
            value={form.parentDepartmentId}
            onChange={update('parentDepartmentId')}
            error={fieldErrors.parentDepartmentId}
            options={parentOptions}
          />
          <SelectInput
            label="Head of department"
            value={form.departmentHeadId}
            onChange={update('departmentHeadId')}
            error={fieldErrors.departmentHeadId}
            options={headOptions}
          />
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving}>
            {isEditing ? 'Save department' : 'Add department'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DepartmentRow({ department, parentName, headName, onEdit, onChanged }) {
  const { csrfToken } = useAuth();
  const [busyAction, setBusyAction] = useState(null);
  const [rowError, setRowError] = useState(null);

  async function runAction(actionName) {
    if (actionName === 'remove' && !window.confirm(`Remove ${department.name}? This cannot be undone.`)) return;
    setBusyAction(actionName);
    setRowError(null);
    try {
      if (actionName === 'remove') await requestDepartmentDeletion(department.id, csrfToken);
      else
        await requestDepartmentUpdate(
          department.id,
          { isActive: !department.isActive, version: department.version },
          csrfToken,
        );
      onChanged();
    } catch (actionError) {
      setRowError(toDisplayError(actionError));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-48 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {department.name} <span className="font-normal text-slate-500">· {department.code}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            /{department.slug}
            {department.budgetCode && ` · cost centre ${department.budgetCode}`}
            {parentName && ` · part of ${parentName}`}
            {headName && ` · head ${headName}`}
          </p>
        </div>
        <Badge tone="brand">
          {department.memberCount} {department.memberCount === 1 ? 'person' : 'people'}
        </Badge>
        {!department.isActive && <Badge tone="slate">Inactive</Badge>}
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={busyAction !== null} onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isBusy={busyAction === 'toggle'}
            disabled={busyAction !== null}
            onClick={() => runAction('toggle')}
          >
            {department.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
          {department.memberCount === 0 && (
            <Button
              variant="ghost"
              size="sm"
              isBusy={busyAction === 'remove'}
              disabled={busyAction !== null}
              onClick={() => runAction('remove')}
            >
              Remove
            </Button>
          )}
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

export default function DepartmentsPanel() {
  const departmentsResource = useApiResource((signal) => requestDepartments({ includeInactive: true }, signal), []);
  const employeesResource = useApiResource((signal) => requestEmployees(signal), []);
  // null: no form; 'new': adding; a department: editing it.
  const [editing, setEditing] = useState(null);
  const departments = departmentsResource.data?.departments ?? [];
  const employees = employeesResource.data?.employees ?? [];
  const departmentNames = new Map(departments.map((department) => [department.id, department.name]));
  const employeeNames = new Map(employees.map((employee) => [employee.employeeId, employee.name]));

  function handleSaved() {
    setEditing(null);
    departmentsResource.reload();
  }

  return (
    <div className="space-y-6">
      {editing && (
        <DepartmentForm
          key={editing === 'new' ? 'new' : editing.id}
          department={editing === 'new' ? null : editing}
          departments={departments}
          employees={employees}
          onSaved={handleSaved}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card
        title="Departments"
        subtitle="Every person belongs to one. Department dashboards and access build on these."
        bodyClassName="p-0"
        actions={
          !editing && (
            <Button size="sm" onClick={() => setEditing('new')} disabled={!departmentsResource.data}>
              <PlusIcon className="h-4 w-4" /> Add department
            </Button>
          )
        }
      >
        {departmentsResource.isLoading && !departmentsResource.data && <LoadingBlock label="Loading departments…" />}
        {departmentsResource.error && (
          <div className="p-6">
            <Notice tone="error" title={departmentsResource.error.message} />
          </div>
        )}
        {departmentsResource.data && departments.length === 0 && (
          <div className="p-6">
            <EmptyState
              Icon={BuildingIcon}
              title="No departments yet"
              description="Add them here, or import a CSV from Onboarding: new department codes in it are created for you."
            />
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {departments.map((department) => (
            <DepartmentRow
              key={department.id}
              department={department}
              parentName={departmentNames.get(department.parentDepartmentId)}
              headName={employeeNames.get(department.departmentHeadId)}
              onEdit={() => setEditing(department)}
              onChanged={departmentsResource.reload}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}
