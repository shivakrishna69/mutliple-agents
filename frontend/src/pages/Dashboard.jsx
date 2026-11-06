/**
 * Overview: the landing page after signing in, in the dashboard design, built from the sections the
 * server sends for this person's role (GET /api/dashboard/overview; a section that is not theirs
 * is null):
 *
 *   admin     support figures and accounts, the people row, recent conversations, the intelligence
 *             pulse, the support console, team & roles, connected services (GET /api/system/health)
 *   hr        the people row, headcount by department, upcoming holidays
 *   agent     support figures, recent conversations, the intelligence pulse, the support console
 *   employee  (anyone with an employee profile) their own day: punch-in, leave, requests, payslip
 *   customer  (no profile, no staff role) support chat and their latest conversation
 *
 * The range picker (today, 7 or 30 days, in the company's time zone) reloads the figures. Every
 * figure is the server's; "—" means there is nothing to measure yet.
 */

import { useState } from 'react';
import { requestConversationList } from '../api/conversationsApi.js';
import { requestDashboardOverview } from '../api/dashboardApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { CalendarIcon, ChevronDownIcon } from '../components/Icons.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import CustomerOverview from '../components/dashboard/CustomerOverview.jsx';
import { Pill, Skeleton } from '../components/dashboard/DashboardParts.jsx';
import {
  HeadcountPanel,
  HolidaysPanel,
  NextHolidayPill,
  PeopleStats,
  SelfStats,
} from '../components/dashboard/PeopleSections.jsx';
import {
  ConnectedServices,
  ConsoleCard,
  IntelligencePulse,
  RecentConversations,
  SupportStats,
  TeamCard,
} from '../components/dashboard/SupportSections.jsx';
import { SERVICE_STATE_TONES } from '../constants/dashboardDisplay.js';
import { USER_ROLES } from '../constants/routes.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useSystemHealth } from '../hooks/useSystemHealth.js';
import { greetingFor } from '../utils/dashboardFormat.js';

const DEFAULT_RANGE = 'today';

const SUBTITLES = Object.freeze({
  [USER_ROLES.ADMIN]: 'Here’s what’s happening across your people and support right now.',
  [USER_ROLES.HR]: 'Here’s how your organisation is doing today.',
  [USER_ROLES.AGENT]: 'Here’s what’s waiting in support right now.',
});

function RangePicker({ ranges, value, onChange }) {
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Period</span>
      <CalendarIcon className="pointer-events-none absolute left-3.5 h-4 w-4 text-slate-500" />
      <select
        value={value}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
        className="h-10 cursor-pointer appearance-none rounded-full border border-slate-200 bg-white pr-9 pl-10 text-sm font-medium text-slate-800 shadow-sm transition hover:border-slate-300 focus:border-brand-500 focus:ring-4 focus:ring-brand-100 focus:outline-none"
      >
        {ranges.map((range) => (
          <option key={range.key} value={range.key}>
            {range.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3.5 h-4 w-4 text-slate-400" />
    </label>
  );
}

function AiAgentPill({ health }) {
  const aiService = health?.services.find((service) => service.key === 'aiService');
  if (!aiService) return null;
  return (
    <Pill className="h-10 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200">
      <span
        className={`h-2 w-2 rounded-full ${SERVICE_STATE_TONES[aiService.status].dotClassName}`}
        aria-hidden="true"
      />
      AI agent: {aiService.statusLabel}
    </Pill>
  );
}

function LoadingRow() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Loading">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="rounded-[1.4rem] border border-slate-200/70 bg-white p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-6 h-10 w-16" />
          <Skeleton className="mt-4 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

const statGrid = (count) =>
  `grid gap-4 sm:grid-cols-2 ${count >= 5 ? 'xl:grid-cols-5' : count === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`;

export default function Dashboard() {
  const { currentUser } = useAuth();
  const [rangeKey, setRangeKey] = useState(DEFAULT_RANGE);
  const isAdmin = currentUser.role === USER_ROLES.ADMIN;
  const overview = useApiResource((signal) => requestDashboardOverview(rangeKey, { signal }), [rangeKey]);
  const health = useSystemHealth(isAdmin);
  const data = overview.data;
  const isCustomerView = Boolean(data) && !data.people && !data.support && !data.me;
  const conversations = useApiResource((signal) => requestConversationList({ signal }), [], {
    enabled: isCustomerView,
  });

  const firstName = currentUser.name.trim().split(/\s+/)[0];
  const support = data?.support ?? null;
  const people = data?.people ?? null;
  const supportCards = support ? (data.accounts ? 5 : 4) : 0;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6 px-4 py-6 sm:px-8 lg:space-y-8 lg:py-8">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[clamp(1.6rem,3vw,2.6rem)] leading-tight tracking-[-0.015em] text-slate-900">
              {greetingFor()}, {firstName}
            </h1>
            <RoleBadge role={currentUser.role} />
          </div>
          <p className="mt-2 max-w-xl text-[15px] text-slate-500">
            {SUBTITLES[currentUser.role] ?? 'Here’s your day at a glance.'}
          </p>
          {data?.me?.nextHoliday && (
            <div className="mt-3">
              <NextHolidayPill holiday={data.me.nextHoliday} />
            </div>
          )}
        </div>
        {(support || people) && data && (
          <div className="flex flex-wrap items-center gap-3">
            {isAdmin && <AiAgentPill health={health.data} />}
            <RangePicker ranges={data.ranges} value={rangeKey} onChange={setRangeKey} />
          </div>
        )}
      </header>

      {overview.error && (
        <ErrorBanner
          title="The dashboard could not be loaded"
          message={overview.error.message}
          requestId={overview.error.requestId}
        />
      )}

      {!data && overview.isLoading && <LoadingRow />}

      {support && (
        <div className={statGrid(supportCards)}>
          <SupportStats support={support} accounts={data.accounts} />
        </div>
      )}

      {people && (
        <section aria-label="People today" className="space-y-3">
          {support && <h2 className="text-sm font-semibold tracking-wider text-slate-500 uppercase">People today</h2>}
          <div className={statGrid(4)}>
            <PeopleStats people={people} />
          </div>
        </section>
      )}

      {data?.me && !support && !people && (
        <div className={statGrid(4)}>
          <SelfStats me={data.me} />
        </div>
      )}

      {(support || people) && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {support && <RecentConversations recent={support.recent} />}
            {support && <IntelligencePulse support={support} rangeLabel={data.range.label} />}
            {!support && people && <HeadcountPanel headcount={people.headcount} />}
          </div>
          <div className="space-y-6">
            {support && <ConsoleCard waitingForAgent={support.queue.waitingForAgent} />}
            {data.accounts && <TeamCard accounts={data.accounts} />}
            {isAdmin && <ConnectedServices health={health.data} isLoading={health.isLoading} error={health.error} />}
            {people && <HolidaysPanel holidays={people.holidays} />}
          </div>
        </div>
      )}

      {data?.me && (support || people) && (
        <section aria-label="My day" className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wider text-slate-500 uppercase">My day</h2>
          <div className={statGrid(4)}>
            <SelfStats me={data.me} />
          </div>
        </section>
      )}

      {isCustomerView && (
        <CustomerOverview latestConversation={conversations.data?.[0] ?? null} isLoading={conversations.isLoading} />
      )}
    </div>
  );
}
