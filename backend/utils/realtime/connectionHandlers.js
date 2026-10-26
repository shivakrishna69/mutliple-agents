/**
 * Per-connection behaviour: the registry of active connections, joining and leaving
 * conversation rooms, the agent telemetry subscription, per-socket limits and session expiry.
 */

import Conversation from '../../models/Conversation.js';
import { ROLES } from '../../models/User.js';
import { AGENT_TELEMETRY_EVENTS } from '../../services/agentTelemetry.js';
import { SOCKET_MESSAGES } from '../../constants/messages.js';
import { canUserAccessConversation, isStaffRole } from '../../services/conversationAccess.js';
import { logger } from '../logger.js';
import { toCustomerConversationStatusPayload, toStaffConversationStatusPayload } from '../realtimePayloads.js';
import {
  CONVERSATION_ROOM_PREFIX,
  MAX_TIMER_DELAY_MS,
  OBJECT_ID_PATTERN,
  ROOM_NAMES,
  SOCKET_ERROR_CODES,
  SOCKET_EVENTS,
  SOCKET_SERVER_SETTINGS,
} from './socketProtocol.js';

/**
 * socketId -> {
 *   userId, role, sessionId, transport, connectedAtMs, lastHeartbeatAtMs,
 *   roomEventWindow: { eventCount, windowStartedAtMs },
 *   sessionExpiryTimer: NodeJS.Timeout | null
 * }
 * Created on connection, deleted on disconnect; see "Memory management" above.
 * Room membership is deliberately not duplicated here: it is read from `socket.rooms`.
 */
export const activeClientConnections = new Map();

/** Number of conversation rooms this socket is in, read from Socket.IO's own room state. */
export function countJoinedConversations(socket) {
  let joinedConversationCount = 0;
  for (const roomName of socket.rooms) {
    if (roomName.startsWith(CONVERSATION_ROOM_PREFIX)) joinedConversationCount += 1;
  }
  return joinedConversationCount;
}

function buildErrorAck(errorCode, message) {
  return { ok: false, error: { code: errorCode, message } };
}

/** Returns the conversation id from a join/leave payload, or null if it is not a valid ObjectId string. */
function extractConversationId(eventPayload) {
  const isPlainObject = typeof eventPayload === 'object' && eventPayload !== null && !Array.isArray(eventPayload);
  if (!isPlainObject) return null;
  const { conversationId } = eventPayload;
  return typeof conversationId === 'string' && OBJECT_ID_PATTERN.test(conversationId)
    ? conversationId.toLowerCase()
    : null;
}

/** Fixed-window limit on join/leave events per socket. Returns false when the budget is spent. */
function consumeRoomEventBudget(connectionRecord) {
  const currentTimeMs = Date.now();
  const { roomEventWindow } = connectionRecord;
  if (currentTimeMs - roomEventWindow.windowStartedAtMs >= SOCKET_SERVER_SETTINGS.ROOM_EVENT_WINDOW_MS) {
    roomEventWindow.windowStartedAtMs = currentTimeMs;
    roomEventWindow.eventCount = 0;
  }
  roomEventWindow.eventCount += 1;
  return roomEventWindow.eventCount <= SOCKET_SERVER_SETTINGS.ROOM_EVENTS_PER_WINDOW;
}

/** Tells the client why, then disconnects it. Used for session expiry and logout. */
function endSocketSession(socket, errorCode) {
  socket.emit(SOCKET_EVENTS.SESSION_ENDED, { code: errorCode, message: SOCKET_MESSAGES.SESSION_ENDED });
  socket.disconnect(true);
}

/**
 * Disconnects the socket when its session's JWT expires. Delays longer than setTimeout's
 * maximum are split: the timer re-arms itself until the real expiry time is reached.
 */
function scheduleSessionExpiry(socket, connectionRecord, expiresAtMs) {
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs <= 0) {
    logger.info('Socket session expired', { socketId: socket.id, userId: connectionRecord.userId });
    endSocketSession(socket, SOCKET_ERROR_CODES.SESSION_EXPIRED);
    return;
  }
  connectionRecord.sessionExpiryTimer = setTimeout(
    () => scheduleSessionExpiry(socket, connectionRecord, expiresAtMs),
    Math.min(remainingMs, MAX_TIMER_DELAY_MS),
  );
  connectionRecord.sessionExpiryTimer.unref();
}

