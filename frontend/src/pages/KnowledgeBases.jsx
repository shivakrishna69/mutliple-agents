/**
 * Department knowledge bases, as a list (GET /api/knowledge-bases), in two places:
 *
 *   scope "hub"   Departments & Agents (admins, management view): every department, with its agent's
 *                 status, lead and documents, and totals across them
 *   scope "mine"  My department's knowledge base (self-service): the departments this person heads or
 *                 leads; with exactly one, it opens straight away
 *
 * The backend decides what each person may see; this page shows what it sends. An inactive
 * department is listed but cannot be opened until it is reactivated (Workplace → Departments).
 */

import { Link, Navigate } from 'react-router';
import { requestKnowledgeBases } from '../api/knowledgeApi.js';
import { BookOpenIcon, CheckBadgeIcon, ClockIcon, DocumentIcon, FlagIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, Card, EmptyState, LoadingBlock, Notice, StatTile, formatDateTime } from '../components/ui.jsx';
import {
  AGENT_STATUSES,
  AGENT_STATUS_DISPLAY,
  IN_PROGRESS_DOCUMENT_STATUSES,
  KNOWLEDGE_ACCESS_BASIS,
} from '../constants/knowledge.js';
import { useApiResource } from '../hooks/useApiResource.js';

const KNOWLEDGE_LIST_SCOPES = Object.freeze({
  hub: {
    title: 'Departments & Agents',
    description: "Each department's AI agent: whether it is active, who leads it, and what it has read.",
    emptyTitle: 'No departments yet',
    emptyDescription: 'Add departments in Workplace → Departments; each gets an agent and a knowledge base.',
    includes: () => true,
  },
  mine: {
    title: "My department's knowledge base",
    description: 'The documents your department agent answers from, and how it behaves.',
    emptyTitle: 'No knowledge base to manage',
    emptyDescription: 'You can manage a knowledge base when you head a department or are made its lead.',
    // An administrator's own list leaves out the departments they reach only as an administrator.
    includes: (knowledgeBase) => knowledgeBase.access.basis !== KNOWLEDGE_ACCESS_BASIS.ADMIN,
  },
});

const sumOf = (knowledgeBases, pick) => knowledgeBases.reduce((total, knowledgeBase) => total + pick(knowledgeBase), 0);

function AgentStatus({ agent }) {
  const display = AGENT_STATUS_DISPLAY[agent?.status ?? 'NOT_SET_UP'];
  return <Badge tone={display.tone}>{display.label}</Badge>;
}

function DocumentCounts({ documents }) {
  const inProgress = IN_PROGRESS_DOCUMENT_STATUSES.reduce((total, status) => total + documents.byStatus[status], 0);
  if (documents.total === 0) return <span className="text-slate-400">None yet</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      <Badge tone="emerald">{documents.byStatus.READY} ready</Badge>
      {inProgress > 0 && <Badge tone="brand">{inProgress} processing</Badge>}
      {documents.byStatus.FAILED > 0 && <Badge tone="rose">{documents.byStatus.FAILED} failed</Badge>}
    </span>
  );
}

function KnowledgeBaseRow({ knowledgeBase, detailPathOf }) {
  const { department, agent, documents } = knowledgeBase;
  return (
    <tr className="align-top">
      <td className="px-5 py-4 sm:px-6">
        <p className="font-semibold text-slate-900">
          {department.name} <span className="font-normal text-slate-500">· {department.code}</span>
        </p>
        <p className="mt-0.5 text-xs text-slate-500">{agent?.name ?? 'Agent not set up yet'}</p>
      </td>
      <td className="px-3 py-4">
        <span className="flex flex-wrap gap-1.5">
          <AgentStatus agent={agent} />
          {!department.isActive && <Badge tone="slate">Department inactive</Badge>}
        </span>
      </td>
      <td className="px-3 py-4 text-slate-700">
        {agent?.lead ? (
          <>
            <p>{agent.lead.name}</p>
            <p className="text-xs text-slate-500">{agent.lead.email}</p>
          </>
        ) : (
          <span className="text-slate-400">No lead</span>
        )}
      </td>
      <td className="px-3 py-4">
        <DocumentCounts documents={documents} />
      </td>
      <td className="px-3 py-4 whitespace-nowrap text-slate-600">{formatDateTime(documents.lastUploadedAt)}</td>
      <td className="px-5 py-4 text-right sm:px-6">
        {department.isActive && (
          <Link
            to={detailPathOf(department.id)}
            className="inline-flex items-center rounded-xl bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
            aria-label={`Open ${department.name}`}
          >
            Open
          </Link>
        )}
      </td>
    </tr>
  );
}

/**
 * @param {{ scope: 'hub'|'mine', detailPathOf: (departmentId: string) => string }} props
 */
export default function KnowledgeBases({ scope, detailPathOf }) {
  const settings = KNOWLEDGE_LIST_SCOPES[scope];
  const resource = useApiResource((signal) => requestKnowledgeBases(signal), []);
  const knowledgeBases = (resource.data?.knowledgeBases ?? []).filter(settings.includes);
  const openOnly = scope === 'mine' && knowledgeBases.length === 1 && knowledgeBases[0].department.isActive;

  if (openOnly) return <Navigate to={detailPathOf(knowledgeBases[0].department.id)} replace />;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title={settings.title} description={settings.description} />

      {scope === 'hub' && resource.data && knowledgeBases.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Departments" value={knowledgeBases.length} Icon={BookOpenIcon} />
          <StatTile
            label="Active agents"
            value={
              knowledgeBases.filter((knowledgeBase) => knowledgeBase.agent?.status === AGENT_STATUSES.ACTIVE).length
            }
            accent="emerald"
            Icon={CheckBadgeIcon}
          />
          <StatTile
            label="Documents ready"
            value={sumOf(knowledgeBases, (knowledgeBase) => knowledgeBase.documents.byStatus.READY)}
            accent="sky"
            Icon={DocumentIcon}
          />
          <StatTile
            label="Need attention"
            value={sumOf(knowledgeBases, (knowledgeBase) => knowledgeBase.documents.byStatus.FAILED)}
            hint="Documents that could not be read"
            accent="rose"
            Icon={FlagIcon}
          />
        </div>
      )}

      <Card bodyClassName="p-0">
        {resource.isLoading && !resource.data && <LoadingBlock label="Loading knowledge bases…" />}
        {resource.error && (
          <div className="p-6">
            <Notice tone="error" title={resource.error.message} />
          </div>
        )}
        {resource.data && knowledgeBases.length === 0 && (
          <div className="p-6">
            <EmptyState Icon={ClockIcon} title={settings.emptyTitle} description={settings.emptyDescription} />
          </div>
        )}
        {knowledgeBases.length > 0 && (
          <div className="relative overflow-x-auto scroll-thin">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-100 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-5 py-3 sm:px-6">
                    Department
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Agent
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Lead
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Documents
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Last upload
                  </th>
                  <th scope="col" className="px-5 py-3 sm:px-6">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {knowledgeBases.map((knowledgeBase) => (
                  <KnowledgeBaseRow
                    key={knowledgeBase.department.id}
                    knowledgeBase={knowledgeBase}
                    detailPathOf={detailPathOf}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
