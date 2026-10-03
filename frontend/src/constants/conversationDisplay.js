/**
 * Display configuration for conversations and messages: labels and Tailwind classes per backend
 * value. Keys mirror backend/models/Conversation.js (CONVERSATION_STATUS, ACTIVE_WORKER) and
 * backend/models/Message.js (SENDER_TYPE); unknown values fall back to a neutral style.
 *
 * Full class strings are written out (never assembled from fragments) so Tailwind's scanner sees
 * every class it must generate.
 */

export const CONVERSATION_STATUS_DISPLAY = Object.freeze({
  unassigned: {
    label: 'Open Support',
    description: 'New conversation waiting for its first reply',
    chipClassName: 'bg-sky-50 text-sky-700 ring-sky-600/20',
    dotClassName: 'bg-sky-500',
  },
  'processing-ai': {
    label: 'AI Processing',
    description: 'The AI assistant is handling this conversation',
    chipClassName: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
    dotClassName: 'bg-indigo-500',
  },
  'escalated-to-human': {
    label: 'Escalated to Human',
    description: 'Waiting in the queue for a human agent',
    chipClassName: 'bg-amber-50 text-amber-800 ring-amber-600/30',
    dotClassName: 'bg-amber-500',
  },
  'assigned-agent': {
    label: 'Agent Assigned',
    description: 'A human agent is handling this conversation',
    chipClassName: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    dotClassName: 'bg-emerald-500',
  },
});

export const UNKNOWN_STATUS_DISPLAY = Object.freeze({
  label: 'Unknown',
  description: 'Status not recognised',
  chipClassName: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  dotClassName: 'bg-slate-400',
});

/**
 * Bubble styling per sender. `alignment` places the customer on the left and everyone answering
 * for the company on the right, the convention of agent-side chat tools.
 */
export const SENDER_DISPLAY = Object.freeze({
  customer: {
    label: 'Customer',
    alignment: 'start',
    bubbleClassName: 'bg-white text-slate-900 ring-1 ring-slate-200',
    labelClassName: 'text-slate-600',
  },
  ai_supervisor: {
    label: 'AI Supervisor',
    alignment: 'end',
    bubbleClassName: 'bg-indigo-600 text-white',
    labelClassName: 'text-indigo-700',
  },
  ai_worker: {
    label: 'AI Specialist',
    alignment: 'end',
    bubbleClassName: 'bg-violet-600 text-white',
    labelClassName: 'text-violet-700',
  },
  human_agent: {
    label: 'Support Agent',
    alignment: 'end',
    bubbleClassName: 'bg-emerald-600 text-white',
    labelClassName: 'text-emerald-700',
  },
});

export const UNKNOWN_SENDER_DISPLAY = Object.freeze({
  label: 'Unknown sender',
  alignment: 'start',
  bubbleClassName: 'bg-slate-100 text-slate-800 ring-1 ring-slate-200',
  labelClassName: 'text-slate-500',
});

/** Human-readable names for Conversation.currentActiveWorker. */
export const ACTIVE_WORKER_LABELS = Object.freeze({
  supervisor: 'AI Supervisor',
  billing_agent: 'Billing Specialist (AI)',
  tech_agent: 'Technical Specialist (AI)',
  attendance_agent: 'Attendance Assistant (AI)',
  human: 'Human Agent',
});

/** Styling for a system log entry's outcome (toolExecutionLogs[].status). */
export const LOG_STATUS_DISPLAY = Object.freeze({
  success: { label: 'OK', className: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  error: { label: 'Error', className: 'bg-red-50 text-red-700 ring-red-600/20' },
});

/** Same limit as the backend (backend/constants/validation.js MESSAGE_FIELD_LIMITS). */
export const MESSAGE_TEXT_MAX_LENGTH = 20_000;
