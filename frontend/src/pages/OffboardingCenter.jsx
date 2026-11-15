/**
 * Offboarding outside the NSK conversation (/people/offboarding), read-only:
 *
 *   Settlements   VIEW_FINAL_SETTLEMENT (finance, HR, admin): every offboarding case with its status,
 *                 last working day and net; opening one shows its settlement as HR previewed it and its
 *                 documents, with download buttons for the ones this role may download (finance: the
 *                 settlement statement)
 *   IT checklist  VIEW_IT_OFFBOARDING (IT administrator, HR, admin): everyone serving notice, their last
 *                 working day and work email, and what to revoke on that day; no pay figures
 *
 * Starting and changing offboarding happens in NSK (components/nskBot/OffboardingPanel.jsx).
 */

import { useState } from 'react';
import { requestItChecklist, requestOffboardingCase, requestOffboardingCases } from '../api/nskBotApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { hasCapability } from '../auth/capabilities.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { ArrowLeftIcon, CheckBadgeIcon, DocumentIcon, ShieldIcon } from '../components/Icons.jsx';
import OffboardingDocuments from '../components/nskBot/OffboardingDocuments.jsx';
import SettlementBreakdown from '../components/nskBot/SettlementBreakdown.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Tabs, formatDate, formatInr } from '../components/ui.jsx';
import { CAPABILITIES } from '../constants/capabilities.js';
import { OFFBOARDING_PAGE_LABELS as P, OFFBOARDING_STATUS_DISPLAY } from '../constants/nskBot.js';
import { useApiResource } from '../hooks/useApiResource.js';

function CaseDetail({ caseId, onBack }) {
  const { data, error, isLoading } = useApiResource((signal) => requestOffboardingCase(caseId, signal), [caseId]);
  const offboardingCase = data?.case;
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeftIcon className="h-4 w-4" />
        {P.BACK}
      </Button>
      {isLoading && <LoadingBlock />}
      {error && <ErrorBanner message={error.message} requestId={error.requestId} />}
      {offboardingCase && (
        <Card
          title={`${offboardingCase.employee.name} · ${offboardingCase.employee.employeeCode}`}
          subtitle={P.READ_ONLY}
        >
          <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
            <SettlementBreakdown offboardingCase={offboardingCase} />
            {offboardingCase.artifacts.length > 0 && <OffboardingDocuments offboardingCase={offboardingCase} />}
          </div>
        </Card>
      )}
    </div>
  );
}

function SettlementsPanel() {
  const [openCaseId, setOpenCaseId] = useState(null);
  const { data, error, isLoading } = useApiResource((signal) => requestOffboardingCases(signal), []);
  if (openCaseId) return <CaseDetail caseId={openCaseId} onBack={() => setOpenCaseId(null)} />;
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBanner message={error.message} requestId={error.requestId} />;
  if (data.cases.length === 0) return <EmptyState title={P.NO_CASES} Icon={DocumentIcon} />;
  return (
    <Card bodyClassName="p-0">
      <table className="w-full text-sm" aria-label={P.SETTLEMENTS}>
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="px-5 py-3 font-semibold">{P.EMPLOYEE}</th>
            <th className="px-5 py-3 font-semibold">{P.STATUS}</th>
            <th className="px-5 py-3 font-semibold">{P.LAST_DAY}</th>
            <th className="px-5 py-3 text-right font-semibold">{P.NET}</th>
          </tr>
        </thead>
        <tbody>
          {data.cases.map((item) => {
            const status = OFFBOARDING_STATUS_DISPLAY[item.status];
            return (
              <tr key={item.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                <td className="px-5 py-3">
                  <button
                    type="button"
                    onClick={() => setOpenCaseId(item.id)}
                    className="text-left font-semibold text-brand-700 hover:underline"
                  >
                    {item.employee.name}
                  </button>
                  <span className="block text-xs text-slate-500">
                    {item.employee.employeeCode} · {item.employee.designation}
                  </span>
                </td>
                <td className="px-5 py-3">{status && <Badge tone={status.tone}>{status.label}</Badge>}</td>
                <td className="px-5 py-3">{formatDate(item.separation.lastWorkingDay)}</td>
                <td className="px-5 py-3 text-right tabular-nums">{formatInr(item.settlement.totals.net)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function ItChecklistPanel() {
  const { data, error, isLoading } = useApiResource((signal) => requestItChecklist(signal), []);
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBanner message={error.message} requestId={error.requestId} />;
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
      <Card title={P.REVOKE_ON_LAST_DAY}>
        <ul className="space-y-2 text-sm text-slate-700">
          {data.items.map((item) => (
            <li key={item} className="flex gap-2">
              <CheckBadgeIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
              {item}
            </li>
          ))}
        </ul>
      </Card>
      {data.people.length === 0 ? (
        <EmptyState title={P.NO_NOTICE} Icon={ShieldIcon} />
      ) : (
        <Card bodyClassName="p-0">
          <ul className="divide-y divide-slate-100" aria-label={P.IT_CHECKLIST}>
            {data.people.map((person) => (
              <li key={person.employeeId} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">
                    {person.name} · {person.employeeCode}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {person.designation}
                    {person.department ? ` · ${person.department}` : ''}
                    {person.workEmail ? ` · ${P.WORK_EMAIL}: ${person.workEmail}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium">
                    {person.lastWorkingDay ? formatDate(person.lastWorkingDay) : '—'}
                  </p>
                  <p className="text-xs text-slate-500">{P.DAYS_LEFT(person.daysLeft)}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default function OffboardingCenter() {
  const { currentUser } = useAuth();
  const tabs = [
    hasCapability(currentUser, CAPABILITIES.VIEW_FINAL_SETTLEMENT) && {
      id: 'settlements',
      label: P.SETTLEMENTS,
      Icon: DocumentIcon,
      Panel: SettlementsPanel,
    },
    hasCapability(currentUser, CAPABILITIES.VIEW_IT_OFFBOARDING) && {
      id: 'it',
      label: P.IT_CHECKLIST,
      Icon: ShieldIcon,
      Panel: ItChecklistPanel,
    },
  ].filter(Boolean);
  const [activeTabId, setActiveTabId] = useState(tabs[0]?.id);
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title={P.TITLE} description={P.SUBTITLE} />
      {tabs.length > 1 && (
        <Tabs
          tabs={tabs.map(({ id, label, Icon }) => ({ id, label, Icon }))}
          activeTabId={active.id}
          onChange={setActiveTabId}
          label={P.TITLE}
        />
      )}
      {active && <active.Panel />}
    </div>
  );
}
