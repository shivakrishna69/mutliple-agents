/**
 * Onboarding (HR and admins): invite people by email and track their invitations.
 *
 *   Invite form    name, email, role, job title, department, manager, work mode, joining date,
 *                  employment status -> POST /api/people/invitations. The person receives an email
 *                  with a one-time link (valid for the configured number of days).
 *   Invitations    list with status filter (pending / expired / accepted / revoked) and actions:
 *                  resend (new link, old one stops working) and revoke.
 *
 * When the backend could not email the link (email not configured, or the mail server refused),
 * it returns the link once; this screen shows it with a copy button so HR can share it by another
 * channel. The link is kept only in this page's memory, never stored in the browser.
 */

import { useMemo, useState } from 'react';
import { requestInvitationCreation, requestInvitationOptions, requestInvitationResend, requestInvitationRevoke, requestInvitations } from '../api/peopleApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { CheckBadgeIcon, ClockIcon, PlusIcon, UsersIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, SelectInput, StatTile, Tabs, TextInput, formatDate, formatDateTime } from '../components/ui.jsx';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';

const ROLE_LABELS = Object.freeze({ customer: 'Employee', agent: 'Support agent', hr: 'HR' });
const STATUS_DISPLAY = Object.freeze({
  pending: { label: 'Pending', tone: 'amber' },
  expired: { label: 'Expired', tone: 'slate' },
  accepted: { label: 'Joined', tone: 'emerald' },
  revoked: { label: 'Revoked', tone: 'rose' },
});
const DELIVERY_NOTICES = Object.freeze({
  sent: { tone: 'success', title: (name) => `Invitation emailed to ${name}` },
  not_configured: { tone: 'warning', title: () => 'Email is not set up on this server, so share this link yourself (WhatsApp, Slack, …)' },
  failed: { tone: 'warning', title: () => 'The email could not be sent. Share this link yourself, or try “Resend” later' },
});

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function InviteLinkNotice({ result, onDismiss }) {
  const [hasCopied, setHasCopied] = useState(false);
  const delivery = DELIVERY_NOTICES[result.delivery.outcome];
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.delivery.inviteUrl);
      setHasCopied(true);
    } catch {
      setHasCopied(false);
    }
  }
  return (
    <Notice tone={delivery.tone} title={delivery.title(result.invitation.name)} onDismiss={onDismiss}>
      {result.delivery.inviteUrl ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-white/70 px-3 py-2 text-xs ring-1 ring-black/5" title={result.delivery.inviteUrl}>
            {result.delivery.inviteUrl}
          </code>
          <Button size="sm" variant="secondary" onClick={copyLink}>
            {hasCopied ? 'Copied ✓' : 'Copy link'}
          </Button>
        </div>
      ) : (
        <p>
          {result.invitation.email} · link valid until {formatDate(result.invitation.expiresAt)}
        </p>
      )}
    </Notice>
  );
}

