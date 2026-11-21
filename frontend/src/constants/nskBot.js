/**
 * How the NSK assistant is shown. Values mirror the backend's (backend/constants/nskBot.js,
 * models/OffboardingCase.js); every text the backend writes (replies, citation labels, suggestions,
 * action labels, banners, notes, errors) is shown as it sends it. Only the screen's own labels live here.
 */

export const NSK_MESSAGE_ROLES = Object.freeze({ USER: 'USER', ASSISTANT: 'ASSISTANT' });

export const NSK_OUTCOMES = Object.freeze({
  ANSWERED: 'ANSWERED',
  CLARIFY: 'CLARIFY',
  NOT_FOUND: 'NOT_FOUND',
  NOT_ALLOWED: 'NOT_ALLOWED',
  REFUSED: 'REFUSED',
});

/** A tag under replies that did not simply answer. */
export const OUTCOME_DISPLAY = Object.freeze({
  CLARIFY: { label: 'Needs a detail', tone: 'sky' },
  NOT_FOUND: { label: 'Nothing found', tone: 'slate' },
  NOT_ALLOWED: { label: 'Not available to your role', tone: 'amber' },
  REFUSED: { label: 'Not verified, so not shown', tone: 'rose' },
});

export const NSK_SOURCE_KINDS = Object.freeze({
  TOOL: 'TOOL',
  DOCUMENT: 'DOCUMENT',
  CONVERSATION: 'CONVERSATION',
  WEB: 'WEB',
});

/** What each kind of source badge says it is. */
export const SOURCE_KIND_DISPLAY = Object.freeze({
  TOOL: { label: 'Live portal data', tone: 'brand' },
  DOCUMENT: { label: 'Policy document', tone: 'emerald' },
  CONVERSATION: { label: 'Earlier conversation', tone: 'violet' },
  WEB: { label: 'Web page', tone: 'sky' },
  SNIPPET: { label: 'Web search snippet · unverified', tone: 'amber' },
});

/**
 * Tool citations that come from web search snippets rather than a read page or a verified quote:
 * web_search always; get_stock_quote when it fell back to search (its label is then the backend's
 * web search label, backend constants/messages.js SOURCE_LABELS.WEB_SEARCH).
 */
export const SNIPPET_TOOLS = Object.freeze(['web_search']);
export const QUOTE_TOOL = 'get_stock_quote';
export const WEB_SEARCH_LABEL_PREFIX = 'Web search:';

export const NSK_ACTION_KINDS = Object.freeze({ START_OFFBOARDING: 'START_OFFBOARDING', VIEW_PROFILE: 'VIEW_PROFILE' });

/** What a View profile first card asks NSK (the person's words, sent as their message). */
export const viewProfileMessage = (name, employeeCode) => `Show the profile of ${name} (${employeeCode})`;

/**
 * The type-ahead bar above the message box: the backend's sentence starters (GET /api/nsk-bot/sessions
 * promptHelpers, already limited to the person's intents) matched on the device against the words
 * typed. Shown for drafts of PROMPT_HELPER_MIN_CHARS to PROMPT_HELPER_MAX_CHARS characters, at most
 * PROMPT_HELPERS_SHOWN at a time.
 */
export const PROMPT_HELPERS_SHOWN = 3;
export const PROMPT_HELPER_MIN_CHARS = 3;
export const PROMPT_HELPER_MAX_CHARS = 80;

/** The longest message the backend takes (NSK_BOT_SETTINGS.MESSAGE_MAX_LENGTH). */
export const NSK_MESSAGE_MAX_LENGTH = 2000;
/** Citation marks in a reply: [1], [2]. */
export const CITATION_MARK_PATTERN = /\[(\d+)\]/g;

export const NSK_LABELS = Object.freeze({
  OPEN: 'Ask NSK',
  SUBTITLE: 'Your HR assistant: attendance, leave, policies, and more',
  NEW_CHAT: 'New chat',
  NEW_CONVERSATION: 'New conversation',
  SESSIONS: 'Your conversations',
  NO_SESSIONS: 'No conversations yet',
  DELETE_SESSION: 'Delete conversation',
  PLACEHOLDER: 'Ask NSK anything about your work, leave or company policies…',
  SEND: 'Send',
  THINKING: 'NSK is checking your records and sources…',
  EMPTY_TITLE: 'How can I help?',
  EMPTY_HINT: 'Ask about your attendance, leave balance, a policy, or anything HR.',
  SOURCES: 'Sources',
  SUGGESTED: 'You might ask',
  FETCHED: 'fetched',
  OPEN_SOURCE: 'Open the page',
  PROMPT_HELPERS: 'Suggested questions',
  QUICK_START: 'Ways to start',
});

/** How many one-tap questions a fresh Ask NSK chat offers (utils/nskBot.js quickStartsFrom). */
export const NSK_QUICK_START_LIMIT = 4;

// =================================================================================================
// Offboarding
// =================================================================================================

