/**
 * The My Access launcher (MyAccess.jsx, components/appNavigation.js): one tile per page the person may
 * open, following the same capabilities, portal view and membership rules as the sidebar; the newest
 * unread notification as a dismissible announcement; and nothing announced when all are read; the
 * pending-count badges from the daily briefing's queues (no requests of their own); the briefing bar;
 * and the module search.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launcherTilesFor } from '../components/appNavigation.js';
import { InsightsProvider } from '../components/insights/InsightsContext.jsx';
import MyAccess from './MyAccess.jsx';

vi.mock('../auth/AuthContext.jsx', () => {
  const session = { currentUser: { id: 'me' }, markSessionEnded: () => {} };
  return { useAuth: () => session };
});

const WORKSPACE = ['use_employee_workspace', 'view_own_form16', 'ask_department_agents', 'use_nsk_assistant'];
const ADMIN = [
  ...WORKSPACE,
  'staff_support',
  'manage_workforce',
  'view_final_settlement',
  'manage_knowledge_bases',
  'manage_company_settings',
  'manage_users',
  'view_agent_telemetry',
  'manage_form16',
  'use_task_boards',
];
const visibilityOf = (capabilities, { view = null, context = {} } = {}) => ({
  user: { capabilities },
  view,
  context: { hasTaskBoard: false, managesOwnKnowledgeBase: false, ...context },
});
const labelsFor = (visibility) => launcherTilesFor(visibility).map((tile) => tile.label);

/** The shared briefing state as the app shell provides it, with this briefing loaded. */
const insightsWith = (briefing) => ({
  briefing,
  isLoading: false,
  error: null,
  decisions: {},
  openPanel: vi.fn(),
  approve: vi.fn(),
  undo: vi.fn(),
});