function InviteForm({ options, onInvited, onCancel }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState({
    name: '',
    email: '',
    role: options.roles[0] ?? 'customer',
    designation: '',
    departmentId: options.departments[0]?.id ?? '',
    reportingManagerId: '',
    workLocationType: 'Onsite',
    dateOfJoining: todayIso(),
    employmentStatus: 'Probation',
  });
  const [isSending, setIsSending] = useState(false);
  const [formError, setFormError] = useState(null);
  const update = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });

  // Managers from the chosen department first, then everyone else.
  const managerOptions = useMemo(() => {
    const sortedManagers = [...options.managers].sort((first, second) => Number(second.departmentId === form.departmentId) - Number(first.departmentId === form.departmentId));
    return [{ value: '', label: 'No manager' }, ...sortedManagers.map((manager) => ({ value: manager.employeeId, label: `${manager.name} · ${manager.designation}` }))];
  }, [options.managers, form.departmentId]);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSending(true);
    setFormError(null);
    try {
      const result = await requestInvitationCreation({ ...form, reportingManagerId: form.reportingManagerId || null }, csrfToken);
      onInvited(result);
    } catch (invitationError) {
      setFormError(toDisplayError(invitationError));
    } finally {
      setIsSending(false);
    }
  }

  if (options.departments.length === 0) {
    return <Notice tone="warning" title="Create a department first">Invitations place people in a department; none exist yet.</Notice>;
  }
  const fieldErrors = formError?.fieldErrors ?? {};
  return (
    <Card title="Invite a new team member" subtitle={`They get an email with a secure link to set their password (valid ${options.validityDays} days).`}>
      <form onSubmit={handleSubmit} className="space-y-6">
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900">Person</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <TextInput label="Full name" value={form.name} onChange={update('name')} error={fieldErrors.name} placeholder="Ananya Gupta" required />
            <TextInput label="Work email" type="email" value={form.email} onChange={update('email')} error={fieldErrors.email} placeholder="ananya@company.com" required />
            <SelectInput label="Access" value={form.role} onChange={update('role')} error={fieldErrors.role} options={options.roles.map((roleName) => ({ value: roleName, label: ROLE_LABELS[roleName] ?? roleName }))} />
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900">Job</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <TextInput label="Job title" value={form.designation} onChange={update('designation')} error={fieldErrors.designation} placeholder="Software Engineer" required />
            <SelectInput label="Department" value={form.departmentId} onChange={update('departmentId')} error={fieldErrors.departmentId} options={options.departments.map((department) => ({ value: department.id, label: department.name }))} />
            <SelectInput label="Reports to" value={form.reportingManagerId} onChange={update('reportingManagerId')} error={fieldErrors.reportingManagerId} options={managerOptions} />
            <SelectInput label="Work mode" value={form.workLocationType} onChange={update('workLocationType')} options={options.workLocationTypes.map((workMode) => ({ value: workMode, label: workMode }))} />
            <TextInput label="Joining date" type="date" value={form.dateOfJoining} onChange={update('dateOfJoining')} error={fieldErrors.dateOfJoining} />
            <SelectInput label="Status on joining" value={form.employmentStatus} onChange={update('employmentStatus')} options={options.employmentStatuses.map((employmentStatus) => ({ value: employmentStatus, label: employmentStatus }))} />
          </div>
        </fieldset>
        {formError && <Notice tone="error" title={formError.message} onDismiss={() => setFormError(null)} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSending}>
            Send invitation
          </Button>
        </div>
      </form>
    </Card>
  );
}

function InvitationRow({ invitation, onChanged, onLinkIssued }) {
  const { csrfToken } = useAuth();
  const [busyAction, setBusyAction] = useState(null);
  const [rowError, setRowError] = useState(null);

  async function runAction(actionName) {
    if (actionName === 'revoke' && !window.confirm(`Revoke the invitation for ${invitation.name}? The link will stop working.`)) return;
    setBusyAction(actionName);
    setRowError(null);
    try {
      if (actionName === 'resend') onLinkIssued(await requestInvitationResend(invitation.id, csrfToken));
      else await requestInvitationRevoke(invitation.id, csrfToken);
      onChanged();
    } catch (actionError) {
      setRowError(toDisplayError(actionError));
    } finally {
      setBusyAction(null);
    }
  }

  const statusDisplay = STATUS_DISPLAY[invitation.status];
  const isOpen = invitation.status === 'pending' || invitation.status === 'expired';
  return (
    <li className="p-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-sm font-bold text-white">
          {invitation.name.split(/\s+/).map((namePart) => namePart[0]).slice(0, 2).join('').toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {invitation.name} <span className="font-normal text-slate-500">· {invitation.email}</span>
          </p>
          <p className="text-xs text-slate-500">
            {invitation.designation} · {invitation.department.name ?? '—'}
            {invitation.reportingManager?.name && ` · reports to ${invitation.reportingManager.name}`} · {ROLE_LABELS[invitation.role] ?? invitation.role} · joins {formatDate(invitation.dateOfJoining)}
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          {invitation.status === 'accepted' ? <p>Joined {formatDateTime(invitation.acceptedAt)}</p> : <p>Sent {formatDateTime(invitation.lastSentAt)}{invitation.sendCount > 1 && ` · ${invitation.sendCount}×`}</p>}
          {invitation.status === 'pending' && <p>Expires {formatDate(invitation.expiresAt)}</p>}
        </div>
        <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
        {isOpen && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" isBusy={busyAction === 'resend'} disabled={busyAction !== null} onClick={() => runAction('resend')}>
              Resend
            </Button>
            {invitation.status === 'pending' && (
              <Button variant="ghost" size="sm" isBusy={busyAction === 'revoke'} disabled={busyAction !== null} onClick={() => runAction('revoke')}>
                Revoke
              </Button>
            )}
          </div>
        )}
      </div>
      {rowError && (
        <div className="mt-3">
          <Notice tone="error" title={rowError.message} onDismiss={() => setRowError(null)} />
        </div>
      )}
    </li>
  );
}

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted', label: 'Joined' },
  { id: 'expired', label: 'Expired' },
  { id: 'revoked', label: 'Revoked' },
];

