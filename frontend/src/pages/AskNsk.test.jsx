/**
 * Ask NSK as a full page (AskNsk.jsx): the conversations rail (new conversation, history with the
 * open one marked, delete), the title and quick starts on a fresh chat, a quick start sending its
 * question, and a question prepared by the address (?q=) waiting in the box, never sent by itself.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestNskSession, requestNskSessionDeletion, requestNskSessions, sendNskMessage } from '../api/nskBotApi.js';
import AskNsk from './AskNsk.jsx';

vi.mock('../api/nskBotApi.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requestNskSessions: vi.fn(),
  requestNskSession: vi.fn(),
  requestNskSessionDeletion: vi.fn(),
  sendNskMessage: vi.fn(),
}));
vi.mock('../auth/AuthContext.jsx', () => {
  const session = { currentUser: { id: 'me', capabilities: ['use_nsk_assistant'] }, csrfToken: 'csrf' };
  return { useAuth: () => session };
});

const SESSION = { id: 's1', title: 'Leave balance', lastMessageAt: '2026-11-20T10:00:00.000Z' };
const HELPERS = [
  {
    intent: 'ATTENDANCE_AUDIT',
    label: 'Show my attendance this month',
    fill: 'Show my attendance this month',
    keywords: ['attendance'],
  },
  {
    intent: 'POLICY_QA',
    label: 'What is the leave policy?',
    fill: 'What is the leave policy?',
    keywords: ['leave', 'policy'],
  },
];

const renderPage = (address = '/ask-nsk') =>
  render(
    <MemoryRouter initialEntries={[address]}>
      <AskNsk />
    </MemoryRouter>,
  );

describe('Ask NSK page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    requestNskSessions.mockResolvedValue({ sessions: [SESSION], resume: null, promptHelpers: HELPERS });
  });

  it('shows the title, the conversations and the quick starts on a fresh chat', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Ask NSK' })).toBeTruthy();
    expect(screen.getByText('Your HR assistant: attendance, leave, policies, and more')).toBeTruthy();
    const rail = screen.getByTestId('nsk-conversations');
    expect(await within(rail).findByText('Leave balance')).toBeTruthy();
    const quickStarts = screen.getByTestId('nsk-quick-start');
    expect(
      within(quickStarts)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Show my attendance this month', 'What is the leave policy?']);
  });

  it('sends a quick start, and marks the new conversation in the rail', async () => {
    const created = { id: 's2', title: 'My attendance', lastMessageAt: '2026-11-21T09:00:00.000Z' };
    sendNskMessage.mockResolvedValue({
      session: created,
      userMessage: { id: 'u1', role: 'USER', content: 'Show my attendance this month' },
      message: { id: 'a1', role: 'ASSISTANT', content: 'You were present 18 days.', citations: [], suggestions: [] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show my attendance this month' }));
    await waitFor(() =>
      expect(sendNskMessage).toHaveBeenCalledWith(
        { message: 'Show my attendance this month', sessionId: null },
        'csrf',
      ),
    );
    expect(await screen.findByText('You were present 18 days.')).toBeTruthy();
    expect(screen.queryByTestId('nsk-quick-start')).toBeNull();
    const rail = screen.getByTestId('nsk-conversations');
    expect(within(rail).getByText('My attendance').closest('button').getAttribute('aria-current')).toBe('true');
  });

  it('opens a conversation, starts a new one, and deletes one', async () => {
    requestNskSession.mockResolvedValue({
      messages: [{ id: 'a0', role: 'ASSISTANT', content: 'You have 5 days left.', citations: [], suggestions: [] }],
    });
    requestNskSessionDeletion.mockResolvedValue({});
    renderPage();
    const rail = screen.getByTestId('nsk-conversations');
    fireEvent.click(await within(rail).findByText('Leave balance'));
    expect(await screen.findByText('You have 5 days left.')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'New conversation' })[0]);
    expect(screen.queryByText('You have 5 days left.')).toBeNull();
    expect(screen.getByTestId('nsk-quick-start')).toBeTruthy();

    fireEvent.click(within(rail).getByRole('button', { name: 'Delete conversation: Leave balance' }));
    await waitFor(() => expect(requestNskSessionDeletion).toHaveBeenCalledWith('s1', 'csrf'));
    expect(await within(rail).findByText('No conversations yet')).toBeTruthy();
  });

  it('puts a question from ?q= in the box, focused, and does not send it', async () => {
    const question = "Should I approve Naren's leave from 25 Dec to 30 Dec?";
    renderPage(`/ask-nsk?q=${encodeURIComponent(question)}`);
    const box = screen.getByRole('textbox', { name: 'Ask NSK anything about your work, leave or company policies…' });
    expect(box.value).toBe(question);
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(await within(screen.getByTestId('nsk-conversations')).findByText('Leave balance')).toBeTruthy();
    expect(sendNskMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' }).disabled).toBe(false);
  });
});
