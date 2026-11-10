/**
 * The department agents this person may ask (/agents; GET /api/departments/agents/available): their
 * own department's, and every shared service's. Each card opens that agent's chat.
 */

import { Link } from 'react-router';
import { requestAvailableAgents } from '../api/agentChatApi.js';
import { ArrowRightIcon, BookOpenIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, EmptyState, LoadingBlock, Notice } from '../components/ui.jsx';
import { AUDIENCE_DISPLAY } from '../constants/agentChat.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useApiResource } from '../hooks/useApiResource.js';

const chatPathOf = (departmentId) => ROUTE_PATHS.ASK_AGENT.replace(':departmentId', encodeURIComponent(departmentId));

export default function AgentDirectory() {
  const agentsResource = useApiResource((signal) => requestAvailableAgents(signal), []);
  const agents = agentsResource.data?.agents ?? [];
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Ask an agent"
        description="Department agents answer from their department's documents and show their sources. What they can't answer goes to the department."
      />
      {agentsResource.isLoading && !agentsResource.data && <LoadingBlock label="Loading agents…" />}
      {agentsResource.error && <Notice tone="error" title={agentsResource.error.message} />}
      {agentsResource.data && agents.length === 0 && (
        <EmptyState
          Icon={BookOpenIcon}
          title="No agents to ask yet"
          description="An agent appears here once its department has added documents for it."
        />
      )}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((entry) => (
          <li key={entry.agent.id}>
            <Link
              to={chatPathOf(entry.department.id)}
              aria-label={`Ask ${entry.agent.name}`}
              className="group flex h-full flex-col rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md hover:ring-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
            >
              <div className="flex items-start justify-between gap-3">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"
                  aria-hidden="true"
                >
                  <BookOpenIcon className="h-5 w-5" />
                </span>
                <Badge tone={entry.audience === 'COMPANY' ? 'sky' : 'slate'}>{AUDIENCE_DISPLAY[entry.audience]}</Badge>
              </div>
              <p className="mt-4 font-semibold text-slate-900">{entry.agent.name}</p>
              <p className="text-sm text-slate-500">{entry.department.name}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-600 group-hover:text-brand-500">
                Ask a question
                <ArrowRightIcon className="h-4 w-4" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