export default function PeopleOnboarding() {
  const [isComposing, setIsComposing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [lastResult, setLastResult] = useState(null);
  const optionsResource = useApiResource((signal) => requestInvitationOptions(signal), []);
  const allInvitationsResource = useApiResource((signal) => requestInvitations(undefined, signal), []);
  const allInvitations = allInvitationsResource.data?.invitations ?? [];
  const visibleInvitations = statusFilter === 'all' ? allInvitations : allInvitations.filter((invitation) => invitation.status === statusFilter);
  const countByStatus = allInvitations.reduce((counts, invitation) => ({ ...counts, [invitation.status]: (counts[invitation.status] ?? 0) + 1 }), {});

  function handleLinkIssued(result) {
    setLastResult(result);
    allInvitationsResource.reload();
    optionsResource.reload();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Onboarding"
        description="Invite new joiners by email. They set their own password and land straight in their workspace."
        actions={
          !isComposing && (
            <Button onClick={() => { setIsComposing(true); setLastResult(null); }} disabled={!optionsResource.data}>
              <PlusIcon className="h-4 w-4" /> Invite someone
            </Button>
          )
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Waiting to join" value={countByStatus.pending ?? 0} hint="Invitation sent, not used yet" Icon={ClockIcon} accent="amber" />
        <StatTile label="Joined" value={countByStatus.accepted ?? 0} hint="Accounts activated" Icon={CheckBadgeIcon} accent="emerald" />
        <StatTile label="Employees" value={optionsResource.data?.managers.length ?? '—'} hint="Current team members" Icon={UsersIcon} accent="indigo" />
      </div>

      {lastResult && <InviteLinkNotice result={lastResult} onDismiss={() => setLastResult(null)} />}
      {optionsResource.error && <Notice tone="error" title={optionsResource.error.message} />}
      {isComposing && optionsResource.data && (
        <InviteForm
          options={optionsResource.data}
          onCancel={() => setIsComposing(false)}
          onInvited={(result) => {
            setIsComposing(false);
            handleLinkIssued(result);
          }}
        />
      )}

      <Card title="Invitations" bodyClassName="p-0" actions={<Tabs tabs={STATUS_TABS.map((tab) => ({ ...tab, badge: tab.id === 'all' ? null : countByStatus[tab.id] || null }))} activeTabId={statusFilter} onChange={setStatusFilter} label="Invitation status" />}>
        {allInvitationsResource.isLoading && !allInvitationsResource.data && <LoadingBlock label="Loading invitations…" />}
        {allInvitationsResource.error && (
          <div className="p-6">
            <Notice tone="error" title={allInvitationsResource.error.message} />
          </div>
        )}
        {allInvitationsResource.data && visibleInvitations.length === 0 && (
          <div className="p-6">
            <EmptyState Icon={UsersIcon} title={statusFilter === 'all' ? 'No invitations yet' : `No ${STATUS_DISPLAY[statusFilter].label.toLowerCase()} invitations`} description="Invite your first team member with the button above." />
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {visibleInvitations.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} onChanged={allInvitationsResource.reload} onLinkIssued={setLastResult} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