/** Registers JOIN_CONVERSATION and LEAVE_CONVERSATION for one socket. */
function registerConversationHandlers(socket, connectionRecord) {
  const { user } = socket.data;
  const isStaffSocket = isStaffRole(user.role);

  socket.on(SOCKET_EVENTS.JOIN_CONVERSATION, async (eventPayload, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    const eventContext = { socketId: socket.id, userId: user.id, role: user.role };

    if (!consumeRoomEventBudget(connectionRecord)) {
      logger.warn('Socket event rate limited', { ...eventContext, event: SOCKET_EVENTS.JOIN_CONVERSATION });
      return respond(buildErrorAck(SOCKET_ERROR_CODES.RATE_LIMITED, SOCKET_MESSAGES.RATE_LIMITED));
    }

    const conversationId = extractConversationId(eventPayload);
    if (!conversationId) {
      return respond(buildErrorAck(SOCKET_ERROR_CODES.INVALID_PAYLOAD, SOCKET_MESSAGES.INVALID_PAYLOAD));
    }
    const roomName = isStaffSocket
      ? ROOM_NAMES.conversationStaff(conversationId)
      : ROOM_NAMES.conversationCustomer(conversationId);
    if (
      !socket.rooms.has(roomName) &&
      countJoinedConversations(socket) >= SOCKET_SERVER_SETTINGS.MAX_JOINED_CONVERSATIONS_PER_SOCKET
    ) {
      return respond(buildErrorAck(SOCKET_ERROR_CODES.TOO_MANY_ROOMS, SOCKET_MESSAGES.TOO_MANY_ROOMS));
    }

    try {
      // Checked against the database on every join, so access reflects the current assignee.
      const conversationRecord = await Conversation.findById(conversationId)
        .select('_id customerId assignedAgentId status currentActiveWorker updatedAt')
        .lean();
      if (!conversationRecord || !canUserAccessConversation(user, conversationRecord)) {
        logger.warn('Conversation join denied', {
          ...eventContext,
          conversationId,
          conversationExists: Boolean(conversationRecord),
        });
        return respond(
          buildErrorAck(SOCKET_ERROR_CODES.CONVERSATION_NOT_ACCESSIBLE, SOCKET_MESSAGES.CONVERSATION_NOT_ACCESSIBLE),
        );
      }
      // The client may have disconnected during the database read; joining now would be a no-op leak.
      if (socket.disconnected) return undefined;

      await socket.join(roomName);

      logger.info('Conversation joined', { ...eventContext, conversationId, room: roomName });
      const staffStatusPayload = toStaffConversationStatusPayload(conversationRecord);
      return respond({
        ok: true,
        conversation: isStaffSocket ? staffStatusPayload : toCustomerConversationStatusPayload(staffStatusPayload),
      });
    } catch (joinError) {
      logger.error('Conversation join failed', {
        ...eventContext,
        conversationId,
        error: { name: joinError.name, message: joinError.message, stack: joinError.stack },
      });
      return respond(buildErrorAck(SOCKET_ERROR_CODES.SERVER_ERROR, SOCKET_MESSAGES.SERVER_ERROR));
    }
  });

  socket.on(SOCKET_EVENTS.LEAVE_CONVERSATION, async (eventPayload, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    const eventContext = { socketId: socket.id, userId: user.id, role: user.role };

    if (!consumeRoomEventBudget(connectionRecord)) {
      logger.warn('Socket event rate limited', { ...eventContext, event: SOCKET_EVENTS.LEAVE_CONVERSATION });
      return respond(buildErrorAck(SOCKET_ERROR_CODES.RATE_LIMITED, SOCKET_MESSAGES.RATE_LIMITED));
    }
    const conversationId = extractConversationId(eventPayload);
    if (!conversationId) {
      return respond(buildErrorAck(SOCKET_ERROR_CODES.INVALID_PAYLOAD, SOCKET_MESSAGES.INVALID_PAYLOAD));
    }

    try {
      const staffRoomName = ROOM_NAMES.conversationStaff(conversationId);
      const customerRoomName = ROOM_NAMES.conversationCustomer(conversationId);
      const wasJoined = socket.rooms.has(staffRoomName) || socket.rooms.has(customerRoomName);
      await socket.leave(staffRoomName);
      await socket.leave(customerRoomName);
      if (wasJoined) logger.info('Conversation left', { ...eventContext, conversationId });
      return respond({ ok: true });
    } catch (leaveError) {
      logger.error('Conversation leave failed', {
        ...eventContext,
        conversationId,
        error: { name: leaveError.name, message: leaveError.message, stack: leaveError.stack },
      });
      return respond(buildErrorAck(SOCKET_ERROR_CODES.SERVER_ERROR, SOCKET_MESSAGES.SERVER_ERROR));
    }
  });
}

