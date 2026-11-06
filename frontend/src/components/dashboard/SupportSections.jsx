/**
 * The dashboard's support parts (administrators and agents), from GET /api/dashboard/overview
 * `support` and `accounts`, and GET /api/system/health:
 *
 *   SupportStats             waiting for an agent, assigned to you, handled by AI, (admin) accounts,
 *                            average first response
 *   RecentConversations      the newest conversations the viewer may see, with filters
 *   IntelligencePulse        AI resolution, escalation and AI reply time, and the activity chart
 *   ConsoleCard              the dark "Support console" call to action
 *   TeamCard                 accounts per role, and a way to manage users (admins)
 *   ConnectedServices        each service's real state (admins)
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { CONVERSATION_FILTERS, SERVICE_STATE_TONES } from '../../constants/dashboardDisplay.js';
import { ROLE_DISPLAY, ROUTE_PATHS } from '../../constants/routes.js';
import {
  formatDuration,
  formatDurationChange,
  formatRelativeTime,
  formatShare,
  formatShareChange,
  initialsOf,
} from '../../utils/dashboardFormat.js';
import {
  ArrowRightIcon,
  ChartIcon,
  ChatIcon,
  CheckBadgeIcon,
  ClockIcon,
  InboxIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
  UsersIcon,
} from '../Icons.jsx';
import ActivityChart from './ActivityChart.jsx';
import { ArrowLink, Panel, Pill, StatCard, StatusChip } from './DashboardParts.jsx';

export function SupportStats({ support, accounts }) {
  const { queue, period, change } = support;
  const responseChange = formatDurationChange(change.avgFirstResponseMs);
  return (
    <>
      <StatCard
        label="Waiting for an agent"
        value={queue.waitingForAgent}
        suffix={queue.waitingForAgent === 0 ? 'clear' : 'in queue'}
        Icon={ClockIcon}
        tone="red"
        note="Escalated and not yet claimed"
        link={{ to: ROUTE_PATHS.CONSOLE, label: 'Inspect' }}
      />
      <StatCard
        label="Assigned to you"
        value={queue.assignedToYou}
        suffix="active"
        Icon={ChatIcon}
        tone="slate"
        note={`${queue.withAgents} with agents in all`}
        link={{ to: ROUTE_PATHS.CONSOLE, label: 'View queue' }}
      />
      <StatCard
        label="Handled by AI"
        value={queue.withAi}
        suffix={<Pill className="bg-brand-50 text-brand-700">{formatShare(period.handledByAiShare)} on its own</Pill>}
        Icon={SparklesIcon}
        tone="blue"
        note={`${period.conversations} conversations opened in this period`}
        footer={
          <>
            <SparklesIcon className="h-3.5 w-3.5 text-brand-500" />
            {formatShareChange(change.handledByAiShare) ?? 'No change'}
          </>
        }
      />
      {accounts && (
        <StatCard
          label="Total accounts"
          value={accounts.total}
          suffix={accounts.newThisWeek > 0 ? `+${accounts.newThisWeek} this week` : null}
          Icon={UsersIcon}
          tone="violet"
          note={Object.entries(accounts.perRole)
            .map(([role, count]) => `${count} ${ROLE_DISPLAY[role]?.label ?? role}`)
            .join(' · ')}
          footer={
            <>
              <ShieldIcon className="h-3.5 w-3.5" />
              {accounts.unverified > 0 ? `${accounts.unverified} not confirmed` : 'All confirmed'}
            </>
          }
          link={{ to: ROUTE_PATHS.ADMIN_USERS, label: 'Directory' }}
        />
      )}
      <StatCard
        label="Avg first response"
        value={<span className="text-brand-600">{formatDuration(period.avgFirstResponseMs)}</span>}
        suffix={
          responseChange && (
            <Pill
              className={
                change.avgFirstResponseMs < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
              }
            >
              {responseChange}
            </Pill>
          )
        }
        Icon={ChartIcon}
        tone="blue"
        note="From the customer's first message to the first reply"
        footer={
          <>
            <CheckBadgeIcon className="h-3.5 w-3.5" />
            {formatShare(period.withinTargetShare)} within {formatDuration(period.firstResponseTargetMs)}
          </>
        }
      />
    </>
  );
}

export function RecentConversations({ recent }) {
  const [filterKey, setFilterKey] = useState('all');
  const countOf = (filter) => recent.filter((item) => !filter.statuses || filter.statuses.includes(item.status)).length;
  const active = CONVERSATION_FILTERS.find((filter) => filter.key === filterKey);
  const shown = recent.filter((item) => !active.statuses || active.statuses.includes(item.status));

  return (
    <Panel
      title="Recent conversations"
      subtitle="The latest conversations you can see, newest first"
      action={<ArrowLink to={ROUTE_PATHS.CONSOLE}>Open console</ArrowLink>}
    >
      <div role="group" aria-label="Filter conversations" className="mb-5 flex flex-wrap gap-2">
        {CONVERSATION_FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            onClick={() => setFilterKey(filter.key)}
            aria-pressed={filter.key === filterKey}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
              filter.key === filterKey
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {filter.label} ({countOf(filter)})
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 px-5 py-8 text-center text-sm text-slate-500">
          No conversations here right now.
        </p>
      ) : (
        <ul className="space-y-3">
          {shown.map((conversation) => (
            <li key={conversation.id} className="flex gap-4 rounded-2xl bg-slate-50 p-4 sm:p-5">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-sm font-semibold text-slate-700 ring-1 ring-slate-200"
                aria-hidden="true"
              >
                {conversation.customerName ? initialsOf(conversation.customerName) : '?'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="font-semibold text-slate-900">{conversation.customerName ?? 'Unknown customer'}</p>
                  <span className="text-xs text-slate-400">· {formatRelativeTime(conversation.updatedAt)}</span>
                  <StatusChip status={conversation.status} />
                  {conversation.assignedToYou && <Pill className="bg-brand-50 text-brand-700">Yours</Pill>}
                </div>
                {conversation.lastMessage && (
                  <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{conversation.lastMessage.text}</p>
                )}
              </div>
              <Link
                to={ROUTE_PATHS.CONSOLE}
                className="h-fit shrink-0 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
              >
                {conversation.status === 'escalated-to-human' ? 'Take over' : 'Open'}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PulseTile({ label, value, note, barShare, Icon }) {
  return (
    <div className="rounded-2xl border border-slate-200/70 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
        {label}
        <Icon className="h-4 w-4 text-slate-400" />
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
      <div className="mt-3 h-1.5 rounded-full bg-slate-100" aria-hidden="true">
        <div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${Math.round((barShare ?? 0) * 100)}%` }} />
      </div>
    </div>
  );
}

export function IntelligencePulse({ support, rangeLabel }) {
  const { period } = support;
  return (
    <Panel
      title="Intelligence pulse"
      subtitle={`How the AI and agents handled conversations · ${rangeLabel}`}
      action={<Pill className="bg-brand-50 text-brand-700">Live data</Pill>}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <PulseTile
          label="AI resolution"
          value={formatShare(period.handledByAiShare)}
          note="Handled without an agent"
          barShare={period.handledByAiShare}
          Icon={CheckBadgeIcon}
        />
        <PulseTile
          label="Escalation rate"
          value={formatShare(period.escalationShare)}
          note="Needed an agent"
          barShare={period.escalationShare}
          Icon={UsersIcon}
        />
        <PulseTile
          label="AI reply time"
          value={formatDuration(period.medianAiReplyMs)}
          note="Median first AI reply"
          barShare={period.withinTargetShare}
          Icon={ClockIcon}
        />
      </div>
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">Replies over time</h3>
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-brand-600" aria-hidden="true" />
            AI replies
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-slate-300" aria-hidden="true" />
            Agent replies
          </span>
        </div>
      </div>
      <div className="mt-4">
        <ActivityChart activity={support.activity} />
      </div>
    </Panel>
  );
}

export function ConsoleCard({ waitingForAgent }) {
  return (
    <section className="relative overflow-hidden rounded-[1.6rem] bg-gradient-to-br from-slate-800 via-slate-900 to-[#2a1f1a] p-6 text-white shadow-xl shadow-slate-900/20 sm:p-7">
      <div
        className="pointer-events-none absolute -right-10 -bottom-16 h-56 w-56 rounded-full bg-amber-500/15 blur-3xl"
        aria-hidden="true"
      />
      <div className="flex items-start justify-between">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
          <InboxIcon className="h-5 w-5" />
        </span>
        <Pill className="bg-white/10 text-[11px] tracking-wider text-white/80 uppercase">
          {waitingForAgent > 0 ? `${waitingForAgent} waiting` : 'Queue clear'}
        </Pill>
      </div>
      <h2 className="mt-8 text-2xl font-semibold tracking-tight">Support console</h2>
      <p className="mt-3 text-sm leading-relaxed text-white/70">
        Claim escalated chats, reply to customers live, and review the AI&apos;s reasoning and tool calls as they
        happen.
      </p>
      <Link
        to={ROUTE_PATHS.CONSOLE}
        className="mt-7 flex h-12 items-center justify-center gap-2 rounded-full bg-white text-sm font-semibold text-slate-900 transition hover:bg-slate-100 focus-visible:ring-4 focus-visible:ring-white/30 focus-visible:outline-none"
      >
        Open console
        <ArrowRightIcon className="h-4 w-4" />
      </Link>
    </section>
  );
}

export function TeamCard({ accounts }) {
  return (
    <Panel>
      <div className="flex items-start justify-between">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <UsersIcon className="h-5 w-5" />
        </span>
        <span className="text-xs text-slate-500">Role-based access</span>
      </div>
      <h2 className="mt-5 text-lg font-semibold tracking-tight text-slate-900">Team &amp; roles</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        Promote people to agents, HR or admins, and manage what each role can see and do.
      </p>
      <dl className="mt-5 grid grid-cols-4 gap-2 text-center">
        {Object.entries(accounts.perRole).map(([role, count]) => (
          <div key={role} className="rounded-xl bg-slate-50 px-1 py-2.5">
            <dt className="truncate text-[11px] text-slate-500">{ROLE_DISPLAY[role]?.pluralLabel ?? role}</dt>
            <dd className="text-lg font-semibold text-slate-900">{count}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 flex justify-end">
        <ArrowLink to={ROUTE_PATHS.ADMIN_USERS}>Manage users</ArrowLink>
      </div>
    </Panel>
  );
}

const SERVICE_ICONS = Object.freeze({
  aiService: SparklesIcon,
  email: ChatIcon,
  database: TerminalIcon,
  cache: ClockIcon,
});

export function ConnectedServices({ health, isLoading, error }) {
  const allOperational = health?.overall === 'operational';
  return (
    <Panel
      title="Connected services"
      action={
        health && (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
            <span
              className={`h-2 w-2 rounded-full ${SERVICE_STATE_TONES[health.overall].dotClassName}`}
              aria-hidden="true"
            />
            {allOperational ? 'All online' : health.overallLabel}
          </span>
        )
      }
    >
      {error && <p className="text-sm text-red-600">{error.message}</p>}
      {isLoading && !health && <p className="text-sm text-slate-500">Checking the services…</p>}
      {health && (
        <ul className="space-y-3">
          {health.services.map((service) => {
            const Icon = SERVICE_ICONS[service.key] ?? TerminalIcon;
            const tone = SERVICE_STATE_TONES[service.status];
            return (
              <li key={service.key} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-slate-600 ring-1 ring-slate-200">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{service.label}</p>
                  <p className="text-xs text-slate-500">Answered in {formatDuration(service.responseMs)}</p>
                </div>
                <Pill className={tone.chipClassName}>{service.statusLabel}</Pill>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
