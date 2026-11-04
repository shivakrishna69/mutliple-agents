/**
 * Presence over Socket.IO (services/presence.js has the rules).
 *
 *   Client -> server   PRESENCE_REPORT { activity: "active" | "idle" }, ack -> { ok: true, status } |
 *                      { ok: false, error: { code, message } }
 *                        Sent by every open app when its device's activity changes and about once
 *                        a minute. Refused (PRESENCE_NOT_RECORDED) while the person's presence is
 *                        not recorded: notice not acknowledged, or presence switched off.
 *                      SUBSCRIBE_PRESENCE (no payload), ack -> { ok: true, scope } | { ok: false, error }
 *                        HR and administrators follow everyone, managers their reports; anyone else
 *                        is refused (PRESENCE_FORBIDDEN). Load the current statuses over HTTP
 *                        (GET /api/presence/now) after subscribing, and subscribe again after
 *                        reconnecting.
 *   Server -> client   PRESENCE_UPDATED { userId, employeeId, status, since } to the person, their
 *                      manager's subscribers, and HR and administrators'.
 *
 * A person's status combines what each of their sockets last reported (socket.data.presence),
 * read across every server with fetchSockets. A socket that disconnects is recounted the same way.
 */

import { SOCKET_MESSAGES } from '../../constants/messages.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import {
  combineDeviceActivity,
  describePresenceChange,
  DEVICE_ACTIVITY,
  recordPresence,
} from '../../services/presence.js';
import { isPresenceRecorded } from '../../services/presenceSettings.js';
import { TEAM_SCOPES } from '../../services/teamRoster.js';
import { isWorkforceAdmin } from '../../services/workforceAccess.js';
import { logger } from '../logger.js';
import { consumeEventBudget, createEventWindow } from './eventBudget.js';
import { ROOM_NAMES, SOCKET_ERROR_CODES, SOCKET_EVENTS, SOCKET_SERVER_SETTINGS } from './socketProtocol.js';

const errorAck = (code, message) => ({ ok: false, error: { code, message } });

/**
 * Sends a change to the person, HR and administrators, and the person's manager.
 * @param {import('socket.io').Server | import('socket.io').Namespace} target
 * @param {{ update: object, reportingManagerId: string|null }} change  services/presence.js describePresenceChange
 */
export function emitPresenceChange(target, { update, reportingManagerId }) {
  let audience = target.to(ROOM_NAMES.user(update.userId)).to(ROOM_NAMES.presenceOrganisation());
  if (reportingManagerId) audience = audience.to(ROOM_NAMES.presenceTeam(reportingManagerId));
  audience.emit(SOCKET_EVENTS.PRESENCE_UPDATED, update);
}

/** Recounts a person's status from their connected sockets, records it, and publishes a change. */
async function refreshPresence(namespace, userId) {
  const userSockets = await namespace.in(ROOM_NAMES.user(userId)).fetchSockets();
  const deviceActivities = userSockets.map((userSocket) => userSocket.data.presence?.activity).filter(Boolean);
  const result = await recordPresence({ userId, status: combineDeviceActivity(deviceActivities) });
  if (result.changed) emitPresenceChange(namespace, await describePresenceChange(userId, result));
  return result;
}

/** Whether the person's presence is recorded; a yes is kept for PRESENCE_TRACKING_RECHECK_MS. */
async function isRecorded(connectionRecord) {
  const { presenceCheck } = connectionRecord;
  if (presenceCheck && Date.now() - presenceCheck.checkedAtMs < SOCKET_SERVER_SETTINGS.PRESENCE_TRACKING_RECHECK_MS) {
    return true;
  }
  const isTracked = await isPresenceRecorded(connectionRecord.userId);
  connectionRecord.presenceCheck = isTracked ? { checkedAtMs: Date.now() } : null;
  return isTracked;
}

/** The presence room the user may follow, or null. */
async function presenceRoomFor(user) {
  if (isWorkforceAdmin(user.role)) return { scope: TEAM_SCOPES.ORGANISATION, room: ROOM_NAMES.presenceOrganisation() };
  const ownProfile = await EmployeeProfile.findOne({ userId: user.id }).select('_id').lean();
  const hasReports =
    ownProfile &&
    (await EmployeeProfile.exists({
      'organizationData.reportingManagerId': ownProfile._id,
      'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
    }));
  return hasReports
    ? { scope: TEAM_SCOPES.DIRECT_REPORTS, room: ROOM_NAMES.presenceTeam(ownProfile._id.toString()) }
    : null;
}

