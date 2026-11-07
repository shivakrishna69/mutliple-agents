/**
 * How department knowledge bases are shown. Statuses mirror the backend's
 * (backend/models/DepartmentAgent.js AGENT_STATUSES, models/AgentDocument.js DOCUMENT_STATUSES); the
 * backend's texts (errors, a failed document's reason) are shown as it sends them.
 */

/** An agent's state; NOT_SET_UP is an agent nobody has opened yet (the list reports it as null). */
export const AGENT_STATUS_DISPLAY = Object.freeze({
  ACTIVE: { label: 'Active', tone: 'emerald' },
  PAUSED: { label: 'Paused', tone: 'amber' },
  NOT_SET_UP: { label: 'Not set up', tone: 'slate' },
});

export const AGENT_STATUSES = Object.freeze({ ACTIVE: 'ACTIVE', PAUSED: 'PAUSED' });

/**
 * How the backend says a person may manage a knowledge base (backend/services/knowledge/knowledgeAccess.js).
 * ADMIN is reach as an administrator; the others mean the department is the person's own.
 */
export const KNOWLEDGE_ACCESS_BASIS = Object.freeze({
  ADMIN: 'admin',
  DEPARTMENT_HEAD: 'department_head',
  KNOWLEDGE_LEAD: 'knowledge_lead',
});

export const DOCUMENT_STATUS_DISPLAY = Object.freeze({
  UPLOADED: { label: 'Queued', tone: 'sky' },
  PROCESSING: { label: 'Processing', tone: 'brand' },
  READY: { label: 'Ready', tone: 'emerald' },
  FAILED: { label: 'Failed', tone: 'rose' },
  DELETING: { label: 'Deleting', tone: 'amber' },
});

/** Documents still being read and indexed: while any is, the list refreshes itself. */
export const IN_PROGRESS_DOCUMENT_STATUSES = Object.freeze(['UPLOADED', 'PROCESSING']);
export const DOCUMENTS_REFRESH_INTERVAL_MS = 3_000;

/** Typing pause before the lead picker searches. */
export const LEAD_SEARCH_DEBOUNCE_MS = 300;
