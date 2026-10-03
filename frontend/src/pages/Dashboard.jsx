/**
 * Overview: the landing page after signing in, rendered inside AppShell.
 *
 *   customer  greeting, a "chat with support" call to action, and the state of their conversation
 *   agent     queue statistics and the most recent conversations they can see
 *   admin     the same, plus account totals per role and a shortcut to user management
 *   hr        what the role covers and account shortcuts (no support queue)
 *
 * Data comes from GET /api/conversations (already scoped by the backend to what the viewer may
 * see) and, for admins, GET /api/admin/users. Each block loads independently: a failure shows an
 * error banner but leaves the rest of the page usable. A 401 means the session ended.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { requestUserList } from '../api/adminApi.js';
import { requestConversationList } from '../api/conversationsApi.js';
import { ApiError, HTTP_STATUS_UNAUTHORIZED } from '../api/httpClient.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { ArrowRightIcon, ChatIcon, ClockIcon, InboxIcon, KeyIcon, ShieldIcon, SparklesIcon, UserCircleIcon, UsersIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import { CONVERSATION_STATUS_DISPLAY, UNKNOWN_STATUS_DISPLAY } from '../constants/conversationDisplay.js';
import { API_MESSAGES } from '../constants/messages.js';
import { ROLE_DISPLAY, ROUTE_PATHS, STAFF_ROLES, USER_ROLES } from '../constants/routes.js';

/** What the customer is told about their latest conversation, by status. */
const CUSTOMER_STATUS_SUMMARY = Object.freeze({
  unassigned: 'Our AI assistant is ready to help.',
  'processing-ai': 'Our AI assistant is handling your request.',
  'escalated-to-human': 'A support specialist will join your chat shortly.',
  'assigned-agent': 'A support specialist is helping you now.',
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago", "yesterday"; empty for an invalid timestamp. */
function formatRelativeTime(isoTimestamp) {
  const timestampMs = isoTimestamp ? new Date(isoTimestamp).getTime() : Number.NaN;
  if (Number.isNaN(timestampMs)) return '';
  const elapsedSeconds = Math.round((timestampMs - Date.now()) / 1000);
  const timeUnits = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unitName, unitSeconds] of timeUnits) {
    if (Math.abs(elapsedSeconds) >= unitSeconds) return relativeTimeFormatter.format(Math.round(elapsedSeconds / unitSeconds), unitName);
  }
  return 'just now';
}

function greetingForHour(hourOfDay) {
  if (hourOfDay < 12) return 'Good morning';
  if (hourOfDay < 18) return 'Good afternoon';
  return 'Good evening';
}

function toDisplayableError(error) {
  return {
    message: error instanceof ApiError ? error.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR,
    requestId: error instanceof ApiError && error.status >= 500 ? error.requestId : null,
  };
}

// =================================================================================================
// Render pieces
// =================================================================================================

