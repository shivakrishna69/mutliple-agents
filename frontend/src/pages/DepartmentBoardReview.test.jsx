/**
 * Dates, the task a task follows, and reviews on a department board (DepartmentBoard.jsx,
 * components/tasks/TaskDialogs.jsx, TaskCard.jsx): Overdue and Due today chips against the board's
 * company date, a lead approving or sending back a task in review (a note is required), the assignee
 * seeing the lead's note as a Revision requested banner, "Follows task" offering only tasks that make
 * no loop, the activity reading the review and the dates, and a new task sent with its dates.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestBoard,
  requestSprints,
  requestTask,
  requestTaskCreation,
  requestTaskReview,
  requestTasks,
} from '../api/tasksApi.js';
import DepartmentBoard from './DepartmentBoard.jsx';

vi.mock('../api/tasksApi.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requestBoard: vi.fn(),
  requestSprints: vi.fn(),
  requestTasks: vi.fn(),
  requestTask: vi.fn(),
  requestTaskReview: vi.fn(),
  requestTaskCreation: vi.fn(),
}));
vi.mock('../auth/AuthContext.jsx', () => {
  const session = { currentUser: { id: 'asha' }, csrfToken: 'csrf-token', markSessionEnded: () => {} };
  return { useAuth: () => session };
});

const TODAY = '2026-11-26';
const LALIT = { id: 'lalit', name: 'Lalit Lead', email: 'lalit@example.com' };
const ASHA = { id: 'asha', name: 'Asha Rao', email: 'asha@example.com' };
const SPRINT = {
  id: 'sprint-1',
  name: 'Sprint 1',
  goal: '',
  startDate: '2026-11-23',
  endDate: '2026-12-04',
  status: 'ACTIVE',
  version: 1,
};
const MEMBER = { role: 'MEMBER', canPlanSprints: false, canMoveAnyTask: false, canSeeTeamWork: false };
const LEAD = { role: 'LEAD', canPlanSprints: true, canMoveAnyTask: true, canSeeTeamWork: true };

const task = (fields) => ({
  key: `ENG-${fields.id}`,
  taskType: 'TASK',
  priority: 'MEDIUM',
  status: 'TODO',
  sprintId: SPRINT.id,
  assignee: ASHA,
  reporter: LALIT,
  storyPoints: null,
  orderIndex: 1024,
  startDate: null,
  dueDate: null,
  dependsOnTaskId: null,
  review: null,
  version: 3,
  description: '',
  createdAt: '2026-11-20T09:00:00.000Z',
  ...fields,
});
const SUBMITTED = {
  state: 'SUBMITTED',
  submittedBy: ASHA,
  submittedAt: '2026-11-25T10:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  note: null,
};
const SENT_BACK = {
  ...SUBMITTED,
  state: 'CHANGES_REQUESTED',
  decidedBy: LALIT,
  decidedAt: '2026-11-26T08:00:00.000Z',
  note: 'Add the totals row to the export',
};
const TASKS = [
  task({ id: '1', title: 'Late export', status: 'IN_PROGRESS', dueDate: '2026-11-24' }),
  task({ id: '2', title: 'Ship the report today', dueDate: TODAY }),
  task({ id: '3', title: 'Later work', dueDate: '2026-12-01' }),
  task({ id: '4', title: 'Finished late', status: 'DONE', dueDate: '2026-11-20' }),
  task({ id: '5', title: 'Design review', status: 'IN_REVIEW', review: SUBMITTED, dependsOnTaskId: null }),
  task({ id: '6', title: 'Build after design', dependsOnTaskId: '5' }),
  task({ id: '7', title: 'Fix the totals', status: 'IN_PROGRESS', review: SENT_BACK }),
];
const byId = (id) => TASKS.find((entry) => entry.id === id);

function renderBoard(viewer, query = '') {
  requestBoard.mockResolvedValue({
    board: {
      department: { id: 'dept-1', name: 'Engineering', code: 'ENG' },
      viewer: { isHead: false, canChooseLeads: false, ...viewer },
      head: LALIT,
      leads: [LALIT],
      members: [ASHA, LALIT],
      activeSprint: SPRINT,
      today: TODAY,
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

const detail = (taskFields, extra = {}) => ({
  task: taskFields,
  dependsOn: null,
  followedBy: [],
  activity: [],
  ...extra,
});
const card = (title) => screen.findByRole('listitem', { name: new RegExp(title) });

describe('due dates on the board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestSprints.mockResolvedValue({ sprints: [SPRINT] });
    requestTasks.mockResolvedValue({ tasks: TASKS });
  });

  it('marks open tasks Overdue or Due today against the company date, and tasks sent back', async () => {
    renderBoard(MEMBER);
    expect(within(await card('Late export')).getByText('Overdue')).toBeTruthy();
    expect(within(await card('Ship the report today')).getByText('Due today')).toBeTruthy();
    const later = await card('Later work');
    expect(within(later).queryByText('Overdue')).toBeNull();
    expect(within(later).queryByText('Due today')).toBeNull();
    expect(within(await card('Finished late')).queryByText('Overdue')).toBeNull();
    expect(within(await card('Fix the totals')).getByText('Changes requested')).toBeTruthy();
  });
});

describe('reviews in the task dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestSprints.mockResolvedValue({ sprints: [SPRINT] });
    requestTasks.mockResolvedValue({ tasks: TASKS });
  });

  it('lets a lead approve a task in review', async () => {
    requestTask.mockResolvedValue(
      detail(byId('5'), { followedBy: [{ id: '6', key: 'ENG-6', title: 'Build after design', status: 'TODO' }] }),
    );
    requestTaskReview.mockResolvedValue({
      task: { ...byId('5'), status: 'DONE', review: { ...SUBMITTED, state: 'APPROVED', decidedBy: LALIT } },
      notice: 'Task approved and marked done',
    });
    renderBoard(LEAD, '?task=5');
    const review = await screen.findByRole('region', { name: 'Review' });
    expect(within(review).getByText(/Asha Rao submitted this task for review/)).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('Followed by')).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(requestTaskReview).toHaveBeenCalledWith(
        'dept-1',
        '5',
        { decision: 'APPROVE', note: null, version: 3 },
        'csrf-token',
      ),
    );
    expect(await screen.findByText('Task approved and marked done')).toBeTruthy();
  });

  it('needs a note before a lead sends a task back for changes', async () => {
    requestTask.mockResolvedValue(detail(byId('5')));
    requestTaskReview.mockResolvedValue({ task: { ...byId('5'), status: 'IN_PROGRESS', review: SENT_BACK } });
    renderBoard(LEAD, '?task=5');
    const review = await screen.findByRole('region', { name: 'Review' });
    fireEvent.click(within(review).getByRole('button', { name: 'Request changes' }));
    const send = within(review).getByRole('button', { name: 'Send back for changes' });
    expect(send.disabled).toBe(true);
    fireEvent.change(within(review).getByLabelText(/What needs to change/), {
      target: { value: '  Add the totals row to the export  ' },
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(requestTaskReview).toHaveBeenCalledWith(
        'dept-1',
        '5',
        { decision: 'REQUEST_CHANGES', note: 'Add the totals row to the export', version: 3 },
        'csrf-token',
      ),
    );
  });

  it('shows no review actions to a member, and the lead note on a task sent back', async () => {
    requestTask.mockResolvedValue(
      detail(byId('7'), {
        activity: [
          {
            id: 'a1',
            type: 'UPDATED',
            actor: LALIT,
            changes: [
              { field: 'status', from: 'IN_REVIEW', to: 'IN_PROGRESS' },
              { field: 'review', from: 'SUBMITTED', to: 'CHANGES_REQUESTED' },
            ],
            body: 'Add the totals row to the export',
            createdAt: '2026-11-26T08:00:00.000Z',
          },
          {
            id: 'a0',
            type: 'UPDATED',
            actor: ASHA,
            changes: [
              { field: 'dueDate', from: null, to: '2026-11-28' },
              { field: 'review', from: null, to: 'SUBMITTED' },
            ],
            body: null,
            createdAt: '2026-11-25T10:00:00.000Z',
          },
        ],
      }),
    );
    renderBoard(MEMBER, '?task=7');
    const banner = await screen.findByText('Revision requested by Lalit Lead');
    expect(banner.closest('[role="status"]').textContent).toContain('Add the totals row to the export');
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
    const activity = screen.getByRole('list', { name: 'Activity' });
    expect(
      within(activity).getByText(/changed the status from In review to In progress, requested changes/),
    ).toBeTruthy();
    expect(
      within(activity).getByText(/changed the due date from none to 28 Nov 2026, submitted it for review/),
    ).toBeTruthy();
  });

  it('offers only tasks that make no loop to follow, and sends a change of dates', async () => {
    requestTask.mockResolvedValue(detail(byId('5')));
    renderBoard(LEAD, '?task=5');
    const dialog = await screen.findByRole('dialog');
    const follows = await within(dialog).findByLabelText(/Follows task/);
    const offered = within(follows)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(offered[0]).toBe('None');
    expect(offered).not.toContain('ENG-5 · Design review');
    expect(offered).not.toContain('ENG-6 · Build after design');
    expect(offered).toContain('ENG-1 · Late export');
  });

  it('creates a task with its dates and the task it follows', async () => {
    requestTaskCreation.mockResolvedValue({ task: task({ id: '8', title: 'New work' }), notice: 'Task created' });
    renderBoard(MEMBER);
    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a task' });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'New work' } });
    fireEvent.change(within(dialog).getByLabelText(/Start date/), { target: { value: '2026-11-27' } });
    fireEvent.change(within(dialog).getByLabelText(/Due date/), { target: { value: '2026-11-30' } });
    expect(
      within(dialog)
        .getByLabelText(/Due date/)
        .getAttribute('min'),
    ).toBe('2026-11-27');
    fireEvent.change(within(dialog).getByLabelText(/Follows task/), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(requestTaskCreation).toHaveBeenCalled());
    expect(requestTaskCreation.mock.calls[0][1]).toMatchObject({
      title: 'New work',
      startDate: '2026-11-27',
      dueDate: '2026-11-30',
      dependsOnTaskId: '5',
    });
  });
});
