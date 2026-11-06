/**
 * The dashboard's periods in the company's time zone (services/dashboardRange.js), including the
 * hours when the company's date and the server's (UTC) date differ, and daylight-saving days.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chartBucketsOf, isDashboardRange, resolveDashboardRange } from '../../services/dashboardRange.js';

const iso = (date) => date.toISOString();

describe('resolveDashboardRange', () => {
  it('starts "today" at the company’s midnight, not the server’s', () => {
    // 01:30 in Kolkata on 6 Nov is still 5 Nov (20:00) in UTC.
    const now = new Date('2026-11-05T20:00:00Z');
    const range = resolveDashboardRange('today', 'Asia/Kolkata', now);
    assert.equal(range.firstDate, '2026-11-06');
    assert.equal(range.lastDate, '2026-11-06');
    assert.equal(iso(range.start), '2026-11-05T18:30:00.000Z');
    assert.equal(iso(range.end), iso(now));
  });

  it('starts "today" behind UTC too: late evening in New York is already tomorrow in UTC', () => {
    // 21:00 in New York on 5 Nov is 02:00 on 6 Nov in UTC.
    const now = new Date('2026-11-06T02:00:00Z');
    const range = resolveDashboardRange('today', 'America/New_York', now);
    assert.equal(range.firstDate, '2026-11-05');
    assert.equal(iso(range.start), '2026-11-05T05:00:00.000Z');
  });

  it('compares with the same stretch of the previous period', () => {
    const now = new Date('2026-11-06T09:00:00Z'); // 14:30 in Kolkata
    const range = resolveDashboardRange('today', 'Asia/Kolkata', now);
    assert.equal(iso(range.previousStart), '2026-11-04T18:30:00.000Z');
    // Yesterday from midnight to 14:30, the same length as today so far.
    assert.equal(iso(range.previousEnd), '2026-11-05T09:00:00.000Z');
  });

  it('covers the last 7 and 30 calendar days, today included', () => {
    const now = new Date('2026-11-06T09:00:00Z');
    const week = resolveDashboardRange('7d', 'Asia/Kolkata', now);
    assert.equal(week.firstDate, '2026-10-31');
    assert.equal(iso(week.start), '2026-10-30T18:30:00.000Z');
    assert.equal(week.firstDate < week.lastDate, true);
    assert.equal(iso(week.previousStart), '2026-10-23T18:30:00.000Z');
    const month = resolveDashboardRange('30d', 'Asia/Kolkata', now);
    assert.equal(month.firstDate, '2026-10-08');
    assert.equal(month.dayCount, 30);
  });

  it('measures a day that daylight saving makes 25 hours long from its own midnight', () => {
    // New York falls back on 1 Nov 2026: that day runs 05:00Z..05:00Z+25h.
    const range = resolveDashboardRange('7d', 'America/New_York', new Date('2026-11-03T15:00:00Z'));
    assert.equal(range.firstDate, '2026-10-28');
    assert.equal(iso(range.start), '2026-10-28T04:00:00.000Z'); // still on summer time (UTC−4)
  });

  it('knows only its three ranges', () => {
    for (const key of ['today', '7d', '30d']) assert.equal(isDashboardRange(key), true);
    for (const key of ['1d', 'week', '', undefined, { $ne: '' }]) assert.equal(isDashboardRange(key), false);
  });
});

describe('chartBucketsOf', () => {
  it('splits today into its 24 local hours', () => {
    const range = resolveDashboardRange('today', 'Asia/Kolkata', new Date('2026-11-05T20:00:00Z'));
    const { unit, buckets } = chartBucketsOf(range);
    assert.equal(unit, 'hour');
    assert.equal(buckets.length, 24);
    assert.deepEqual(buckets[0], { key: '2026-11-06T00', label: '00:00' });
    assert.deepEqual(buckets.at(-1), { key: '2026-11-06T23', label: '23:00' });
  });

  it('splits longer ranges into local days', () => {
    const range = resolveDashboardRange('7d', 'Asia/Kolkata', new Date('2026-11-06T09:00:00Z'));
    const { unit, buckets } = chartBucketsOf(range);
    assert.equal(unit, 'day');
    assert.deepEqual(
      buckets.map((bucket) => bucket.key),
      ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
    );
  });
});