function StatusChip({ status }) {
  const statusDisplay = CONVERSATION_STATUS_DISPLAY[status] ?? UNKNOWN_STATUS_DISPLAY;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusDisplay.chipClassName}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${statusDisplay.dotClassName}`} aria-hidden="true" />
      {statusDisplay.label}
    </span>
  );
}

function StatTile({ label, value, hint, Icon, accentClassName, isLoading }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${accentClassName}`}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
        {isLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded-lg bg-slate-100 align-middle" aria-label="Loading" /> : value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function SkeletonRows({ rowCount = 3 }) {
  return (
    <ul className="divide-y divide-slate-100" aria-label="Loading">
      {Array.from({ length: rowCount }, (_, rowIndex) => (
        <li key={rowIndex} className="flex items-center gap-4 px-5 py-4">
          <span className="h-9 w-9 animate-pulse rounded-full bg-slate-100" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-1/3 animate-pulse rounded bg-slate-100" />
            <span className="block h-3 w-2/3 animate-pulse rounded bg-slate-100" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function CustomerOverview({ latestConversation, isLoading }) {
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 p-8 text-white shadow-xl shadow-indigo-500/20 lg:col-span-3">
        <div className="pointer-events-none absolute -top-16 -right-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
        <SparklesIcon className="h-8 w-8 text-indigo-100" />
        <h2 className="mt-4 text-2xl font-bold tracking-tight">Need a hand? We reply in seconds.</h2>
        <p className="mt-2 max-w-md text-sm text-indigo-100">
          Describe your problem in plain words. Our AI assistant answers right away, and a support specialist can take over the same chat whenever you need a person.
        </p>
        <Link
          to={ROUTE_PATHS.SUPPORT}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-indigo-700 shadow-lg transition hover:bg-indigo-50 focus-visible:ring-4 focus-visible:ring-white/40 focus-visible:outline-none"
        >
          {latestConversation ? 'Continue your conversation' : 'Start a conversation'}
          <ArrowRightIcon className="h-4 w-4" />
        </Link>
      </section>

      <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm lg:col-span-2">
        <h2 className="text-sm font-semibold text-slate-900">Your latest request</h2>
        {isLoading ? (
          <div className="mt-4 space-y-3" aria-label="Loading">
            <span className="block h-5 w-28 animate-pulse rounded-full bg-slate-100" />
            <span className="block h-3 w-full animate-pulse rounded bg-slate-100" />
            <span className="block h-3 w-2/3 animate-pulse rounded bg-slate-100" />
          </div>
        ) : latestConversation ? (
          <div className="mt-4">
            <StatusChip status={latestConversation.status} />
            <p className="mt-3 text-sm text-slate-700">{CUSTOMER_STATUS_SUMMARY[latestConversation.status] ?? ''}</p>
            {latestConversation.lastMessagePreview && (
              <p className="mt-3 line-clamp-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">“{latestConversation.lastMessagePreview}”</p>
            )}
            <p className="mt-3 text-xs text-slate-400">Updated {formatRelativeTime(latestConversation.updatedAt)}</p>
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-200 p-6 text-center">
            <ChatIcon className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-2 text-sm text-slate-500">No conversations yet. When you contact support, its status shows here.</p>
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-3 lg:col-span-5">
        {[
          { Icon: SparklesIcon, title: 'Instant answers', text: 'Billing and technical specialists reply immediately.' },
          { Icon: UsersIcon, title: 'Real people on request', text: 'Ask for a person and a specialist joins the same chat.' },
          { Icon: ShieldIcon, title: 'Private and secure', text: 'Only you and our support team can see your conversations.' },
        ].map(({ Icon, title, text }) => (
          <div key={title} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <Icon className="h-6 w-6 text-indigo-500" />
            <p className="mt-3 text-sm font-semibold text-slate-900">{title}</p>
            <p className="mt-1 text-sm text-slate-500">{text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

/** Overview for team roles without a support workload (HR): what the role covers and account shortcuts. */
function TeamMemberOverview({ currentUser }) {
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <section className="relative overflow-hidden rounded-3xl bg-slate-950 p-8 text-white shadow-xl lg:col-span-3">
        <div className="pointer-events-none absolute -top-16 -right-16 h-56 w-56 rounded-full bg-amber-400/20 blur-2xl" aria-hidden="true" />
        <ShieldIcon className="h-8 w-8 text-amber-300" />
        <h2 className="mt-4 text-2xl font-bold tracking-tight">{ROLE_DISPLAY[currentUser.role]?.label ?? currentUser.role} workspace</h2>
        <p className="mt-2 max-w-md text-sm text-slate-300">{ROLE_DISPLAY[currentUser.role]?.description}. Access to employee documents is granted per document and every access is audited.</p>
      </section>
      <section className="space-y-4 lg:col-span-2">
        {[
          { Icon: UserCircleIcon, title: 'Your profile', text: 'Check the name, email and role on your account.' },
          { Icon: KeyIcon, title: 'Sign-in security', text: 'Change your password; other devices are signed out.' },
        ].map(({ Icon, title, text }) => (
          <Link
            key={title}
            to={ROUTE_PATHS.ACCOUNT}
            className="flex items-start gap-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition hover:border-indigo-200 hover:shadow-md focus-visible:ring-4 focus-visible:ring-indigo-100 focus-visible:outline-none"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              <Icon className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-slate-900">{title}</span>
              <span className="mt-0.5 block text-sm text-slate-500">{text}</span>
            </span>
          </Link>
        ))}
      </section>
    </div>
  );
}

function StaffOverview({ currentUser, conversations, isLoadingConversations, userCounts, isLoadingUsers }) {
  const isAdmin = currentUser.role === USER_ROLES.ADMIN;
  const waitingCount = conversations.filter((conversation) => conversation.status === 'escalated-to-human').length;
  const mineCount = conversations.filter((conversation) => conversation.status === 'assigned-agent' && conversation.assignedAgentId === currentUser.id).length;
  const aiCount = conversations.filter((conversation) => conversation.status === 'processing-ai' || conversation.status === 'unassigned').length;
  const recentConversations = conversations.slice(0, 6);

  return (
    <div className="space-y-6">
      <div className={`grid gap-4 sm:grid-cols-2 ${isAdmin ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        <StatTile label="Waiting for an agent" value={waitingCount} hint="Escalated and not yet claimed" Icon={ClockIcon} accentClassName="bg-amber-50 text-amber-600" isLoading={isLoadingConversations} />
        <StatTile label="Assigned to you" value={mineCount} hint="Conversations you are handling" Icon={InboxIcon} accentClassName="bg-emerald-50 text-emerald-600" isLoading={isLoadingConversations} />
        <StatTile
          label={isAdmin ? 'Handled by AI' : 'Visible to you'}
          value={isAdmin ? aiCount : conversations.length}
          hint={isAdmin ? 'Being answered by the assistant' : 'Your assignments plus the queue'}
          Icon={SparklesIcon}
          accentClassName="bg-indigo-50 text-indigo-600"
          isLoading={isLoadingConversations}
        />
        {isAdmin && (
          <StatTile
            label="Accounts"
            value={userCounts ? Object.values(userCounts).reduce((runningTotal, roleCount) => runningTotal + roleCount, 0) : '—'}
            hint={userCounts ? `${userCounts.admin ?? 0} admin · ${userCounts.agent ?? 0} agent · ${userCounts.customer ?? 0} customer` : 'Unavailable'}
            Icon={UsersIcon}
            accentClassName="bg-violet-50 text-violet-600"
            isLoading={isLoadingUsers}
          />
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm xl:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">Recent conversations</h2>
            <Link to={ROUTE_PATHS.CONSOLE} className="inline-flex items-center gap-1 rounded text-sm font-medium text-indigo-600 hover:text-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none">
              Open console <ArrowRightIcon className="h-4 w-4" />
            </Link>
          </div>
          {isLoadingConversations ? (
            <SkeletonRows />
          ) : recentConversations.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <InboxIcon className="mx-auto h-8 w-8 text-slate-300" />
              <p className="mt-2 text-sm text-slate-500">No conversations to show yet. New escalations appear here and in the console.</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentConversations.map((conversation) => (
                <li key={conversation.conversationId}>
                  <Link
                    to={`${ROUTE_PATHS.CONSOLE}?conversation=${encodeURIComponent(conversation.conversationId)}`}
                    className="flex items-center gap-4 px-5 py-4 transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600" aria-hidden="true">
                      {(conversation.customerName ?? '?').trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900">{conversation.customerName ?? 'Unknown customer'}</span>
                        <span className="shrink-0 text-xs text-slate-400">{formatRelativeTime(conversation.updatedAt)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-slate-500">{conversation.lastMessagePreview ?? 'No messages yet'}</span>
                    </span>
                    <span className="hidden sm:block">
                      <StatusChip status={conversation.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-4">
          <div className="rounded-2xl bg-slate-950 p-6 text-white shadow-sm">
            <InboxIcon className="h-7 w-7 text-indigo-300" />
            <h2 className="mt-3 text-base font-semibold">Support console</h2>
            <p className="mt-1 text-sm text-slate-400">Claim escalated chats, reply to customers live, and review the AI’s reasoning logs.</p>
            <Link
              to={ROUTE_PATHS.CONSOLE}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-indigo-50 focus-visible:ring-4 focus-visible:ring-white/30 focus-visible:outline-none"
            >
              Open console <ArrowRightIcon className="h-4 w-4" />
            </Link>
          </div>
          {isAdmin && (
            <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm">
              <UsersIcon className="h-7 w-7 text-violet-500" />
              <h2 className="mt-3 text-base font-semibold text-slate-900">Team & roles</h2>
              <p className="mt-1 text-sm text-slate-500">Promote customers to agents or admins and manage who can work in the console.</p>
              <Link
                to={ROUTE_PATHS.ADMIN_USERS}
                className="mt-5 inline-flex items-center gap-1 rounded text-sm font-semibold text-violet-600 hover:text-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
              >
                Manage users <ArrowRightIcon className="h-4 w-4" />
              </Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// =================================================================================================
// Page
// =================================================================================================

export default function Dashboard() {
  const { currentUser, markSessionEnded } = useAuth();
  const isStaff = STAFF_ROLES.includes(currentUser.role);
  const isAdmin = currentUser.role === USER_ROLES.ADMIN;

  const [conversations, setConversations] = useState([]);
  // Conversations matter only to staff (their queue) and customers (their own chat).
  const isCustomer = currentUser.role === USER_ROLES.CUSTOMER;
  const usesConversations = isStaff || isCustomer;
  const [isLoadingConversations, setIsLoadingConversations] = useState(usesConversations);
  const [userCounts, setUserCounts] = useState(null);
  const [isLoadingUsers, setIsLoadingUsers] = useState(isAdmin);
  const [pageError, setPageError] = useState(null);

  const handleLoadError = useCallback(
    (error, signal) => {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.status === HTTP_STATUS_UNAUTHORIZED) {
        markSessionEnded();
        return;
      }
      setPageError(toDisplayableError(error));
    },
    [markSessionEnded],
  );

  useEffect(() => {
    const loadController = new AbortController();
    const { signal } = loadController;

    if (usesConversations) {
      requestConversationList({ signal })
        .then((loadedConversations) => setConversations(loadedConversations))
        .catch((error) => handleLoadError(error, signal))
        .finally(() => {
          if (!signal.aborted) setIsLoadingConversations(false);
        });
    }

    if (isAdmin) {
      requestUserList({}, { signal })
        .then(({ countsByRole }) => setUserCounts(countsByRole))
        .catch((error) => handleLoadError(error, signal))
        .finally(() => {
          if (!signal.aborted) setIsLoadingUsers(false);
        });
    }

    return () => loadController.abort();
  }, [isAdmin, usesConversations, handleLoadError]);

  const firstName = currentUser.name.trim().split(/\s+/)[0];

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-8 lg:py-10">
      <PageHeader
        title={`${greetingForHour(new Date().getHours())}, ${firstName}`}
        description={isStaff ? 'Here’s what’s happening in support right now.' : 'Welcome to your support workspace.'}
        actions={<RoleBadge role={currentUser.role} />}
      />

      {pageError && <ErrorBanner title="Some information could not be loaded" message={pageError.message} requestId={pageError.requestId} onDismiss={() => setPageError(null)} />}

      {isStaff ? (
        <StaffOverview
          currentUser={currentUser}
          conversations={conversations}
          isLoadingConversations={isLoadingConversations}
          userCounts={userCounts}
          isLoadingUsers={isLoadingUsers}
        />
      ) : isCustomer ? (
        <CustomerOverview latestConversation={conversations[0] ?? null} isLoading={isLoadingConversations} />
      ) : (
        <TeamMemberOverview currentUser={currentUser} />
      )}
    </div>
  );
}
