/**
 * Structured audit events for security-relevant actions (who did what to which record, and whether
 * it was allowed). Each event is one JSON log line with `audit: true`, so a log pipeline can route
 * audit events to tamper-resistant storage (e.g. a write-once bucket or a SIEM) separately from
 * operational logs.
 *
 * Outcomes:
 *   allowed    the action was authorised and completed
 *   denied     authorisation refused it (403)
 *   rejected   the request was invalid or referred to something that does not exist (400/404/415)
 *   failed     authorised, but a dependency failed (e.g. storage unavailable)
 * Denied and failed events are logged at warn level so alerting can watch them.
 *
 * Never put secrets or bearer credentials (pre-signed URLs, tokens, file contents) in `details`.
 */

import { logger } from './logger.js';

export const AUDIT_OUTCOMES = Object.freeze({ ALLOWED: 'allowed', DENIED: 'denied', REJECTED: 'rejected', FAILED: 'failed' });

const USER_AGENT_MAX_LENGTH = 200;

/**
 * @param {import('express').Request} req
 * @param {{ category: string, action: string, outcome: string } & Record<string, unknown>} auditEvent
 */
export function recordAuditEvent(req, { category, action, outcome, ...details }) {
  const auditEntry = {
    audit: true,
    category,
    action,
    outcome,
    requestId: req.id,
    actorUserId: req.user?.id ?? null,
    actorRole: req.user?.role ?? null,
    clientIp: req.ip,
    userAgent: (req.get('user-agent') ?? '').slice(0, USER_AGENT_MAX_LENGTH),
    ...details,
  };
  const isAlertWorthy = outcome === AUDIT_OUTCOMES.DENIED || outcome === AUDIT_OUTCOMES.FAILED;
  (isAlertWorthy ? logger.warn : logger.info)(`audit ${category}.${action} ${outcome}`, auditEntry);
}