function renderLauncher({ visibility, notificationState }, insights = null) {
  return render(
    <InsightsProvider value={insights}>
      <MemoryRouter initialEntries={['/my-access']}>
        <Routes>
          <Route element={<Outlet context={{ visibility, notificationState }} />}>
            <Route path="/my-access" element={<MyAccess />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </InsightsProvider>,
  );
}

describe('launcher tiles', () => {
  it('gives an employee their own workspace only', () => {
    expect(labelsFor(visibilityOf(WORKSPACE))).toEqual([
      'Ask NSK',
      'Overview',
      'Ask an Agent',
      'Attendance',
      'Leave',
      'Payroll & Form 16',
      'Analytics Hub',
    ]);
  });

  it('gives an administrator the management tools in the management view, and not in self-service', () => {
    const management = labelsFor(visibilityOf(ADMIN, { view: 'management', context: { hasTaskBoard: true } }));
    expect(management).toEqual([
      'Ask NSK',
      'Overview',
      'Support Console',
      'Department Board',
      'Ask an Agent',
      'Attendance',
      'Leave',
      'Payroll & Form 16',
      'Analytics Hub',
      'Organisation',
      'Onboarding',
      'Workplace',
      'Offboarding',
      'Departments & Agents',
      'Company Settings',
      'Users & Roles',
      'Agent Telemetry',
      'Form 16 / CA Portal',
    ]);
    const selfService = labelsFor(visibilityOf(ADMIN, { view: 'self-service', context: { hasTaskBoard: true } }));
    expect(selfService).not.toContain('Users & Roles');
    expect(selfService).toContain('Payroll & Form 16');
  });

  it('never offers My Access itself or Account as a tile', () => {
    const paths = launcherTilesFor(visibilityOf(ADMIN, { view: 'management' })).map((tile) => tile.path);
    expect(paths).not.toContain('/my-access');
    expect(paths).not.toContain('/account');
  });
});

describe('My Access page', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows the heading and one link per tile', () => {
    renderLauncher({ visibility: visibilityOf(WORKSPACE), notificationState: { notifications: [] } });
    expect(screen.getByRole('heading', { level: 1, name: 'My Access' })).toBeTruthy();
    const tiles = screen.getAllByTestId('my-access-tile');
    expect(tiles).toHaveLength(7);
    expect(within(tiles[3]).getByText('Attendance').closest('a').getAttribute('href')).toBe('/attendance');
    expect(screen.queryByTestId('my-access-announcement')).toBeNull();
  });

  it('announces the newest unread notification, opens it, and can be dismissed for good', () => {
    const markRead = vi.fn();
    const notificationState = {
      notifications: [
        { id: 'n2', title: 'Leave approved', body: 'Your leave for 24 Nov is approved', link: '/leave', readAt: null },
        { id: 'n1', title: 'Older', body: 'Already seen', link: null, readAt: '2026-11-20T10:00:00Z' },
      ],
      markRead,
    };
    const { unmount } = renderLauncher({ visibility: visibilityOf(WORKSPACE), notificationState });
    const pill = screen.getByTestId('my-access-announcement');
    expect(within(pill).getByText('Leave approved')).toBeTruthy();
    fireEvent.click(within(pill).getByText('Leave approved'));
    expect(markRead).toHaveBeenCalledWith('n2');
    unmount();

    renderLauncher({ visibility: visibilityOf(WORKSPACE), notificationState });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss announcement' }));
    expect(screen.queryByTestId('my-access-announcement')).toBeNull();
    // Dismissed for this browser: not back on the next visit.
    renderLauncher({ visibility: visibilityOf(WORKSPACE), notificationState });
    expect(screen.queryByTestId('my-access-announcement')).toBeNull();
  });

  it('shows the briefing queues as counts on the visible tiles, with the briefing bar above them', () => {
    const insights = insightsWith({
      headline: '2 leave requests to approve',
      counts: { total: 2, urgent: 0, high: 2, byKind: {} },
      queues: { LEAVE_DECISIONS: 3, ATTENDANCE_CORRECTIONS: 120, SUPPORT_WAITING: 4 },
      cards: [],
    });
    renderLauncher({ visibility: visibilityOf(WORKSPACE), notificationState: { notifications: [] } }, insights);
    const leave = screen.getByText('Leave').closest('a');
    expect(within(leave).getByTestId('my-access-badge').textContent).toBe('3');
    expect(within(leave).getByText(', 3 pending')).toBeTruthy();
    expect(within(screen.getByText('Attendance').closest('a')).getByTestId('my-access-badge').textContent).toBe('99+');
    // Support Console is not one of this person's tiles, so its queue shows nowhere.
    expect(screen.getAllByTestId('my-access-badge')).toHaveLength(2);
    expect(screen.getByTestId('briefing-headline').textContent).toBe('2 leave requests to approve');
  });

  it('shows no badge and no bar without a briefing', async () => {
    renderLauncher({ visibility: visibilityOf(WORKSPACE), notificationState: { notifications: [] } });
    await screen.findByRole('heading', { name: 'My Access' });
    expect(screen.queryByTestId('my-access-badge')).toBeNull();
    expect(screen.queryByTestId('briefing-bar')).toBeNull();
  });

  it('filters the tiles as the person types, clears, and says when nothing matches', () => {
    renderLauncher({ visibility: visibilityOf(WORKSPACE), notificationState: { notifications: [] } });
    const search = screen.getByLabelText('Search modules');
    fireEvent.change(search, { target: { value: 'PAYSLIP' } });
    expect(screen.getAllByTestId('my-access-tile').map((tile) => tile.textContent)).toEqual(['Payroll & Form 16']);

    fireEvent.change(search, { target: { value: 'zebra' } });
    expect(screen.queryAllByTestId('my-access-tile')).toHaveLength(0);
    expect(screen.getByTestId('my-access-no-match').textContent).toContain('zebra');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getAllByTestId('my-access-tile')).toHaveLength(7);
    expect(search.value).toBe('');
  });
});