/** Registers SUBSCRIBE_AGENT_TELEMETRY and UNSUBSCRIBE_AGENT_TELEMETRY for one socket. */
function registerAgentTelemetryHandlers(socket, connectionRecord) {
  const { user } = socket.data;
  const telemetryRoomName = ROOM_NAMES.agentTelemetry();

  socket.on(SOCKET_EVENTS.SUBSCRIBE_AGENT_TELEMETRY, async (_eventPayload, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    const eventContext = { socketId: socket.id, userId: user.id, role: user.role };

    if (!consumeRoomEventBudget(connectionRecord)) {
      logger.warn('Socket event rate limited', { ...eventContext, event: SOCKET_EVENTS.SUBSCRIBE_AGENT_TELEMETRY });
      return respond(buildErrorAck(SOCKET_ERROR_CODES.RATE_LIMITED, SOCKET_MESSAGES.RATE_LIMITED));
    }
    if (user.role !== ROLES.ADMIN) {
      logger.warn('Agent telemetry subscription denied', eventContext);
      return respond(buildErrorAck(SOCKET_ERROR_CODES.TELEMETRY_FORBIDDEN, SOCKET_MESSAGES.TELEMETRY_FORBIDDEN));
    }
    try {
      await socket.join(telemetryRoomName);
      logger.info('Agent telemetry subscribed', eventContext);
      return respond({ ok: true, events: Object.values(AGENT_TELEMETRY_EVENTS) });
    } catch (subscribeError) {
      logger.error('Agent telemetry subscription failed', {
        ...eventContext,
        error: { name: subscribeError.name, message: subscribeError.message, stack: subscribeError.stack },
      });
      return respond(buildErrorAck(SOCKET_ERROR_CODES.SERVER_ERROR, SOCKET_MESSAGES.SERVER_ERROR));
    }
  });

  socket.on(SOCKET_EVENTS.UNSUBSCRIBE_AGENT_TELEMETRY, async (_eventPayload, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!consumeRoomEventBudget(connectionRecord)) {
      return respond(buildErrorAck(SOCKET_ERROR_CODES.RATE_LIMITED, SOCKET_MESSAGES.RATE_LIMITED));
    }
    try {
      await socket.leave(telemetryRoomName);
      return respond({ ok: true });
    } catch (unsubscribeError) {
      logger.error('Agent telemetry unsubscribe failed', {
        socketId: socket.id,
        error: { name: unsubscribeError.name, message: unsubscribeError.message },
      });
      return respond(buildErrorAck(SOCKET_ERROR_CODES.SERVER_ERROR, SOCKET_MESSAGES.SERVER_ERROR));
    }
  });
}

/** Connection handler: registers state, rooms, timers, handlers, and the disconnect cleanup. */
export function handleSocketConnection(socket) {
  const { user, session } = socket.data;

  const connectionRecord = {
    userId: user.id,
    role: user.role,
    sessionId: session.sessionId,
    transport: socket.conn.transport.name,
    connectedAtMs: Date.now(),
    lastHeartbeatAtMs: Date.now(),
    roomEventWindow: { eventCount: 0, windowStartedAtMs: Date.now() },
    sessionExpiryTimer: null,
  };
  activeClientConnections.set(socket.id, connectionRecord);

  socket.join(ROOM_NAMES.session(session.sessionId));
  socket.join(ROOM_NAMES.user(user.id));
  if (isStaffRole(user.role)) socket.join(ROOM_NAMES.staffLobby());

  logger.info('Socket connected', {
    socketId: socket.id,
    userId: user.id,
    role: user.role,
    transport: connectionRecord.transport,
    remoteAddress: socket.handshake.address,
    activeConnections: activeClientConnections.size,
  });

  // Engine.IO emits "heartbeat" each time the client answers a ping.
  socket.conn.on('heartbeat', () => {
    connectionRecord.lastHeartbeatAtMs = Date.now();
  });
  socket.conn.on('upgrade', (upgradedTransport) => {
    connectionRecord.transport = upgradedTransport.name;
    logger.debug('Socket transport upgraded', { socketId: socket.id, transport: upgradedTransport.name });
  });

  scheduleSessionExpiry(socket, connectionRecord, session.expiresAtMs);
  registerConversationHandlers(socket, connectionRecord);
  registerAgentTelemetryHandlers(socket, connectionRecord);

  socket.on('error', (socketError) => {
    logger.error('Socket error', {
      socketId: socket.id,
      userId: user.id,
      error: { name: socketError.name, message: socketError.message },
    });
  });

  // "disconnecting" fires while the socket is still in its rooms; "disconnect" fires after
  // Socket.IO has removed it from all of them, so the room count is captured here.
  let joinedConversationCountAtDisconnect = 0;
  socket.on('disconnecting', () => {
    joinedConversationCountAtDisconnect = countJoinedConversations(socket);
  });

  // Called exactly once per socket, for every cause: client close, ping timeout, transport
  // error, server-side disconnect. Rooms are left automatically by Socket.IO.
  socket.on('disconnect', (disconnectReason) => {
    if (connectionRecord.sessionExpiryTimer) clearTimeout(connectionRecord.sessionExpiryTimer);
    activeClientConnections.delete(socket.id);
    const isStaleConnection = disconnectReason === 'ping timeout';
    (isStaleConnection ? logger.warn : logger.info)('Socket disconnected', {
      socketId: socket.id,
      userId: user.id,
      role: user.role,
      reason: disconnectReason,
      connectedForMs: Date.now() - connectionRecord.connectedAtMs,
      msSinceLastHeartbeat: Date.now() - connectionRecord.lastHeartbeatAtMs,
      joinedConversationCount: joinedConversationCountAtDisconnect,
      activeConnections: activeClientConnections.size,
    });
  });
}
