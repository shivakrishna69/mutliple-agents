/**
 * How an NSK reply is shown (NskMessage.jsx): its citation marks linked to source badges of every kind
 * (live data, a policy document with its page, an earlier conversation, a web page with its address and
 * fetch date, an unverified search snippet), the outcome tag, the escalation banner, and the
 * suggestion chips and action cards of the latest reply, which hand their choice back.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NskMessage from './NskMessage.jsx';

const REPLY = {
  id: 'm1',
  role: 'ASSISTANT',
  content: 'You have 6 days [1]. The policy says so [2]. We spoke before [3]. The repo rate held [4]; rumours say [5].',
  outcome: 'ANSWERED',
  citations: [
    { number: 1, kind: 'TOOL', tool: 'my_leave_balances', label: 'Your leave balances, 2026-04-01 to 2027-03-31' },
    {
      number: 2,
      kind: 'DOCUMENT',
      label: 'Leave policy.pdf, p. 4',
      headingPath: ['Leave', 'Casual'],
      page: 4,
      excerpt: 'Six days a year.',
    },
    { number: 3, kind: 'CONVERSATION', label: 'Earlier session: Leave plans (2026-11-01)' },
    {
      number: 4,
      kind: 'WEB',
      label: 'RBI rates (www.rbi.org.in), fetched 2026-11-14',
      sourceUrl: 'https://www.rbi.org.in/press',
      fetchedAt: '2026-11-14T09:30:00.000Z',
    },
    { number: 5, kind: 'TOOL', tool: 'web_search', label: 'Web search: "repo rate" (2026-11-14)' },
  ],
  suggestions: [{ text: 'Show my leave requests', intent: 'ATTENDANCE_AUDIT' }],
  actions: [
    {
      kind: 'START_OFFBOARDING',
      label: 'Start offboarding package: Rahul Sharma (NSK0104)',
      employeeId: 'e1',
      employeeName: 'Rahul Sharma',
      employeeCode: 'NSK0104',
    },
    {
      kind: 'VIEW_PROFILE',
      label: 'View profile first: Rahul Sharma (NSK0104)',
      employeeId: 'e1',
      employeeName: 'Rahul Sharma',
      employeeCode: 'NSK0104',
    },
  ],
  escalation: { hint: 'Need a person? Contact HR directly, and they will help you' },
};

function renderReply(overrides = {}, props = {}) {
  const onSuggestion = vi.fn();
  const onAction = vi.fn();
  render(
    <ul>
      <NskMessage
        message={{ ...REPLY, ...overrides }}
        isLatest
        isBusy={false}
        onSuggestion={onSuggestion}
        onAction={onAction}
        {...props}
      />
    </ul>,
  );
  return { onSuggestion, onAction };
}

describe('an NSK reply', () => {
  it('links each mark to a badge saying what kind of source it is', () => {
    renderReply();
    expect(screen.getByRole('link', { name: 'Source 4' }).getAttribute('href')).toBe('#nsk-source-m1-4');
    const kinds = [...document.querySelectorAll('[data-source-kind]')].map((item) => item.dataset.sourceKind);
    expect(kinds).toEqual(['TOOL', 'DOCUMENT', 'CONVERSATION', 'WEB', 'SNIPPET']);
    expect(screen.getByText('Live portal data')).toBeTruthy();
    expect(screen.getByText('Leave › Casual · page 4')).toBeTruthy();
    expect(screen.getByText('Earlier conversation')).toBeTruthy();
    expect(screen.getByText('Web search snippet · unverified')).toBeTruthy();
    const web = document.getElementById('nsk-source-m1-4');
    const pageLink = within(web).getByRole('link', { name: 'www.rbi.org.in' });
    expect(pageLink.getAttribute('href')).toBe('https://www.rbi.org.in/press');
    expect(pageLink.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(web.textContent).toMatch(/fetched 14 Nov 2026/);
  });

  it('shows the escalation banner, and hands back chips and cards', () => {
    const { onSuggestion, onAction } = renderReply();
    expect(screen.getByRole('alert').textContent).toMatch('Need a person? Contact HR directly');
    fireEvent.click(screen.getByRole('button', { name: 'Show my leave requests' }));
    expect(onSuggestion).toHaveBeenCalledWith('Show my leave requests');
    fireEvent.click(screen.getByRole('button', { name: /Start offboarding package/ }));
    expect(onAction).toHaveBeenCalledWith(REPLY.actions[0]);
  });

  it('tags a reply that did not answer, and offers chips and cards on the latest reply only', () => {
    renderReply({ outcome: 'REFUSED', escalation: null }, { isLatest: false });
    expect(screen.getByText('Not verified, so not shown')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show my leave requests' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Start offboarding package/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never renders text as HTML', () => {
    renderReply({ content: '<img src=x onerror=alert(1)> hi', citations: [] });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });
});
