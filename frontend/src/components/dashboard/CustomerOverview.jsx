/**
 * The dashboard of an account without an employee profile that talks to support (customer): a
 * call to chat with support, and the state of their latest conversation
 * (GET /api/conversations, already limited by the server to their own).
 */

import { Link } from 'react-router';
import { ROUTE_PATHS } from '../../constants/routes.js';
import { formatRelativeTime } from '../../utils/dashboardFormat.js';
import { ArrowRightIcon, ChatIcon, ShieldIcon, SparklesIcon, UsersIcon } from '../Icons.jsx';
import { StatusChip } from './DashboardParts.jsx';

/** What the customer is told about their latest conversation, by status. */
const CUSTOMER_STATUS_SUMMARY = Object.freeze({
  unassigned: 'Our AI assistant is ready to help.',
  'processing-ai': 'Our AI assistant is handling your request.',
  'escalated-to-human': 'A support specialist will join your chat shortly.',
  'assigned-agent': 'A support specialist is helping you now.',
});

export default function CustomerOverview({ latestConversation, isLoading }) {
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 via-brand-700 to-indigo-800 p-8 text-white shadow-xl shadow-brand-500/20 lg:col-span-3">
        <div
          className="pointer-events-none absolute -top-16 -right-16 h-56 w-56 rounded-full bg-white/10 blur-2xl"
          aria-hidden="true"
        />
        <SparklesIcon className="h-8 w-8 text-brand-100" />
        <h2 className="mt-4 text-2xl font-bold tracking-tight">Need a hand? We reply in seconds.</h2>
        <p className="mt-2 max-w-md text-sm text-brand-100">
          Describe your problem in plain words. Our AI assistant answers right away, and a support specialist can take
          over the same chat whenever you need a person.
        </p>
        <Link
          to={ROUTE_PATHS.SUPPORT}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-brand-700 shadow-lg transition hover:bg-brand-50 focus-visible:ring-4 focus-visible:ring-white/40 focus-visible:outline-none"
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
              <p className="mt-3 line-clamp-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
                “{latestConversation.lastMessagePreview}”
              </p>
            )}
            <p className="mt-3 text-xs text-slate-400">Updated {formatRelativeTime(latestConversation.updatedAt)}</p>
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-200 p-6 text-center">
            <ChatIcon className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-2 text-sm text-slate-500">
              No conversations yet. When you contact support, its status shows here.
            </p>
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-3 lg:col-span-5">
        {[
          {
            Icon: SparklesIcon,
            title: 'Instant answers',
            text: 'Billing and technical specialists reply immediately.',
          },
          {
            Icon: UsersIcon,
            title: 'Real people on request',
            text: 'Ask for a person and a specialist joins the same chat.',
          },
          {
            Icon: ShieldIcon,
            title: 'Private and secure',
            text: 'Only you and our support team can see your conversations.',
          },
        ].map(({ Icon, title, text }) => (
          <div key={title} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <Icon className="h-6 w-6 text-brand-500" />
            <p className="mt-3 text-sm font-semibold text-slate-900">{title}</p>
            <p className="mt-1 text-sm text-slate-500">{text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