/** Registers PRESENCE_REPORT, SUBSCRIBE_PRESENCE and the recount on disconnect for one socket. */
export function registerPresenceHandlers(socket, connectionRecord) {
  const { user } = socket.data;
  connectionRecord.presenceWindow = createEventWindow();
  connectionRecord.presenceCheck = null;
  const eventContext = () => ({ socketId: socket.id, userId: user.id });
  const withinBudget = () =>
    consumeEventBudget(connectionRecord.presenceWindow, {
      windowMs: SOCKET_SERVER_SETTINGS.PRESENCE_REPORT_WINDOW_MS,
      limit: SOCKET_SERVER_SETTINGS.PRESENCE_REPORTS_PER_WINDOW,
    });

  socket.on(SOCKET_EVENTS.PRESENCE_REPORT, async (eventPayload, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!withinBudget()) {
      logger.warn('Socket event rate limited', { ...eventContext(), event: SOCKET_EVENTS.PRESENCE_REPORT });
      return respond(errorAck(SOCKET_ERROR_CODES.RATE_LIMITED, SOCKET_MESSAGES.RATE_LIMITED));
    }
    const activity = eventPayload?.activity;
    if (!Object.values(DEVICE_ACTIVITY).includes(activity)) {
      return respond(errorAck(SOCKET_ERROR_CODES.INVALID_PAYLOAD, SOCKET_MESSAGES.INVALID_PAYLOAD));
    }
    try {
      if (!(await isRecorded(connectionRecord))) {
        socket.data.presence = null;
        return respond(errorAck(SOCKET_ERROR_CODES.PRESENCE_NOT_RECORDED, SOCKET_MESSAGES.PRESENCE_NOT_RECORDED));
      }
      if (socket.disconnected) return undefined;
      socket.data.presence = { activity, reportedAtMs: Date.now() };
      const { status } = await refreshPresence(socket.nsp, user.id);
      return respond({ ok: true, status });
    } catch (reportError) {
      logger.error('Presence report failed', {
        ...eventContext(),
        error: { name: reportError.name, message: reportError.message, stack: reportError.stack },
      });
      return respond(errorAck(SOCKET_ERROR_CODES.SERVER_ERROR, SOCKET_MESSAGES.SERVER_ERROR));
    }
  });

  // No payload: a client may emit just the acknowledgement callback, which then arrives first.
  socket.on(SOCKET_EVENTS.SUBSCRIBE_PRESENCE, async (...eventArguments) => {
    const respond = eventArguments.findLast((argument) => typeof argument === 'function') ?? (() => {});
    if (!withinBudget()) return respond(errorAck(SOCKET_ERROR_CODES.RATE_LIMITED, SOCKET_MESSAGES.RATE_LIMITED));
    try {
      const subscription = await presenceRoomFor(user);
      if (!subscription) {
        return respond(errorAck(SOCKET_ERROR_CODES.PRESENCE_FORBIDDEN, SOCKET_MESSAGES.PRESENCE_FORBIDDEN));
      }
      if (socket.disconnected) return undefined;
      await socket.join(subscription.room);
      return respond({ ok: true, scope: subscription.scope });
    } catch (subscribeError) {
      logger.error('Presence subscription failed', {
        ...eventContext(),
        error: { name: subscribeError.name, message: subscribeError.message, stack: subscribeError.stack },
      });
      return respond(errorAck(SOCKET_ERROR_CODES.SERVER_ERROR, SOCKET_MESSAGES.SERVER_ERROR));
    }
  });

  // After Socket.IO has removed the socket from its rooms, so the recount sees the others only.
  socket.on('disconnect', () => {
    if (!socket.data.presence) return;
    refreshPresence(socket.nsp, user.id).catch((recountError) =>
      logger.error('Presence recount after disconnect failed', {
        ...eventContext(),
        error: { name: recountError.name, message: recountError.message },
      }),
    );
  });
}
