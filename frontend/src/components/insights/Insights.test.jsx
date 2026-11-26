/**
 * The daily briefing in the app (components/insights/): the ✦ pill (hidden at 0, rose when urgent),
 * the briefing bar (headline, the top card's action, Open briefing), the slide-over panel grouped by
 * priority, Approve with Undo before anything is sent, Decline with a required reason, the board and
 * Ask NSK links, and the briefing loading again after a decision.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestDailyBriefing } from '../../api/insightsApi.js';
import { requestLeaveApproval, requestLeaveRejection } from '../../api/leaveApi.js';
import BriefingBar from './BriefingBar.jsx';
import { InsightsProvider, useInsightsState } from './InsightsContext.jsx';
import InsightsPanel from './InsightsPanel.jsx';
import InsightsPill from './InsightsPill.jsx';

vi.mock('../../api/insightsApi.js', () => ({ requestDailyBriefing: vi.fn() }));
vi.mock('../../api/leaveApi.js', () => ({ requestLeaveApproval: vi.fn(), requestLeaveRejection: vi.fn() }));
vi.mock('../../auth/AuthContext.jsx', () => {
  const session = { currentUser: { id: 'me' }, csrfToken: 'csrf', markSessionEnded: () => {} };
  return { useAuth: () => session };
});
// A short undo window and reload delay, so the tests run in real time.
vi.mock('../../constants/insights.js', async (importOriginal) => ({
  ...(await importOriginal()),
  APPROVE_UNDO_MS: 300,
  INSIGHTS_RELOAD_DEBOUNCE_MS: 10,
}));

const LEAVE_CARD = {
  id: 'LEAVE_APPROVAL:r1',
  kind: 'LEAVE_APPROVAL',
  severity: 'urgent',
  label: 'Leave approval',
  title: 'Leave request: Shiva Krishna',
  body: '25 Dec – 30 Dec (4 days) · Planned Leave',
  facts: ['Balance: 9 days left · 3 taken this year', 'Team overlap: Naren: 26 Dec – 27 Dec', 'Waiting 50 hours'],
  actions: [
    { kind: 'APPROVE_LEAVE', label: 'Approve', requestId: 'r1', step: 'MANAGER' },
    { kind: 'DECLINE_LEAVE', label: 'Decline', requestId: 'r1', step: 'MANAGER' },
    {
      kind: 'ASK_NSK',
      label: 'Ask NSK',
      prompt: "Should I approve Shiva Krishna's Planned Leave for 25 Dec – 30 Dec?",
    },
  ],
  at: '2026-11-24T10:00:00.000Z',
};
const REVIEW_CARD = {
  id: 'TASK_REVIEW:t1',
  kind: 'TASK_REVIEW',
  severity: 'high',
  label: 'Review',
  title: 'Asha Rao submitted "Design the export"',
  body: 'Moved on to: Build the export',
  facts: ['ENG-4', 'Board: Engineering'],
  actions: [{ kind: 'REVIEW_TASK', label: 'Review task', path: '/boards/dept-1?task=t1' }],
  at: '2026-11-25T10:00:00.000Z',
};
const OVERDUE_CARD = {
  id: 'TASK_OVERDUE:t2',
  kind: 'TASK_OVERDUE',
  severity: 'high',
  label: 'Overdue',
  title: 'ENG-7 · Fix the totals',
  body: '',
  facts: ['Due 24 Nov', 'Board: Engineering'],
  actions: [{ kind: 'OPEN_TASK', label: 'View in Department Board', path: '/boards/dept-1?task=t2' }],
  at: '2026-11-24',
};
const briefingOf = (cards, headline = '1 overdue · 1 leave request to approve · 1 task to review') => ({
  generatedAt: '2026-11-26T09:00:00.000Z',
  today: '2026-11-26',
  headline,
  counts: {
    total: cards.length,
    urgent: cards.filter((card) => card.severity === 'urgent').length,
    high: cards.filter((card) => card.severity === 'high').length,
    byKind: {},
  },
  queues: {},
  cards,
});
const ALL_CLEAR = briefingOf([], 'Nothing needs you right now');

function Harness() {
  const insights = useInsightsState();
  return (
    <InsightsProvider value={insights}>
      <InsightsPill />
      <BriefingBar />
      <InsightsPanel />
    </InsightsProvider>
  );
}
const renderBriefing = () =>
  render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );

describe('the briefing pill and bar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hides the pill and the buttons when nothing waits', async () => {
    requestDailyBriefing.mockResolvedValue(ALL_CLEAR);
    renderBriefing();
    expect(await screen.findByText('Nothing needs you right now')).toBeTruthy();
    expect(screen.queryByTestId('insights-pill')).toBeNull();
    expect(screen.queryByTestId('briefing-open')).toBeNull();
  });

  it('counts the cards on the pill, rose when urgent, and shows the top card with its action', async () => {
    requestDailyBriefing.mockResolvedValue(briefingOf([LEAVE_CARD, REVIEW_CARD, OVERDUE_CARD]));
    renderBriefing();
    const pill = await screen.findByTestId('insights-pill');
    expect(pill.getAttribute('aria-label')).toBe('Briefing: 3 items, 1 urgent');
    expect(pill.dataset.urgent).toBe('true');
    const bar = screen.getByTestId('briefing-bar');
    expect(within(bar).getByText('1 urgent')).toBeTruthy();
    expect(within(bar).getByText('Leave request: Shiva Krishna')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Approve' })).toBeTruthy();

    fireEvent.click(pill);
    expect(await screen.findByRole('dialog', { name: /Today’s briefing/ })).toBeTruthy();
  });

  it('is not rose without urgent cards', async () => {
    requestDailyBriefing.mockResolvedValue(briefingOf([REVIEW_CARD]));
    renderBriefing();
    const pill = await screen.findByTestId('insights-pill');
    expect(pill.dataset.urgent).toBeUndefined();
    expect(pill.getAttribute('aria-label')).toBe('Briefing: 1 item');
  });
});

describe('the briefing panel', () => {
  beforeEach(() => vi.clearAllMocks());

  async function openPanel() {
    renderBriefing();
    fireEvent.click(await screen.findByTestId('briefing-open'));
    return screen.findByRole('dialog', { name: /Today’s briefing/ });
  }

  it('groups the cards by priority with their facts and links, and closes on Escape', async () => {
    requestDailyBriefing.mockResolvedValue(briefingOf([LEAVE_CARD, REVIEW_CARD, OVERDUE_CARD]));
    const panel = await openPanel();
    const urgent = within(panel).getByRole('region', { name: 'Urgent' });
    expect(within(urgent).getByText('Balance: 9 days left · 3 taken this year')).toBeTruthy();
    expect(within(urgent).getByText('Team overlap: Naren: 26 Dec – 27 Dec')).toBeTruthy();
    const askNsk = within(urgent).getByRole('link', { name: 'Ask NSK' });
    expect(new URL(askNsk.href).searchParams.get('q')).toBe(LEAVE_CARD.actions[2].prompt);
    expect(new URL(askNsk.href).pathname).toBe('/ask-nsk');

    const high = within(panel).getByRole('region', { name: 'High priority' });
    expect(within(high).getAllByTestId('insight-card')).toHaveLength(2);
    expect(within(high).getByRole('link', { name: 'Review task' }).getAttribute('href')).toBe('/boards/dept-1?task=t1');
    expect(within(high).getByRole('link', { name: 'View in Department Board' }).getAttribute('href')).toBe(
      '/boards/dept-1?task=t2',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('approves only after the undo window, and Undo sends nothing', async () => {
    requestDailyBriefing.mockResolvedValue(briefingOf([LEAVE_CARD]));
    requestLeaveApproval.mockResolvedValue({ notice: 'Leave request approved' });
    const panel = await openPanel();
    const card = within(panel).getByTestId('insight-card');

    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(within(card).getByText(/Approving…/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(requestLeaveApproval).not.toHaveBeenCalled();

    requestDailyBriefing.mockResolvedValue(briefingOf([]));
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(requestLeaveApproval).toHaveBeenCalledWith('r1', { note: null, step: 'MANAGER' }, 'csrf'),
    );
    // The briefing loads again; the decided card leaves it and its outcome stays in view.
    expect(await within(panel).findByText(/Leave request approved/)).toBeTruthy();
    await waitFor(() => expect(requestDailyBriefing).toHaveBeenCalledTimes(2));
  });

  it('declines with a required reason', async () => {
    requestDailyBriefing.mockResolvedValue(briefingOf([LEAVE_CARD]));
    requestLeaveRejection.mockResolvedValue({ notice: 'Leave request rejected' });
    const panel = await openPanel();
    const card = within(panel).getByTestId('insight-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    const confirm = within(card).getByRole('button', { name: 'Decline request' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText('Reason for declining'), {
      target: { value: '  Release week, please move it  ' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(requestLeaveRejection).toHaveBeenCalledWith(
        'r1',
        { note: 'Release week, please move it', step: 'MANAGER' },
        'csrf',
      ),
    );
    expect(await within(panel).findByText(/Leave request rejected/)).toBeTruthy();
  });

  it("shows the backend's reason when a decision is refused", async () => {
    requestDailyBriefing.mockResolvedValue(briefingOf([LEAVE_CARD]));
    requestLeaveRejection.mockRejectedValue(
      Object.assign(new Error('This step was already decided'), { name: 'ApiError' }),
    );
    const panel = await openPanel();
    const card = within(panel).getByTestId('insight-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    fireEvent.change(within(card).getByLabelText('Reason for declining'), { target: { value: 'No' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Decline request' }));
    expect(await within(panel).findByRole('alert')).toBeTruthy();
  });
});
