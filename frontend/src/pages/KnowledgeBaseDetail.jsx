/**
 * One department's knowledge base (GET /api/departments/:departmentId/agent/settings), reached from
 * Departments & Agents (admins) or My department's knowledge base (heads and leads):
 *
 *   Settings    the agent's name, instructions, Active/Paused and lead (KnowledgeSettingsPanel.jsx)
 *   Documents   upload, processing status, failures and delete (KnowledgeDocumentsPanel.jsx)
 *   Questions   what the agent could not answer, to reply to and save as FAQs (QuestionsInboxPanel.jsx)
 *
 * The open tab is kept in the address (?tab=documents), so it survives a reload and can be shared.
 * Anyone the backend refuses (403), an unknown department (404) or an inactive one (409) sees the
 * backend's message and the way back.
 */

import { Link, useParams, useSearchParams } from 'react-router';
import { requestKnowledgeSettings } from '../api/knowledgeApi.js';
import { ArrowLeftIcon, DocumentIcon, QuestionIcon, SparklesIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import KnowledgeDocumentsPanel from '../components/knowledge/KnowledgeDocumentsPanel.jsx';
import KnowledgeSettingsPanel from '../components/knowledge/KnowledgeSettingsPanel.jsx';
import QuestionsInboxPanel from '../components/knowledge/QuestionsInboxPanel.jsx';
import { Badge, LoadingBlock, Notice, Tabs } from '../components/ui.jsx';
import { AGENT_STATUS_DISPLAY } from '../constants/knowledge.js';
import { useApiResource } from '../hooks/useApiResource.js';

const DETAIL_TABS = Object.freeze([
  { id: 'settings', label: 'Settings', Icon: SparklesIcon },
  { id: 'documents', label: 'Documents', Icon: DocumentIcon },
  { id: 'questions', label: 'Questions', Icon: QuestionIcon },
]);
const TAB_PARAMETER = 'tab';

function BackLink({ to, label }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      {label}
    </Link>
  );
}

/** @param {{ listPath: string, listLabel: string }} props  where "back" goes */
export default function KnowledgeBaseDetail({ listPath, listLabel }) {
  const { departmentId } = useParams();
  const [searchParameters, setSearchParameters] = useSearchParams();
  const settingsResource = useApiResource((signal) => requestKnowledgeSettings(departmentId, signal), [departmentId]);
  const settings = settingsResource.data?.settings ?? null;
  const activeTabId = DETAIL_TABS.some((tab) => tab.id === searchParameters.get(TAB_PARAMETER))
    ? searchParameters.get(TAB_PARAMETER)
    : DETAIL_TABS[0].id;

  function selectTab(tabId) {
    setSearchParameters(tabId === DETAIL_TABS[0].id ? {} : { [TAB_PARAMETER]: tabId }, { replace: true });
  }

  const backLink = <BackLink to={listPath} label={listLabel} />;

  if (settingsResource.isLoading && !settings) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
        {backLink}
        <LoadingBlock label="Loading the knowledge base…" />
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
        {backLink}
        <Notice tone="error" title={settingsResource.error?.message} />
      </div>
    );
  }

  const status = AGENT_STATUS_DISPLAY[settings.status];
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      {backLink}
      <PageHeader
        title={settings.name}
        description={`${settings.department.name} · ${settings.department.code}`}
        actions={<Badge tone={status.tone}>{status.label}</Badge>}
      />
      <Tabs tabs={DETAIL_TABS} activeTabId={activeTabId} onChange={selectTab} label="Knowledge base sections" />
      {activeTabId === 'settings' && (
        <KnowledgeSettingsPanel
          departmentId={departmentId}
          settings={settings}
          onSaved={(savedSettings) => settingsResource.setData({ settings: savedSettings })}
          onReload={settingsResource.reload}
        />
      )}
      {activeTabId === 'documents' && <KnowledgeDocumentsPanel departmentId={departmentId} settings={settings} />}
      {activeTabId === 'questions' && <QuestionsInboxPanel departmentId={departmentId} />}
    </div>
  );
}
