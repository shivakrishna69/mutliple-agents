/**
 * The daily briefing's formatting without a database (services/insights/): compact date ranges, the
 * order cards are shown in, and the one-line headline.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { headlineOf } from '../../services/insights/dailyBriefing.js';
import { dateRange, dayMonth, sortCards } from '../../services/insights/insightFormat.js';

describe('dates on briefing cards', () => {
  it('writes a day as "25 Dec", and a range across days, months and years', () => {
    assert.equal(dayMonth('2026-12-25'), '25 Dec');
    assert.equal(dateRange('2026-12-25'), '25 Dec');
    assert.equal(dateRange('2026-12-25', '2026-12-25'), '25 Dec');
    assert.equal(dateRange('2026-12-25', '2026-12-30'), '25 Dec – 30 Dec');
    assert.equal(dateRange('2026-12-30', '2027-01-02'), '30 Dec – 2 Jan');
  });
});

describe('card order', () => {
  it('puts urgent first, then high, then normal; within each, by kind and then oldest first', () => {
    const card = (id, severity, kind, at) => ({ id, severity, kind, at });
    const sorted = sortCards([
      card('due-today', 'normal', 'TASK_DUE_TODAY', '2026-11-26'),
      card('overdue-new', 'high', 'TASK_OVERDUE', '2026-11-25'),
      card('leave', 'high', 'LEAVE_APPROVAL', '2026-11-24T10:00:00Z'),
      card('revision', 'urgent', 'TASK_REVISION', '2026-11-26T08:00:00Z'),
      card('overdue-old', 'high', 'TASK_OVERDUE', '2026-11-20'),
      card('support', 'normal', 'SUPPORT_WAITING', '2026-11-26T09:00:00Z'),
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.id),
      ['revision', 'leave', 'overdue-old', 'overdue-new', 'due-today', 'support'],
    );
  });
});

describe('headline', () => {
  it('lists what needs the person, in a fixed order, singular and plural', () => {
    assert.equal(
      headlineOf({ TASK_REVISION: 1, TASK_OVERDUE: 2, LEAVE_APPROVAL: 1 }),
      '1 revision needed · 2 overdue · 1 leave request to approve',
    );
    assert.equal(
      headlineOf({ TASK_DUE_TODAY: 3, TASK_REVIEW: 2, TASK_UP_NEXT: 1, LEAVE_APPROVAL: 2 }),
      '2 leave requests to approve · 2 tasks to review · 1 ready to start · 3 due today',
    );
  });

  it('counts team queues, and says all is clear only when there is nothing at all', () => {
    assert.equal(headlineOf({ SUPPORT_WAITING: 1 }), '1 team queue waiting');
    assert.equal(
      headlineOf({ TASK_OVERDUE: 1, SUPPORT_WAITING: 1, FORM16_PENDING: 1 }),
      '1 overdue · 2 team queues waiting',
    );
    assert.equal(headlineOf({}), 'Nothing needs you right now');
  });
});
