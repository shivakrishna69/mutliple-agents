/**
 * Onboarding (MANAGE_WORKFORCE: HR and admins): invite people one by one or import them from a CSV,
 * and track their invitations.
 *
 *   Invite form    name, personal email, optional company email, access role, job title, job level,
 *                  employment type, department, manager, work mode, joining date, employment status
 *                  -> POST /api/people/invitations. Access role and job level are grouped dropdowns
 *                  (Operations / Support / General; Executive / Management / Staff) built from the
 *                  server's options, which offer only the roles this inviter may grant. Access decides
 *                  what the person may do in the software; job level is who they are in the company
 *                  and grants nothing.
 *                  The person gets an employee ID at once, and an email with a one-time link (valid
 *                  for the configured number of days).
 *   Import         many people from a CSV (components/people/EmployeeImportPanel.jsx).
 *   Offers         offers with their salary structure and letter, prepared for review, imported from a
 *                  CSV and sent one by one or as a batch (components/offers/OffersPanel.jsx); for
 *                  people who may see offers (READ_OFFERS).
 *   Invitations    list with status filter (pending / expired / accepted / revoked) and actions:
 *                  resend (new link, old one stops working) and revoke.
 *
 * When the backend could not email the link (email not configured, or the mail server refused),
 * it returns the link once; this screen shows it with a copy button so HR can share it by another
 * channel. The link is kept only in this page's memory, never stored in the browser.
 */

import { useMemo, useState } from 'react';
import {
  requestInvitationCreation,
  requestInvitationOptions,
  requestInvitationResend,
  requestInvitationRevoke,
  requestInvitations,
} from '../api/peopleApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { hasCapability } from '../auth/capabilities.js';
import OffersPanel from '../components/offers/OffersPanel.jsx';
import { CAPABILITIES } from '../constants/capabilities.js';
import {
  CheckBadgeIcon,
  ClockIcon,
  CurrencyIcon,
  DocumentIcon,
  PlusIcon,
  UserPlusIcon,
  UsersIcon,
} from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmployeeImportPanel from '../components/people/EmployeeImportPanel.jsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  Notice,
  SelectInput,
  StatTile,
  Tabs,
  TextInput,
  formatDate,
  formatDateTime,
} from '../components/ui.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import { USER_ROLES } from '../constants/routes.js';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';
import { labelOf, toGroupedOptions } from '../utils/groupedOptions.js';