export const SEPARATION_KIND_OPTIONS = Object.freeze([
  { value: 'RESIGNATION', label: 'Resignation' },
  { value: 'TERMINATION', label: 'Separation by the company' },
  { value: 'CONTRACT_END', label: 'End of contract' },
  { value: 'RETIREMENT', label: 'Retirement' },
]);

export const OFFBOARDING_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  QUEUED: 'QUEUED',
  GENERATING: 'GENERATING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

export const OFFBOARDING_STATUS_DISPLAY = Object.freeze({
  DRAFT: { label: 'Draft', tone: 'slate' },
  QUEUED: { label: 'Queued', tone: 'sky' },
  GENERATING: { label: 'Preparing documents', tone: 'sky' },
  COMPLETED: { label: 'Documents ready', tone: 'emerald' },
  FAILED: { label: 'Documents failed', tone: 'rose' },
  CANCELLED: { label: 'Cancelled', tone: 'slate' },
});

/** The documents an executed case produces, in the order they are generated. */
export const ARTIFACT_KINDS = Object.freeze(['RELIEVING_LETTER', 'SETTLEMENT_STATEMENT', 'ATTENDANCE_AUDIT']);
export const ARTIFACT_DISPLAY = Object.freeze({
  RELIEVING_LETTER: 'Relieving and experience letter (PDF)',
  SETTLEMENT_STATEMENT: 'Full and final settlement statement (PDF)',
  ATTENDANCE_AUDIT: '3-month attendance and leave audit (.xlsx)',
});

export const OFFBOARDING_LABELS = Object.freeze({
  TITLE: 'Offboarding package',
  SEPARATION: 'Separation',
  NOTICE_DATE: 'Resignation or notice date',
  LAST_WORKING_DAY: 'Last working day',
  REASON: 'Exit reason (optional)',
  ADJUSTMENTS: 'Adjustments (leave empty to use what the portal holds)',
  MONTHLY_GROSS: 'Monthly gross (₹)',
  MONTHLY_BASIC: 'Monthly Basic + DA (₹)',
  SALARY_DAYS: 'Salary days in the final month',
  ENCASHABLE_DAYS: 'Encashable leave days',
  SHORTFALL_DAYS: 'Notice shortfall days',
  WAIVE_RECOVERY: 'Waive the notice recovery',
  FIXED_TERM: 'Fixed-term employment (gratuity after 1 year)',
  TDS_OVERRIDE: 'TDS (₹), to replace the computed tax',
  OTHER_EARNINGS: 'Other earnings',
  OTHER_DEDUCTIONS: 'Other deductions',
  ADD_LINE: 'Add a line',
  REMOVE_LINE: 'Remove',
  LINE_LABEL: 'Description',
  LINE_AMOUNT: 'Amount (₹)',
  TAXABLE: 'Taxable',
  PREVIEW: 'Preview settlement',
  PREVIEW_AGAIN: 'Update preview',
  START: 'Start offboarding',
  RETRY: 'Prepare the documents again',
  CANCEL_DRAFT: 'Cancel draft',
  EARNINGS: 'Earnings',
  DEDUCTIONS: 'Deductions and recoveries',
  TOTAL_EARNINGS: 'Total earnings',
  TOTAL_DEDUCTIONS: 'Total deductions',
  NET_PAYABLE: 'Net payable to the employee',
  NET_RECOVERABLE: 'Net recoverable from the employee',
  SERVICE: 'Service',
  NOTICE: 'Notice',
  GRATUITY: 'Gratuity',
  TAX: 'Income tax',
  NOTICE_SUMMARY: (period, served, shortfall, waived) =>
    `${period} days required · ${served} served · ${shortfall} short${waived ? ' (recovery waived)' : ''}`,
  GRATUITY_SUMMARY: (eligible, years) => (eligible ? `Payable for ${years} years` : `Not payable (${years} years)`),
  PROGRESS: 'Preparing the documents',
  DOWNLOAD: 'Download',
  DOCUMENTS: 'Documents',
  WAITING: 'Waiting',
  READY: 'Ready',
  ERROR_CODE: (code) => `Error code: ${code}`,
});

export const OFFBOARDING_PAGE_LABELS = Object.freeze({
  TITLE: 'Offboarding',
  SUBTITLE: 'Full and final settlements, and who is serving notice',
  SETTLEMENTS: 'Settlements',
  IT_CHECKLIST: 'IT checklist',
  NO_CASES: 'No offboarding cases yet',
  NO_NOTICE: 'Nobody is serving notice',
  READ_ONLY: 'Read-only: figures as HR previewed them',
  EMPLOYEE: 'Employee',
  STATUS: 'Status',
  LAST_DAY: 'Last working day',
  NET: 'Net',
  DAYS_LEFT: (days) => (days === null ? '—' : days < 0 ? 'Left' : `${days} days left`),
  REVOKE_ON_LAST_DAY: 'To do on the last working day',
  WORK_EMAIL: 'Work email',
  BACK: 'Back to the list',
});
