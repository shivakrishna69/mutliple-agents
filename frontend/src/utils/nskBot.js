/**
 * Pure helpers for the NSK assistant (components/nskBot/): reading a reply's citation marks, the kind
 * of badge each source gets, the offboarding form's request body, merging live progress into a case,
 * and matching the type-ahead sentence starters to what is being typed.
 */

import {
  CITATION_MARK_PATTERN,
  NSK_SOURCE_KINDS,
  OFFBOARDING_STATUSES,
  PROMPT_HELPERS_SHOWN,
  PROMPT_HELPER_MAX_CHARS,
  PROMPT_HELPER_MIN_CHARS,
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

// A word typed before the last one counts this much less than the last word (the one being typed).
const EARLIER_WORD_PENALTY = 100;
const MIN_WORD_LENGTH = 3;

/** How close one typed word is to a helper's keywords: 0 is exact, larger is further; null for none. */
function wordScore(word, keywords) {
  let best = null;
  for (const keyword of keywords) {
    let score = null;
    if (keyword.startsWith(word)) score = keyword.length - word.length;
    else if (word.startsWith(keyword) && keyword.length >= MIN_WORD_LENGTH) score = word.length - keyword.length;
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

/**
 * The sentence starters to offer for `draft`, closest first, at most PROMPT_HELPERS_SHOWN. A helper
 * matches when the draft begins its text ("check my le") or a typed word begins one of its keywords
 * ("debo" → deboard; "leav" prefers leave over leaving); the word being typed (the last) counts most.
 * Nothing is offered for a draft too short or too long, or once the draft starts with any helper's
 * text (a starter was picked: the person is finishing it).
 * @param {string} draft
 * @param {{ label: string, fill: string, keywords: string[] }[]} helpers
 */
export function matchPromptHelpers(draft, helpers) {
  const typed = draft.trim().toLowerCase();
  if (typed.length < PROMPT_HELPER_MIN_CHARS || typed.length > PROMPT_HELPER_MAX_CHARS || !helpers?.length) {
    return [];
  }
  const words = typed.split(/[^\p{L}\p{N}&]+/u).filter((word) => word.length >= MIN_WORD_LENGTH || word.includes('&'));
  if (helpers.some((helper) => typed.startsWith(helper.fill.trim().toLowerCase()))) return [];
  const scored = [];
  helpers.forEach((helper, order) => {
    const fill = helper.fill.trim().toLowerCase();
    let best = fill.startsWith(typed) ? -1 : null;
    words.forEach((word, index) => {
      const score = wordScore(word, helper.keywords);
      if (score === null) return;
      const weighted = score + (index === words.length - 1 ? 0 : EARLIER_WORD_PENALTY);
      if (best === null || weighted < best) best = weighted;
    });
    if (best !== null) scored.push({ helper, best, order });
  });
  return scored
    .sort((first, second) => first.best - second.best || first.order - second.order)
    .slice(0, PROMPT_HELPERS_SHOWN)
    .map((item) => item.helper);
}

/**
 * The one-tap questions for a fresh chat, from the backend's promptHelpers for this person: only the
 * complete ones (a starter that needs a name or a department added is left for the type-ahead), one
 * per intent first so they cover what the person may ask, then the rest, up to `limit`.
 * @param {{ intent: string, label: string, fill: string }[]} helpers
 */
export function quickStartsFrom(helpers, limit) {
  const complete = helpers.filter((helper) => helper.fill.trim() === helper.label && !helper.fill.endsWith(' '));
  const firstPerIntent = complete.filter(
    (helper, index) => complete.findIndex((other) => other.intent === helper.intent) === index,
  );
  const rest = complete.filter((helper) => !firstPerIntent.includes(helper));
  return [...firstPerIntent, ...rest].slice(0, limit);
}