const STATUS_DISPLAY = Object.freeze({
  pending: { label: 'Pending', tone: 'amber' },
  expired: { label: 'Expired', tone: 'slate' },
  accepted: { label: 'Joined', tone: 'emerald' },
  revoked: { label: 'Revoked', tone: 'rose' },
});
const DELIVERY_NOTICES = Object.freeze({
  sent: { tone: 'success', title: (name) => `Invitation emailed to ${name}` },
  not_configured: {
    tone: 'warning',
    title: () => 'Email is not set up on this server, so share this link yourself (WhatsApp, Slack, …)',
  },
  failed: {
    tone: 'warning',
    title: () => 'The email could not be sent. Share this link yourself, or try “Resend” later',
  },
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
          <code
            className="min-w-0 flex-1 truncate rounded-lg bg-white/70 px-3 py-2 text-xs ring-1 ring-black/5"
            title={result.delivery.inviteUrl}
          >
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
    companyEmail: '',
    role: options.defaults?.role ?? options.roles[0] ?? USER_ROLES.EMPLOYEE,
    designation: '',
    jobLevel: options.defaults?.jobLevel ?? options.jobLevels?.at(-1)?.value ?? '',
    employmentType: options.defaults?.employmentType ?? options.employmentTypes?.[0]?.value ?? '',
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
    const sortedManagers = [...options.managers].sort(
      (first, second) =>
        Number(second.departmentId === form.departmentId) - Number(first.departmentId === form.departmentId),
    );
    return [
      { value: '', label: 'No manager' },
      ...sortedManagers.map((manager) => ({
        value: manager.employeeId,
        label: `${manager.name} · ${manager.designation}`,
      })),
    ];
  }, [options.managers, form.departmentId]);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSending(true);
    setFormError(null);
    try {
      const result = await requestInvitationCreation(
        {
          ...form,
          companyEmail: form.companyEmail.trim() || undefined,
          reportingManagerId: form.reportingManagerId || null,
        },
        csrfToken,
      );
      onInvited(result);
    } catch (invitationError) {
      setFormError(toDisplayError(invitationError));
    } finally {
      setIsSending(false);
    }
  }

  if (options.departments.length === 0) {
    return (
      <Notice tone="warning" title="Create a department first">
        Invitations place people in a department; none exist yet. Add one under Workplace → Departments, or import a
        CSV, which creates its departments.
      </Notice>
    );
  }
  const fieldErrors = formError?.fieldErrors ?? {};
  return (
    <Card
      title="Invite a new team member"
      subtitle={`They get an email with a secure link to set their password (valid ${options.validityDays} days).`}
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900">Person</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <TextInput
              label="Full name"
              value={form.name}
              onChange={update('name')}
              error={fieldErrors.name}
              placeholder="Ananya Gupta"
              required
            />
            <TextInput
              label="Personal email"
              type="email"
              value={form.email}
              onChange={update('email')}
              error={fieldErrors.email}
              placeholder="ananya@gmail.com"
              hint="The invitation goes here; they sign in with it"
              required
            />
            <TextInput
              label="Company email"
              type="email"
              value={form.companyEmail}
              onChange={update('companyEmail')}
              error={fieldErrors.companyEmail}
              placeholder="ananya.gupta@company.com"
              hint="Optional: leave blank to use first.last@ your company domain"
            />
            <SelectInput
              label="Access"
              value={form.role}
              onChange={update('role')}
              error={fieldErrors.role}
              options={toGroupedOptions(options.roleOptions)}
              hint={options.roleOptions.find((roleOption) => roleOption.value === form.role)?.description}
            />
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900">Job</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <TextInput
              label="Job title"
              value={form.designation}
              onChange={update('designation')}
              error={fieldErrors.designation}
              placeholder="Software Engineer"
              required
            />
            <SelectInput
              label="Job level"
              value={form.jobLevel}
              onChange={update('jobLevel')}
              error={fieldErrors.jobLevel}
              options={toGroupedOptions(options.jobLevels)}
              hint="For the org chart and reports; it grants no access"
            />
            <SelectInput
              label="Employment type"
              value={form.employmentType}
              onChange={update('employmentType')}
              error={fieldErrors.employmentType}
              options={toGroupedOptions(options.employmentTypes)}
            />
            <SelectInput
              label="Department"
              value={form.departmentId}
              onChange={update('departmentId')}
              error={fieldErrors.departmentId}
              options={options.departments.map((department) => ({ value: department.id, label: department.name }))}
            />
            <SelectInput
              label="Reports to"
              value={form.reportingManagerId}
              onChange={update('reportingManagerId')}
              error={fieldErrors.reportingManagerId}
              options={managerOptions}
            />
            <SelectInput
              label="Work mode"
              value={form.workLocationType}
              onChange={update('workLocationType')}
              options={options.workLocationTypes.map((workMode) => ({ value: workMode, label: workMode }))}
            />
            <TextInput
              label="Joining date"
              type="date"
              value={form.dateOfJoining}
              onChange={update('dateOfJoining')}
              error={fieldErrors.dateOfJoining}
            />
            <SelectInput
              label="Status on joining"
              value={form.employmentStatus}
              onChange={update('employmentStatus')}
              options={options.employmentStatuses.map((employmentStatus) => ({
                value: employmentStatus,
                label: employmentStatus,
              }))}
            />
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

function InvitationRow({ invitation, jobLevels, employmentTypes, onChanged, onLinkIssued }) {
  const { csrfToken } = useAuth();
  const [busyAction, setBusyAction] = useState(null);
  const [rowError, setRowError] = useState(null);

  async function runAction(actionName) {
    if (
      actionName === 'revoke' &&
      !window.confirm(`Revoke the invitation for ${invitation.name}? The link will stop working.`)
    )
      return;
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
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-600 text-sm font-bold text-white">
          {invitation.name
            .split(/\s+/)
            .map((namePart) => namePart[0])
            .slice(0, 2)
            .join('')
            .toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {invitation.name}
            {invitation.employeeCode && (
              <span className="ml-2 font-mono text-xs font-normal text-slate-500">{invitation.employeeCode}</span>
            )}{' '}
            <span className="font-normal text-slate-500">· {invitation.email}</span>{' '}
            <RoleBadge role={invitation.role} />
          </p>
          <p className="text-xs text-slate-500">
            {invitation.designation} · {labelOf(jobLevels, invitation.jobLevel)} ·{' '}
            {labelOf(employmentTypes, invitation.employmentType)} · {invitation.department.name ?? '—'}
            {invitation.reportingManager?.name && ` · reports to ${invitation.reportingManager.name}`} · joins{' '}
            {formatDate(invitation.dateOfJoining)}
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          {invitation.status === 'accepted' ? (
            <p>Joined {formatDateTime(invitation.acceptedAt)}</p>
          ) : (
            <p>
              Sent {formatDateTime(invitation.lastSentAt)}
              {invitation.sendCount > 1 && ` · ${invitation.sendCount}×`}
            </p>
          )}
          {invitation.status === 'pending' && <p>Expires {formatDate(invitation.expiresAt)}</p>}
        </div>
        <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
        {isOpen && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              isBusy={busyAction === 'resend'}
              disabled={busyAction !== null}
              onClick={() => runAction('resend')}
            >
              Resend
            </Button>
            {invitation.status === 'pending' && (
              <Button
                variant="ghost"
                size="sm"
                isBusy={busyAction === 'revoke'}
                disabled={busyAction !== null}
                onClick={() => runAction('revoke')}
              >
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

const OFFERS_VIEW = Object.freeze({ id: 'offers', label: 'Offers', Icon: CurrencyIcon });
const ONBOARDING_VIEWS = Object.freeze([
  { id: 'invitations', label: 'Invitations', Icon: UserPlusIcon },
  { id: 'import', label: 'Import from CSV', Icon: DocumentIcon },
]);

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted', label: 'Joined' },
  { id: 'expired', label: 'Expired' },
  { id: 'revoked', label: 'Revoked' },
];

export default function PeopleOnboarding() {
  const [view, setView] = useState(ONBOARDING_VIEWS[0].id);
  const [isComposing, setIsComposing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [lastResult, setLastResult] = useState(null);
  const { currentUser } = useAuth();
  const optionsResource = useApiResource((signal) => requestInvitationOptions(signal), []);
  const views = hasCapability(currentUser, CAPABILITIES.READ_OFFERS)
    ? [...ONBOARDING_VIEWS, OFFERS_VIEW]
    : ONBOARDING_VIEWS;
  const allInvitationsResource = useApiResource((signal) => requestInvitations(undefined, signal), []);
  const allInvitations = allInvitationsResource.data?.invitations ?? [];
  const visibleInvitations =
    statusFilter === 'all' ? allInvitations : allInvitations.filter((invitation) => invitation.status === statusFilter);
  const countByStatus = allInvitations.reduce(
    (counts, invitation) => ({ ...counts, [invitation.status]: (counts[invitation.status] ?? 0) + 1 }),
    {},
  );

  function handleLinkIssued(result) {
    setLastResult(result);
    allInvitationsResource.reload();
    optionsResource.reload();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Onboarding"
        description="Invite new joiners one by one or from a CSV. Each gets an employee ID and sets their own password."
        actions={
          view === 'invitations' &&
          !isComposing && (
            <Button
              onClick={() => {
                setIsComposing(true);
                setLastResult(null);
              }}
              disabled={!optionsResource.data}
            >
              <PlusIcon className="h-4 w-4" /> Invite someone
            </Button>
          )
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Waiting to join"
          value={countByStatus.pending ?? 0}
          hint="Invitation sent, not used yet"
          Icon={ClockIcon}
          accent="amber"
        />
        <StatTile
          label="Joined"
          value={countByStatus.accepted ?? 0}
          hint="Accounts activated"
          Icon={CheckBadgeIcon}
          accent="emerald"
        />
        <StatTile
          label="Employees"
          value={optionsResource.data?.managers.length ?? '—'}
          hint="Current team members"
          Icon={UsersIcon}
          accent="brand"
        />
      </div>

      <Tabs tabs={views} activeTabId={view} onChange={setView} label="Onboarding sections" />

      {view === OFFERS_VIEW.id && optionsResource.data && <OffersPanel options={optionsResource.data} />}

      {view === 'import' && <EmployeeImportPanel onImported={() => handleLinkIssued(null)} />}
      {view === 'invitations' && (
        <>
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

          <Card
            title="Invitations"
            bodyClassName="p-0"
            actions={
              <Tabs
                tabs={STATUS_TABS.map((tab) => ({
                  ...tab,
                  badge: tab.id === 'all' ? null : countByStatus[tab.id] || null,
                }))}
                activeTabId={statusFilter}
                onChange={setStatusFilter}
                label="Invitation status"
              />
            }
          >
            {allInvitationsResource.isLoading && !allInvitationsResource.data && (
              <LoadingBlock label="Loading invitations…" />
            )}
            {allInvitationsResource.error && (
              <div className="p-6">
                <Notice tone="error" title={allInvitationsResource.error.message} />
              </div>
            )}
            {allInvitationsResource.data && visibleInvitations.length === 0 && (
              <div className="p-6">
                <EmptyState
                  Icon={UsersIcon}
                  title={
                    statusFilter === 'all'
                      ? 'No invitations yet'
                      : `No ${STATUS_DISPLAY[statusFilter].label.toLowerCase()} invitations`
                  }
                  description="Invite your first team member with the button above."
                />
              </div>
            )}
            <ul className="divide-y divide-slate-100">
              {visibleInvitations.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  jobLevels={optionsResource.data?.jobLevels}
                  employmentTypes={optionsResource.data?.employmentTypes}
                  onChanged={allInvitationsResource.reload}
                  onLinkIssued={setLastResult}
                />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
