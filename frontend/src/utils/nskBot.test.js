/**
 * The NSK assistant's pure helpers (utils/nskBot.js): citation marks, the badge each source gets
 * (unverified search snippets included), the offboarding form's request body, live progress, and the
 * type-ahead sentence starters.
 */

import { describe, expect, it } from 'vitest';
import {
  emptyOffboardingForm,
  hostOf,
  isGenerating,
  matchPromptHelpers,
  mergeProgress,
  sourceBadgeKind,
  splitCitations,
  toPreviewRequest,
} from './nskBot.js';

describe('citation marks', () => {
  it('links only the marks that name a source and keeps the rest as text', () => {
    expect(splitCitations('You have 6 days [1] and [3] left [2].', new Set([1, 2]))).toEqual([
      { kind: 'text', text: 'You have 6 days ' },
      { kind: 'mark', number: 1 },
      { kind: 'text', text: ' and [3] left ' },
      { kind: 'mark', number: 2 },
      { kind: 'text', text: '.' },
    ]);
    expect(splitCitations('No marks.', new Set())).toEqual([{ kind: 'text', text: 'No marks.' }]);
  });
});

describe('source badges', () => {
  it('names each kind, and flags web search snippets as unverified', () => {
    expect(sourceBadgeKind({ kind: 'TOOL', tool: 'my_leave_balances', label: 'Your leave balances' })).toBe('TOOL');
    expect(sourceBadgeKind({ kind: 'DOCUMENT' })).toBe('DOCUMENT');
    expect(sourceBadgeKind({ kind: 'CONVERSATION' })).toBe('CONVERSATION');
    expect(sourceBadgeKind({ kind: 'WEB' })).toBe('WEB');
    expect(sourceBadgeKind({ kind: 'TOOL', tool: 'web_search', label: 'Web search: "repo rate" (2026-11-14)' })).toBe(
      'SNIPPET',
    );
    // A quote is verified; its fallback to search snippets is not.
    expect(
      sourceBadgeKind({ kind: 'TOOL', tool: 'get_stock_quote', label: 'TCS on NSE, Alpha Vantage, 2026-11-13' }),
    ).toBe('TOOL');
    expect(
      sourceBadgeKind({
        kind: 'TOOL',
        tool: 'get_stock_quote',
        label: 'Web search: "TCS share price NSE" (2026-11-14)',
      }),
    ).toBe('SNIPPET');
  });

  it('shows a page by its host', () => {
    expect(hostOf('https://www.rbi.org.in/press/rates?x=1')).toBe('www.rbi.org.in');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('the offboarding request', () => {
  it('leaves empty adjustments to the backend and sends only filled lines', () => {
    const form = {
      ...emptyOffboardingForm('2026-11-15'),
      lastWorkingDay: '2026-12-15',
      reason: '  Moving cities  ',
      monthlyGross: '100000',
      noticeShortfallDays: '0',
      noticeRecoveryWaived: true,
      otherEarnings: [
        { label: 'Bonus', amount: '5000', taxable: false },
        { label: '', amount: '', taxable: true },
      ],
      otherDeductions: [{ label: 'Laptop', amount: '20000' }],
    };
    expect(toPreviewRequest(form, 'emp-1', 2)).toEqual({
      employeeId: 'emp-1',
      separation: {
        kind: 'RESIGNATION',
        noticeDate: '2026-11-15',
        lastWorkingDay: '2026-12-15',
        reason: 'Moving cities',
      },
      adjustments: {
        monthlyGross: 100000,
        monthlyBasic: null,
        salaryDays: null,
        encashableDays: null,
        noticeShortfallDays: 0,
        noticeRecoveryWaived: true,
        isFixedTerm: false,
        tdsOverride: null,
        otherEarnings: [{ label: 'Bonus', amount: 5000, taxable: false }],
        otherDeductions: [{ label: 'Laptop', amount: 20000 }],
      },
      version: 2,
    });
    const first = toPreviewRequest(emptyOffboardingForm('2026-11-15'), 'emp-1');
    expect(first).not.toHaveProperty('version');
    expect(first.separation).not.toHaveProperty('reason');
  });
});

describe('live progress', () => {
  const started = {
    id: 'case-1',
    status: 'QUEUED',
    progress: { completedSteps: 0, totalSteps: 3, currentStep: null },
    artifacts: [],
    lastErrorCode: null,
  };

  it('takes each step of its own case, and ignores other cases', () => {
    const working = mergeProgress(started, {
      caseId: 'case-1',
      status: 'GENERATING',
      progress: { completedSteps: 1, totalSteps: 3, currentStep: 'SETTLEMENT_STATEMENT' },
      lastErrorCode: null,
      artifacts: [{ id: 'a1', kind: 'RELIEVING_LETTER', fileName: 'letter.pdf', sizeBytes: 10 }],
    });
    expect(working.status).toBe('GENERATING');
    expect(working.artifacts).toEqual([
      { id: 'a1', kind: 'RELIEVING_LETTER', fileName: 'letter.pdf', sizeBytes: 10, downloadable: true },
    ]);
    expect(isGenerating(working)).toBe(true);
    expect(mergeProgress(started, { ...working, caseId: 'case-2' })).toBe(started);
    expect(isGenerating({ ...working, status: 'COMPLETED' })).toBe(false);
    expect(mergeProgress(null, { caseId: 'case-1' })).toBe(null);
  });

  it('keeps what the case already knew about a document', () => {
    const known = { ...started, artifacts: [{ id: 'a1', kind: 'RELIEVING_LETTER', downloadable: false }] };
    const merged = mergeProgress(known, {
      caseId: 'case-1',
      status: 'COMPLETED',
      progress: started.progress,
      lastErrorCode: null,
      artifacts: [{ id: 'a1', kind: 'RELIEVING_LETTER', fileName: 'letter.pdf', sizeBytes: 10 }],
    });
    expect(merged.artifacts[0].downloadable).toBe(false);
  });
});

const HELPERS = [
  {
    intent: 'ATTENDANCE_AUDIT',
    label: 'Check my leave balances',
    fill: 'Check my leave balances',
    keywords: ['leave', 'balance'],
  },
  {
    intent: 'ATTENDANCE_AUDIT',
    label: 'Show my leave requests',
    fill: 'Show my leave requests',
    keywords: ['leave', 'request'],
  },
  {
    intent: 'ATTENDANCE_AUDIT',
    label: 'Show my attendance this month',
    fill: 'Show my attendance this month',
    keywords: ['attendance', 'punch'],
  },
  {
    intent: 'OFFBOARDING_WORKFLOW',
    label: 'Start offboarding for [name]',
    fill: 'Start offboarding for ',
    keywords: ['deboard', 'offboard', 'leaving'],
  },
  {
    intent: 'OFFBOARDING_WORKFLOW',
    label: 'Prepare the F&F for [name]',
    fill: 'Prepare the F&F for ',
    keywords: ['f&f'],
  },
  {
    intent: 'PROFILE_LOOKUP',
    label: 'Show department headcount for [department]',
    fill: 'Show the headcount for ',
    keywords: ['headcount', 'head'],
  },
  {
    intent: 'POLICY_QA',
    label: 'What is the leave policy?',
    fill: 'What is the leave policy?',
    keywords: ['policy', 'leave'],
  },
];
const labelsFor = (draft) => matchPromptHelpers(draft, HELPERS).map((helper) => helper.label);

describe('type-ahead sentence starters', () => {
  it('completes the word being typed, closest keyword first, at most three', () => {
    expect(labelsFor('debo')).toEqual(['Start offboarding for [name]']);
    expect(labelsFor('OFFB')).toEqual(['Start offboarding for [name]']);
    expect(labelsFor('head')).toEqual(['Show department headcount for [department]']);
    expect(labelsFor('atte')).toEqual(['Show my attendance this month']);
    // "leav" is closer to leave than to leaving: the leave starters win the three places.
    expect(labelsFor('leav')).toEqual([
      'Check my leave balances',
      'Show my leave requests',
      'What is the leave policy?',
    ]);
    expect(labelsFor('f&f')).toEqual(['Prepare the F&F for [name]']);
    // A whole word that contains a keyword counts too.
    expect(labelsFor('offboarding')).toEqual(['Start offboarding for [name]']);
  });

  it('prefers the starter the draft begins, and the last word over earlier ones', () => {
    expect(labelsFor('show my le')[0]).toBe('Show my leave requests');
    expect(labelsFor('deboard punch')).toEqual(['Show my attendance this month', 'Start offboarding for [name]']);
    expect(labelsFor('punch deboard')).toEqual(['Start offboarding for [name]', 'Show my attendance this month']);
    expect(labelsFor('i want to deboard raj')).toEqual(['Start offboarding for [name]']);
  });

  it('offers nothing for short, long or unmatched drafts, or once a starter is in the box', () => {
    expect(labelsFor('sh')).toEqual([]);
    expect(labelsFor('x'.repeat(81))).toEqual([]);
    expect(labelsFor('hello there')).toEqual([]);
    expect(labelsFor('Start offboarding for Raj')).toEqual([]);
    expect(labelsFor('Check my leave balances')).toEqual([]);
    expect(matchPromptHelpers('debo', [])).toEqual([]);
    expect(matchPromptHelpers('debo', undefined)).toEqual([]);
  });
});
