/**
 * How department agent chat is shown. Values mirror the backend's (backend/models/AgentMessage.js,
 * models/AgentQuestion.js, models/Notification.js); every text the backend writes (answers, the
 * not-found reply, errors, notifications) is shown as it sends it.
 */

export const MESSAGE_ROLES = Object.freeze({ USER: 'USER', ASSISTANT: 'ASSISTANT', LEAD: 'LEAD' });
export const ANSWER_OUTCOMES = Object.freeze({ ANSWERED: 'ANSWERED', NOT_FOUND: 'NOT_FOUND', REFUSED: 'REFUSED' });
export const FEEDBACK_RATINGS = Object.freeze({ UP: 'UP', DOWN: 'DOWN' });

/** The events of a streamed answer (backend controllers/agentChatController.js). */
export const STREAM_EVENTS = Object.freeze({ STARTED: 'started', DELTA: 'delta', FINAL: 'final', ERROR: 'error' });

export const QUESTION_STATUSES = Object.freeze({ OPEN: 'OPEN', ANSWERED: 'ANSWERED', DISMISSED: 'DISMISSED' });
export const QUESTION_STATUS_DISPLAY = Object.freeze({
  OPEN: { label: 'Open', tone: 'amber' },
  ANSWERED: { label: 'Answered', tone: 'emerald' },
  DISMISSED: { label: 'Closed', tone: 'slate' },
});
export const QUESTION_REASON_DISPLAY = Object.freeze({
  UNANSWERED: 'The agent could not answer',
  DOWNVOTED: 'Rated unhelpful',
});
/** The question status of an escalated answer, as the asker sees it under the answer. */
export const ESCALATION_DISPLAY = Object.freeze({
  OPEN: 'Sent to the department. You will be notified when they reply.',
  ANSWERED: 'The department replied below.',
  DISMISSED: 'The department closed this question.',
});

export const AUDIENCE_DISPLAY = Object.freeze({ COMPANY: 'Company-wide', DEPARTMENT: 'Your department' });

/** The longest question the backend takes (AGENT_CHAT_SETTINGS.QUESTION_MAX_LENGTH). */
export const QUESTION_MAX_LENGTH = 2000;
/** Citation marks in an answer: [1], [2]. */
export const CITATION_MARK_PATTERN = /\[(\d+)\]/g;
