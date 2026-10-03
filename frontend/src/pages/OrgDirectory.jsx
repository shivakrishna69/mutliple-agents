/**
 * Organisation directory (staff: admins and agents; GET /api/org/hierarchy and /api/org/manager/:id).
 *
 * Left: the reporting forest as a collapsible tree, searchable by name or title (matches keep their
 * ancestors visible so the reporting line stays readable). Right: the selected person's reporting
 * line from GET /api/org/manager/:id: direct and indirect reports and span-of-control figures.
 */

import { useMemo, useState } from 'react';
import { requestManagerReports, requestOrgHierarchy } from '../api/workforceApi.js';
import { SearchIcon, SitemapIcon, UsersIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, Card, EmptyState, LoadingBlock, Notice, StatTile, formatDateTime } from '../components/ui.jsx';
import { useApiResource } from '../hooks/useApiResource.js';

function initialsOf(fullName) {
  const nameParts = (fullName ?? '?').trim().split(/\s+/);
  return ((nameParts[0]?.[0] ?? '') + (nameParts.length > 1 ? nameParts.at(-1)[0] : '')).toUpperCase() || '?';
}

const AVATAR_GRADIENTS = ['from-indigo-500 to-violet-500', 'from-sky-500 to-cyan-500', 'from-emerald-500 to-teal-500', 'from-amber-500 to-orange-500', 'from-rose-500 to-pink-500'];

function Avatar({ person, size = 'h-9 w-9 text-xs' }) {
  const gradient = AVATAR_GRADIENTS[[...(person.id ?? '')].reduce((runningTotal, character) => runningTotal + character.charCodeAt(0), 0) % AVATAR_GRADIENTS.length];
  return <span className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white ${gradient} ${size}`}>{initialsOf(person.name)}</span>;
}

/** Keeps nodes that match the query or have a matching descendant. */
function filterForest(nodes, normalizedQuery) {
  if (!normalizedQuery) return nodes;
  return nodes.flatMap((node) => {
    const filteredChildren = filterForest(node.children ?? [], normalizedQuery);
    const isMatch = `${node.name ?? ''} ${node.designation ?? ''}`.toLowerCase().includes(normalizedQuery);
    return isMatch || filteredChildren.length > 0 ? [{ ...node, children: filteredChildren }] : [];
  });
}

function TreeNode({ node, depth, selectedId, onSelect, forceExpanded }) {
  const [isExpanded, setIsExpanded] = useState(depth < 2);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const showChildren = hasChildren && (isExpanded || forceExpanded);
  const isSelected = node.id === selectedId;
  return (
    <li>
      <div className={`group flex items-center gap-2 rounded-xl px-2 py-1.5 transition ${isSelected ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-slate-50'}`}>
        <button
          type="button"
          onClick={() => setIsExpanded((wasExpanded) => !wasExpanded)}
          disabled={!hasChildren}
          aria-label={hasChildren ? (showChildren ? `Collapse ${node.name}` : `Expand ${node.name}`) : undefined}
          className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-white hover:text-slate-700 disabled:invisible"
        >
          <span className={`transition-transform ${showChildren ? 'rotate-90' : ''}`}>▸</span>
        </button>
        <button type="button" onClick={() => onSelect(node)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Avatar person={node} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">{node.name ?? 'Unnamed'}</span>
            <span className="block truncate text-xs text-slate-500">{node.designation}</span>
          </span>
          {hasChildren && <Badge tone="slate" className="ml-auto">{node.children.length}</Badge>}
        </button>
      </div>
      {showChildren && (
        <ul className="ml-5 border-l border-slate-200 pl-3">
          {node.children.map((childNode) => (
            <TreeNode key={childNode.id} node={childNode} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} forceExpanded={forceExpanded} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ReportsPanel({ person }) {
  const { data, error, isLoading } = useApiResource((signal) => requestManagerReports(person.id, signal), [person.id]);
  if (isLoading && !data) return <LoadingBlock label="Loading reporting line…" />;
  if (error) return <Notice tone="error" title={error.message} />;
  if (!data) return null;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-violet-950 p-5 text-white">
        <Avatar person={data.manager} size="h-14 w-14 text-base" />
        <div>
          <p className="text-lg font-bold">{data.manager.name}</p>
          <p className="text-sm text-slate-300">{data.manager.designation}</p>
          {!data.manager.isCurrentEmployee && <Badge tone="amber" className="mt-2">Former employee: reports need reassignment</Badge>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Direct" value={data.meta.directReportCount} accent="indigo" />
        <StatTile label="Total" value={data.meta.totalReportCount} accent="emerald" />
        <StatTile label="Depth" value={data.meta.maxDepth} accent="amber" />
      </div>
      {[
        ['Direct reports', data.directReports],
        ['Indirect reports', data.indirectReports],
      ].map(([sectionTitle, reports]) =>
        reports.length > 0 ? (
          <div key={sectionTitle}>
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{sectionTitle}</p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {reports.map((report) => (
                <li key={report.id} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
                  <Avatar person={report} size="h-8 w-8 text-[0.65rem]" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{report.name}</p>
                    <p className="truncate text-xs text-slate-500">
                      {report.designation}
                      {report.level > 1 && ` · level ${report.level}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {data.meta.totalReportCount === 0 && <EmptyState Icon={UsersIcon} title="No reports" description="Nobody reports to this person." />}
    </div>
  );
}

export default function OrgDirectory() {
  const { data, error, isLoading } = useApiResource((signal) => requestOrgHierarchy(signal), []);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPerson, setSelectedPerson] = useState(null);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleRoots = useMemo(() => filterForest(data?.roots ?? [], normalizedQuery), [data, normalizedQuery]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title="Organisation" description="Reporting lines across the company." />
      {data && (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile label="Employees" value={data.meta.employeeCount} Icon={UsersIcon} accent="indigo" />
          <StatTile label="Levels" value={data.meta.maxDepth} hint={`${data.meta.rootCount} top-level leaders`} Icon={SitemapIcon} accent="emerald" />
          <StatTile label="Snapshot" value={formatDateTime(data.meta.generatedAt)} hint="Refreshed automatically" accent="sky" />
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-5">
        <Card
          title="Hierarchy"
          className="lg:col-span-2"
          bodyClassName="p-3"
          actions={
            <label className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={searchQuery}
                onChange={(changeEvent) => setSearchQuery(changeEvent.target.value)}
                placeholder="Search people"
                aria-label="Search people"
                className="w-48 rounded-xl border-0 bg-slate-50 py-2 pr-3 pl-9 text-sm ring-1 ring-slate-200 ring-inset focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              />
            </label>
          }
        >
          {isLoading && !data && <LoadingBlock label="Loading organisation…" />}
          {error && <Notice tone="error" title={error.message} />}
          {data && visibleRoots.length === 0 && <EmptyState Icon={SitemapIcon} title={normalizedQuery ? 'Nobody matches' : 'No employees yet'} />}
          <ul className="max-h-[36rem] space-y-0.5 overflow-y-auto scroll-thin">
            {visibleRoots.map((rootNode) => (
              <TreeNode key={rootNode.id} node={rootNode} depth={0} selectedId={selectedPerson?.id} onSelect={setSelectedPerson} forceExpanded={Boolean(normalizedQuery)} />
            ))}
          </ul>
        </Card>
        <Card title="Reporting line" className="lg:col-span-3">
          {selectedPerson ? <ReportsPanel person={selectedPerson} /> : <EmptyState Icon={UsersIcon} title="Select a person" description="Choose anyone in the hierarchy to see who reports to them." />}
        </Card>
      </div>
    </div>
  );
}
