/**
 * Pure helpers for the NSK assistant (components/nskBot/): reading a reply's citation marks, the kind
 * of badge each source gets, the offboarding form's request body, and merging live progress into a case.
 */

import {
  CITATION_MARK_PATTERN,
  NSK_SOURCE_KINDS,
  OFFBOARDING_STATUSES,
  QUOTE_TOOL,
  SNIPPET_TOOLS,
  WEB_SEARCH_LABEL_PREFIX,
} from '../constants/nskBot.js';

/**
 * A reply's text as pieces: { kind: 'text', text } and { kind: 'mark', number } for each [n] that
 * names one of `citationNumbers` (other brackets stay text).
 */
export function splitCitations(text, citationNumbers) {
  const pieces = [];
  let previousEnd = 0;
  for (const mark of text.matchAll(CITATION_MARK_PATTERN)) {
    const number = Number(mark[1]);
    if (!citationNumbers.has(number)) continue;
    if (mark.index > previousEnd) pieces.push({ kind: 'text', text: text.slice(previousEnd, mark.index) });
    pieces.push({ kind: 'mark', number });
    previousEnd = mark.index + mark[0].length;
  }
  if (previousEnd < text.length) pieces.push({ kind: 'text', text: text.slice(previousEnd) });
  return pieces;
}

/** Which badge a citation gets: its kind, or SNIPPET for unverified web search snippets. */
export function sourceBadgeKind(citation) {
  if (citation.kind !== NSK_SOURCE_KINDS.TOOL) return citation.kind;
  const isSnippet =
    SNIPPET_TOOLS.includes(citation.tool) ||
    (citation.tool === QUOTE_TOOL && citation.label?.startsWith(WEB_SEARCH_LABEL_PREFIX));
  return isSnippet ? 'SNIPPET' : NSK_SOURCE_KINDS.TOOL;
}

/** The host of a URL for display, or the URL itself when it cannot be read. */
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** A new offboarding form: notice from today, last working day empty. */
export function emptyOffboardingForm(today) {
  return {
    kind: 'RESIGNATION',
    noticeDate: today,
    lastWorkingDay: '',
    reason: '',
    monthlyGross: '',
    monthlyBasic: '',
    salaryDays: '',
    encashableDays: '',
    noticeShortfallDays: '',
    noticeRecoveryWaived: false,
    isFixedTerm: false,
    tdsOverride: '',
    otherEarnings: [],
    otherDeductions: [],
  };
}

/** A typed amount as a number, or null when left empty (the backend then uses what it holds). */
const optionalNumber = (value) => (value === '' || value === null || value === undefined ? null : Number(value));

const linesOf = (lines, { withTaxable }) =>
  lines
    .filter((line) => line.label.trim() !== '' || line.amount !== '')
    .map((line) => ({
      label: line.label.trim(),
      amount: Number(line.amount),
      ...(withTaxable ? { taxable: line.taxable !== false } : {}),
    }));

/** POST /api/nsk-bot/offboarding/preview's body for `form`. */
export function toPreviewRequest(form, employeeId, version = null) {
  return {
    employeeId,
    separation: {
      kind: form.kind,
      noticeDate: form.noticeDate,
      lastWorkingDay: form.lastWorkingDay,
      ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    },
    adjustments: {
      monthlyGross: optionalNumber(form.monthlyGross),
      monthlyBasic: optionalNumber(form.monthlyBasic),
      salaryDays: optionalNumber(form.salaryDays),
      encashableDays: optionalNumber(form.encashableDays),
      noticeShortfallDays: optionalNumber(form.noticeShortfallDays),
      noticeRecoveryWaived: form.noticeRecoveryWaived,
      isFixedTerm: form.isFixedTerm,
      tdsOverride: optionalNumber(form.tdsOverride),
      otherEarnings: linesOf(form.otherEarnings, { withTaxable: true }),
      otherDeductions: linesOf(form.otherDeductions, { withTaxable: false }),
    },
    ...(version === null ? {} : { version }),
  };
}

/** The case as an OFFBOARDING_PROGRESS event leaves it (events for other cases change nothing). */
export function mergeProgress(offboardingCase, event) {
  if (!offboardingCase || event.caseId !== offboardingCase.id) return offboardingCase;
  const known = new Map((offboardingCase.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const artifacts = event.artifacts.map((artifact) => ({ downloadable: true, ...known.get(artifact.id), ...artifact }));
  return {
    ...offboardingCase,
    status: event.status,
    progress: event.progress,
    lastErrorCode: event.lastErrorCode,
    artifacts,
  };
}

/** True while the documents are still being prepared. */
export const isGenerating = (offboardingCase) =>
  [OFFBOARDING_STATUSES.QUEUED, OFFBOARDING_STATUSES.GENERATING].includes(offboardingCase?.status);
