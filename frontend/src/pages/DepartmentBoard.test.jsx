/**
 * Who sees what on a department board (DepartmentBoard.jsx), from the rights the backend sends: the
 * Team overview tab only for leads (a member asking for it by address gets the sprint view and no
 * request is made), the Task leads button only for the head or an administrator; and what the
 * overview shows: each person's workload, the sprint's pace and burndown, the unassigned backlog.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestBoard, requestSprints, requestTasks, requestTeamWork } from '../api/tasksApi.js';
import DepartmentBoard from './DepartmentBoard.jsx';

vi.mock('../api/tasksApi.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requestBoard: vi.fn(),
  requestSprints: vi.fn(),
  requestTasks: vi.fn(),
  requestTeamWork: vi.fn(),
}));
// One session object, as the real provider gives: the data hooks depend on its functions.
vi.mock('../auth/AuthContext.jsx', () => {
  const session = { currentUser: { id: 'asha' }, csrfToken: 'csrf-token', markSessionEnded: () => {} };
  return { useAuth: () => session };
});

const HEAD = { id: 'head', name: 'Hema Head', email: 'hema@example.com' };
const ASHA = { id: 'asha', name: 'Asha Rao', email: 'asha@example.com' };
const SPRINT = {
  id: 'sprint-1',
  name: 'Sprint 1',
  goal: 'Ship the export',
  startDate: '2026-11-09',
  endDate: '2026-11-13',
  status: 'ACTIVE',
  version: 1,
};
const VIEWERS = Object.freeze({
  member: {
    role: 'MEMBER',
    canPlanSprints: false,
    canMoveAnyTask: false,
    canSeeTeamWork: false,
    canChooseLeads: false,
  },
  lead: { role: 'LEAD', canPlanSprints: true, canMoveAnyTask: true, canSeeTeamWork: true, canChooseLeads: false },
  head: { role: 'LEAD', canPlanSprints: true, canMoveAnyTask: true, canSeeTeamWork: true, canChooseLeads: true },
});
const counts = (TODO, IN_PROGRESS, IN_REVIEW, DONE) => ({ TODO, IN_PROGRESS, IN_REVIEW, DONE });
const TEAM_WORK = {
  members: [{ person: ASHA, tasksByStatus: counts(2, 1, 0, 3), points: 13, pointsDone: 8 }],
  unassigned: { tasksByStatus: counts(1, 0, 0, 0), points: 0, pointsDone: 0 },
  totals: { tasksByStatus: counts(3, 1, 0, 3), points: 13, pointsDone: 8 },
  sprint: {
    ...SPRINT,
    burndown: {
      today: '2026-11-11',
      totalPoints: 10,
      days: [
        { date: '2026-11-09', remainingPoints: 10 },
        { date: '2026-11-10', remainingPoints: 10 },
        { date: '2026-11-11', remainingPoints: 9 },
      ],
    },
  },
  unassignedBacklog: {
    total: 3,
    tasks: [{ id: 'task-9', key: 'ENG-9', title: 'Fix the export', taskType: 'BUG', priority: 'URGENT' }],
  },
};

function renderBoard(viewer, query = '') {
  requestBoard.mockResolvedValue({
    board: {
      department: { id: 'dept-1', name: 'Engineering', code: 'ENG' },
      viewer: { isHead: viewer === VIEWERS.head, ...viewer },
      head: HEAD,
      leads: [],
      members: [ASHA, HEAD],
      activeSprint: SPRINT,
      version: 0,
    },
  });
  render(
    <MemoryRouter initialEntries={[`/boards/dept-1${query}`]}>
      <Routes>
        <Route path="/boards/:departmentId" element={<DepartmentBoard />} />
      </Routes>
    </MemoryRouter>,
  );
}

const boardHeading = () => screen.findByRole('heading', { level: 1, name: 'Engineering board' });

describe('department board rights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestSprints.mockResolvedValue({ sprints: [SPRINT] });
    requestTasks.mockResolvedValue({ tasks: [] });
    requestTeamWork.mockResolvedValue(TEAM_WORK);
  });

  it('shows a member neither the team overview nor the task leads, even when asked by address', async () => {
    renderBoard(VIEWERS.member, '?view=team');
    await boardHeading();
    expect(screen.queryByRole('tab', { name: 'Team overview' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Active sprint' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Task leads' })).toBeNull();
    expect(requestTeamWork).not.toHaveBeenCalled();
  });

  it("shows a task lead the team's work, but not the choice of leads", async () => {
    renderBoard(VIEWERS.lead);
    await boardHeading();
    expect(screen.queryByRole('button', { name: 'Task leads' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Team overview' }));

    const ashaRow = await screen.findByRole('row', { name: /Asha Rao/ });
    expect(
      within(ashaRow)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['2', '1', '0', '3', '8 / 13']);
    expect(requestTeamWork).toHaveBeenCalledWith('dept-1', 'sprint-1', expect.anything());
    expect(screen.getByText('Behind')).toBeTruthy();
    expect(screen.getByText('1 of 10')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Burndown of Sprint 1: 9 of 10 points still open/ })).toBeTruthy();
    expect(screen.getByText('3 backlog tasks have no owner')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Unassigned backlog tasks' })).getByText('Fix the export'),
    ).toBeTruthy();
    expect(screen.getByText('and 2 more in the backlog')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
  });

  it('lets the head choose the task leads', async () => {
    renderBoard(VIEWERS.head);
    await boardHeading();
    expect(screen.getByRole('tab', { name: 'Team overview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Task leads' }));
    const dialog = screen.getByRole('dialog', { name: 'Task leads' });
    expect(within(dialog).getByRole('checkbox', { name: /Asha Rao/ })).toBeTruthy();
  });
});
