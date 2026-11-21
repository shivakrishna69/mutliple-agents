/**
 * The My Access launcher (MyAccess.jsx, components/appNavigation.js): one tile per page the person may
 * open, following the same capabilities, portal view and membership rules as the sidebar; the newest
 * unread notification as a dismissible announcement; and nothing announced when all are read.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launcherTilesFor } from '../components/appNavigation.js';
import MyAccess from './MyAccess.jsx';

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

function renderLauncher({ visibility, notificationState }) {
  return render(
    <MemoryRouter initialEntries={['/my-access']}>
      <Routes>
        <Route element={<Outlet context={{ visibility, notificationState }} />}>
          <Route path="/my-access" element={<MyAccess />} />
        </Route>
      </Routes>
    </MemoryRouter>,
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
  beforeEach(() => window.localStorage.clear());

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
});
