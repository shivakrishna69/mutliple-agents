/**
 * POST /api/internal/agent-telemetry/events  (ai-service only; requireInternalApiKey)
 *
 * Body: { events: [ <inbound event, see services/agentTelemetry.js> ] }, 1-200 events.
 * Each event is validated on its own: valid events are published to admin telemetry consoles in
 * the order received, invalid ones are dropped and reported back. A partly invalid batch is not
 * refused as a whole, because telemetry is best-effort and one malformed event should not hide
 * the rest of a turn from the console; the rejection details tell the sender what to fix.
 *
 * 200 { data: { accepted, published, rejected: [{ index, field, message }] } }
 *       published < accepted only when the socket server is not running on this instance.
 * 400 the body is not a batch (missing, empty, or too many events).
 *
 * Nothing is stored; see services/agentTelemetry.js for why.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { AGENT_TELEMETRY_MESSAGES } from '../constants/messages.js';
import { TELEMETRY_LIMITS, normalizeTelemetryEvent } from '../services/agentTelemetry.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import { emitAgentTelemetryEvents } from '../utils/socketManager.js';

export function ingestAgentTelemetry(req, res, next) {
  try {
    const rawEvents = req.body?.events;
    if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, AGENT_TELEMETRY_MESSAGES.BATCH_INVALID, [
        { field: 'events', message: `must be a list of 1-${TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH} events` },
      ]);
    }

    const receivedAtMs = Date.now();
    const acceptedEvents = [];
    const rejectedEvents = [];
    rawEvents.forEach((rawEvent, eventIndex) => {
      const normalization = normalizeTelemetryEvent(rawEvent, receivedAtMs);
      if (normalization.ok) acceptedEvents.push(normalization.event);
      else rejectedEvents.push({ index: eventIndex, field: normalization.field, message: normalization.message });
    });

    const publishedCount = emitAgentTelemetryEvents(acceptedEvents);
    if (rejectedEvents.length > 0) {
      // A rejection is a sender bug, worth seeing in logs, but at most a sample per batch.
      logger.warn('Agent telemetry events rejected', {
        requestId: req.id,
        rejectedCount: rejectedEvents.length,
        sample: rejectedEvents.slice(0, 3),
      });
    }
    return sendSuccess(res, HTTP_STATUS.OK, AGENT_TELEMETRY_MESSAGES.EVENTS_ACCEPTED, {
      accepted: acceptedEvents.length,
      published: publishedCount,
      rejected: rejectedEvents.slice(0, TELEMETRY_LIMITS.MAX_REJECTION_DETAILS),
    });
  } catch (error) {
    return next(error);
  }
}
