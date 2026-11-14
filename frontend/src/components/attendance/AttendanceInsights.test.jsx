/**
 * Attendance charts (AttendanceInsights.jsx) over mocked answers of GET /api/attendance/today and
 * /analytics: what each chart states in words and numbers (the parts readable without colour), the
 * compact variant, and nothing at all for someone the backend refuses.
 */

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/httpClient.js';
import { requestAttendanceAnalytics, requestTodayBoard } from '../../api/workforceApi.js';
import AttendanceInsights from './AttendanceInsights.jsx';

vi.mock('../../api/workforceApi.js', () => ({ requestAttendanceAnalytics: vi.fn(), requestTodayBoard: vi.fn() }));
vi.mock('../../auth/AuthContext.jsx', () => {
  const session = { markSessionEnded: () => {} };
  return { useAuth: () => session };
});

const day = (date, status) => ({ date, status });
const ANALYTICS = {
  scope: 'organisation',
  month: '2026-11',
  today: '2026-11-14',
  people: [
    {
      employeeId: 'e1',
      name: 'Asha Rao',
      department: { id: 'd1', name: 'Engineering' },
      expectedDays: 4,
      presentDays: 3,
      lateDays: 1,
      completion: 0.75,
      days: [
        day('2026-11-01', 'on_time'),
        day('2026-11-02', 'late'),
        day('2026-11-03', 'absent'),
        day('2026-11-04', 'leave'),
      ],
    },
  ],
  departments: [
    {
      department: { id: 'd1', name: 'Engineering' },
      headcount: 5,
      expectedDays: 80,
      presentDays: 72,
      lateDays: 6,
      completion: 0.9,
    },
    {
      department: { id: 'd2', name: 'Finance' },
      headcount: 3,
      expectedDays: 48,
      presentDays: 36,
      lateDays: 2,
      completion: 0.75,
    },
  ],
  arrivals: {
    slotMinutes: 30,
    dates: ['2026-11-13', '2026-11-14'],
    slots: [
      { start: '09:00', counts: [3, 4], total: 7 },
      { start: '09:30', counts: [2, 1], total: 3 },
    ],
    medians: [
      { date: '2026-11-13', count: 5, median: '09:12' },
      { date: '2026-11-14', count: 5, median: '09:05' },
    ],
  },
};
const TODAY = { counts: { in: 6, out: 2, late: 3, on_leave: 1, not_in: 2, holiday: 0, weekly_off: 0, no_office: 0 } };

describe('attendance insights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestAttendanceAnalytics.mockResolvedValue(ANALYTICS);
    requestTodayBoard.mockResolvedValue(TODAY);
  });

  it("states today's mix, the departments, the arrival peak and each person's month", async () => {
    render(<AttendanceInsights />);
    const todayList = await screen.findByRole('list', { name: 'Attendance today' });
    const rowText = within(todayList)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(rowText).toEqual(['On time545%', 'Late327%', 'On leave19%', 'Not in yet218%']);
    expect(screen.getByText('11')).toBeTruthy();

    const departmentRows = screen.getAllByRole('row').map((row) => row.textContent);
    expect(departmentRows).toContain('Engineering90%72 / 8065');
    expect(screen.getByText(/Busiest:/).textContent).toContain('09:00 (7 arrivals in 30 minutes');
    expect(within(screen.getByRole('list', { name: 'Median arrival by day' })).getByText('09:05')).toBeTruthy();

    const month = screen.getByRole('list', { name: 'Asha Rao, day by day' });
    expect(
      within(month)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['1 Nov: On time', '2 Nov: Late', '3 Nov: Absent', '4 Nov: On leave']);
    expect(screen.getByText('3 of 4 days · 1 late')).toBeTruthy();
    expect(requestAttendanceAnalytics).toHaveBeenCalledWith(
      { month: expect.stringMatching(/^\d{4}-\d{2}$/) },
      expect.anything(),
    );
  });

  it('uses the Today board the page already has, and the compact view shows departments and arrivals only', async () => {
    const { unmount } = render(<AttendanceInsights todayBoard={TODAY} />);
    await screen.findByRole('list', { name: 'Attendance today' });
    expect(requestTodayBoard).not.toHaveBeenCalled();
    unmount();

    render(<AttendanceInsights variant="compact" />);
    await screen.findByRole('heading', { name: 'Check-in completion by department' });
    expect(screen.queryByRole('list', { name: 'Attendance today' })).toBeNull();
    expect(screen.queryByText('Each person this month')).toBeNull();
    expect(screen.getByText('Arrival times')).toBeTruthy();
  });

  it('shows nothing to someone the backend refuses', async () => {
    requestAttendanceAnalytics.mockImplementation(async () => {
      throw new ApiError({
        message: 'Only HR, administrators and people with a team can see attendance analytics',
        status: 403,
      });
    });
    const { container } = render(<AttendanceInsights variant="compact" />);
    await vi.waitFor(() => expect(requestAttendanceAnalytics).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.textContent).toBe(''));
  });
});
