/**
 * The task boards this person can open (/boards; GET /api/task-boards): their department's, the ones
 * they head, or every department's for an administrator. With exactly one, it opens straight away.
 */

import { Link, Navigate } from 'react-router';
import { requestMyBoards } from '../api/tasksApi.js';
import { ArrowRightIcon, DocumentIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, EmptyState, LoadingBlock, Notice } from '../components/ui.jsx';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useApiResource } from '../hooks/useApiResource.js';

const boardPathOf = (departmentId) => ROUTE_PATHS.BOARD.replace(':departmentId', encodeURIComponent(departmentId));

export default function TaskBoards() {
  const boardsResource = useApiResource((signal) => requestMyBoards(signal), []);
  const boards = boardsResource.data?.boards ?? [];
  if (boards.length === 1) return <Navigate to={boardPathOf(boards[0].department.id)} replace />;
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title="Department boards" description="Sprints and tasks, one board per department." />
      {boardsResource.isLoading && !boardsResource.data && <LoadingBlock label="Loading boards…" />}
      {boardsResource.error && <Notice tone="error" title={boardsResource.error.message} />}
      {boardsResource.data && boards.length === 0 && (
        <EmptyState
          Icon={DocumentIcon}
          title="No board to open"
          description="Your department's board appears here once your employee record is in a department."
        />
      )}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {boards.map((entry) => (
          <li key={entry.department.id}>
            <Link
              to={boardPathOf(entry.department.id)}
              aria-label={`Open the ${entry.department.name} board`}
              className="flex h-full flex-col rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md hover:ring-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-slate-500">{entry.department.code}</span>
                {entry.role === 'LEAD' && <Badge tone="violet">Task lead</Badge>}
              </div>
              <p className="mt-3 font-semibold text-slate-900">{entry.department.name}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">
                Open the board
                <ArrowRightIcon className="h-4 w-4" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
