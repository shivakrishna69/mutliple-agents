/**
 * The launcher's counts and search (utils/launcherBadges.js): each count read from its existing
 * endpoint, a failed or empty one left out, "99+" above the maximum, and the search matching labels,
 * keywords and addresses in any case.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestConversationList } from '../api/conversationsApi.js';
import { requestApprovalQueue } from '../api/leaveApi.js';
import { requestCaEmployees } from '../api/taxApi.js';
import { requestRegularizationReviews } from '../api/workforceApi.js';
import { badgeText, filterTiles, loadLauncherBadges } from './launcherBadges.js';

vi.mock('../api/leaveApi.js', () => ({ requestApprovalQueue: vi.fn() }));
vi.mock('../api/workforceApi.js', () => ({ requestRegularizationReviews: vi.fn() }));
vi.mock('../api/conversationsApi.js', () => ({ requestConversationList: vi.fn() }));
vi.mock('../api/taxApi.js', () => ({ requestCaEmployees: vi.fn() }));

const ALL_BADGE_PATHS = ['/leave', '/attendance', '/console', '/tax/ca-portal'];

describe('loadLauncherBadges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestApprovalQueue.mockImplementation(async (queue) => ({
      requests: queue === 'requests' ? [{ id: 'r1' }, { id: 'r2' }] : [{ id: 'c1' }],
    }));
    requestRegularizationReviews.mockResolvedValue({ reviews: [{ id: 'v1' }] });
    requestConversationList.mockResolvedValue([
      { conversationId: 'a', status: 'escalated-to-human', assignedAgentId: null },
      { conversationId: 'b', status: 'escalated-to-human', assignedAgentId: 'agent-1' },
      { conversationId: 'c', status: 'processing-ai', assignedAgentId: null },
    ]);
    requestCaEmployees.mockResolvedValue({ summary: { eligible: 5, uploaded: 2, pending: 3 } });
  });

  it('counts pending leave decisions, attendance corrections, unclaimed chats and missing Form 16s', async () => {
    expect(await loadLauncherBadges([...ALL_BADGE_PATHS, '/payroll'])).toEqual({
      '/leave': 3,
      '/attendance': 1,
      '/console': 1,
      '/tax/ca-portal': 3,
    });
    expect(requestApprovalQueue).toHaveBeenCalledWith('requests', undefined);
    expect(requestApprovalQueue).toHaveBeenCalledWith('changes', undefined);
    expect(requestRegularizationReviews).toHaveBeenCalledWith('Pending', undefined);
  });

  it('asks only for the tiles the person sees', async () => {
    expect(await loadLauncherBadges(['/leave'])).toEqual({ '/leave': 3 });
    expect(requestConversationList).not.toHaveBeenCalled();
    expect(requestCaEmployees).not.toHaveBeenCalled();
  });

  it('leaves out a count that is 0 or cannot be read', async () => {
    requestRegularizationReviews.mockRejectedValue(new Error('403'));
    requestCaEmployees.mockResolvedValue({ summary: { eligible: 2, uploaded: 2, pending: 0 } });
    expect(await loadLauncherBadges(ALL_BADGE_PATHS)).toEqual({ '/leave': 3, '/console': 1 });
  });
});

describe('badgeText', () => {
  it('shows nothing at 0 or without a count, the number up to 99, then 99+', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(null)).toBeNull();
    expect(badgeText(-2)).toBeNull();
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('filterTiles', () => {
  const TILES = [
    { label: 'Payroll & Form 16', path: '/payroll', keywords: ['payslip', 'salary', 'tax'] },
    { label: 'Offboarding', path: '/people/offboarding', keywords: ['exit', 'resignation'] },
    { label: 'Leave', path: '/leave', keywords: ['time off'] },
  ];
  const labels = (query) => filterTiles(TILES, query).map((tile) => tile.label);

  it('matches the label, keywords and address, in any case', () => {
    expect(labels('PAY')).toEqual(['Payroll & Form 16']);
    expect(labels('payslip')).toEqual(['Payroll & Form 16']);
    expect(labels('Exit')).toEqual(['Offboarding']);
    expect(labels('people')).toEqual(['Offboarding']);
    expect(labels('form 16')).toEqual(['Payroll & Form 16']);
  });

  it('shows every tile for an empty search, and none when nothing matches', () => {
    expect(labels('   ')).toHaveLength(3);
    expect(labels('zebra')).toEqual([]);
  });
});
