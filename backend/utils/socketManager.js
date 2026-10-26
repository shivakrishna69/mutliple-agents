/**
 * Real-time delivery over Socket.IO: one server per process, created by `initSocketServer`
 * and reached elsewhere through `getSocketIoInstance` or the emit helpers below.
 *
 * ============================================================================
 * Real-time pub/sub synchronisation pattern
 * ============================================================================
 *
 * The database is the source of truth; sockets only carry notifications of changes that have
 * already been committed. Writers (the webhook pipeline today, agent actions later) save to
 * MongoDB first and then publish through `emitNewMessage` / `emitConversationStatusUpdate`.
 * A client that misses an event (offline, reconnecting) loses nothing: it reloads the current
 * state over HTTP and resumes listening. Events are never the only copy of data.
 *
 * Rooms are the subscription mechanism. A socket subscribes by joining a room; a publisher
 * targets a room and Socket.IO fans the event out to its members:
 *
 *   session:<sessionId>               every socket opened with one login session; used to
 *                                     disconnect them all at once on logout.
 *   user:<userId>                     every socket of one user; used to end them after a role or
 *                                     password change.
 *   staff                             every admin/agent socket; receives every conversation's
 *                                     status changes so queue views stay current.
 *   conversation:<id>:staff           admins/agents viewing one conversation; full payloads.
 *   conversation:<id>:customer        the owning customer's sockets; customer-safe payloads.
 *   agent-telemetry                   admin sockets that asked for live agent telemetry (see
 *                                     "Agent telemetry channel" below).
 *
 * Splitting each conversation into a staff room and a customer room means one publish call can
 * send full payloads (AI tool logs, routing, agent ids) to staff and a reduced payload to the
 * customer, without per-socket filtering (see utils/realtimePayloads.js).
 *
 * ============================================================================
 * Event flow
 * ============================================================================
 *
 *   Handshake   1. allowRequest: the Origin header must be in CORS_ORIGINS. Browsers attach
 *                  cookies to cross-site WebSocket upgrades and CORS does not apply to them, so
 *                  without this check any website could open a socket with a visitor's session
 *                  (cross-site WebSocket hijacking).
 *               2. io.use authentication: the HttpOnly access_token cookie is verified with the
 *                  same code as HTTP requests (services/sessionAuthenticator.js): signature,
 *                  expiry, claims, revocation, account existence. Failure rejects the connection
 *                  with `connect_error`, whose `data` is { code, message }.
 *   Connection  3. The socket joins its session room and, for staff, the staff room. A timer is
 *                  set to end the socket when the session's JWT expires.
 *   Client ->   JOIN_CONVERSATION  { conversationId }, ack -> { ok: true, conversation } |
 *   server                         { ok: false, error: { code, message } }
 *                  Access is checked against the database on every join
 *                  (services/conversationAccess.js); "not found" and "not allowed" share one
 *                  answer so conversation ids cannot be probed.
 *               LEAVE_CONVERSATION { conversationId }, ack -> { ok: true } | { ok: false, error }
 *   Server ->   NEW_MESSAGE                    a message was stored in a joined conversation
 *   client      CONVERSATION_STATUS_UPDATED    status / worker / assignee changed
 *               CONVERSATION_ACCESS_REVOKED    this socket was removed from a conversation room
 *                                              (e.g. another agent claimed it)
 *               SESSION_ENDED                  the session expired or was logged out; the socket
 *                                              is disconnected right after
 *
 * ============================================================================
 * Agent telemetry channel
 * ============================================================================
 *
 * A live, opt-in feed of how the AI agents are working (graph nodes, model call timings, tool
 * runs, retrieval scores), for operations consoles. Contract and privacy rules are in
 * services/agentTelemetry.js; the events carry metrics and identifiers, never conversation text.
 *
 *   Client ->   SUBSCRIBE_AGENT_TELEMETRY    (no payload), ack -> { ok: true, events: [names] } |
 *   server                                   { ok: false, error: { code, message } }
 *                  Admins only: any other role gets TELEMETRY_FORBIDDEN. The role is the one
 *                  verified at handshake; a role change disconnects the user's sockets (see
 *                  disconnectUserSockets), so a demoted admin cannot keep the feed.
 *               UNSUBSCRIBE_AGENT_TELEMETRY  ack -> { ok: true }
 *               Both count against the same per-socket event budget as conversation joins.
 *   Server ->   AGENT_THINKING_EVENT         a turn, node, model call or retrieval started/finished
 *   client      TOOL_EXECUTION_STARTED       a tool began running (pairs with COMPLETED by runId)
 *               TOOL_EXECUTION_COMPLETED     the tool finished, with status and duration
 *
 * Events are sent with normal (buffered) delivery, not `volatile`: a turn emits its events in a
 * burst, and a volatile emit is dropped whenever the transport is busy writing the previous
 * frame, which loses most of a burst. A console that stops reading cannot grow its buffer for
 * long: the heartbeat disconnects it within PING_INTERVAL_MS + PING_TIMEOUT_MS and Socket.IO
 * frees the buffer. Delivery is still at-most-once (events sent while a client is disconnected
 * are not replayed), so consoles should treat per-turn sequence gaps as possible. After
 * reconnecting, a client must subscribe again, because rooms are not restored on a new connection.
 *
 * ============================================================================
 * Heartbeat and connection resiliency
 * ============================================================================
 *
 * Engine.IO's built-in heartbeat is used: the server sends a ping every PING_INTERVAL_MS and
 * the client must answer within PING_TIMEOUT_MS, otherwise the connection is closed with reason
 * "ping timeout". This detects dead peers that never sent a TCP close (mobile network drops,
 * sleeping laptops), which TCP alone may not notice for many minutes. The last heartbeat time
 * of each socket is tracked for telemetry. Clients reconnect automatically (socket.io-client
 * default) and must re-join their conversations after reconnecting.
 *
 * ============================================================================
 * Memory management for connection and room state
 * ============================================================================
 *
 *   - Room membership is owned by Socket.IO and is removed automatically when a socket
 *     disconnects; this module never keeps its own copy of room membership across sockets.
 *   - `activeClientConnections` holds one small record per connected socket (user id, role,
 *     rate-limit window, expiry timer). The record is created in the
 *     connection handler and deleted in the disconnect handler, which Socket.IO guarantees to
 *     call exactly once per socket, including after ping timeouts. Its size therefore always
 *     equals the number of live sockets on this process.
 *   - Per-socket timers (session expiry) are cleared on disconnect, so no closure keeps a
 *     disconnected socket reachable.
 *   - Each socket may join at most MAX_JOINED_CONVERSATIONS_PER_SOCKET conversations and send
 *     at most ROOM_EVENTS_PER_WINDOW join/leave events per window, so one client cannot grow
 *     server memory or database load without bound. maxHttpBufferSize caps inbound frame size.
 *
 * ============================================================================
 * Scaling out: Redis adapter
 * ============================================================================
 *
 * When REDIS_URL is set, rooms are shared across every backend instance through
 * @socket.io/redis-adapter. Two dedicated Redis connections are opened:
 *   publisher   sends each broadcast (and cross-instance requests such as fetchSockets and
 *               disconnectSockets) to a Redis pub/sub channel;
 *   subscriber  receives other instances' broadcasts and delivers them to this instance's
 *               local sockets. A connection in subscribe mode cannot issue normal commands,
 *               which is why the two are separate.
 * A publish on any instance therefore reaches the room's members on every instance. All room
 * operations in this module go through adapter-aware APIs (to/in/emit, join/leave,
 * fetchSockets, disconnectSockets, socket.rooms), so behaviour is identical with one instance
 * or many. Per-socket bookkeeping that must stay correct when another instance changes a
 * socket's rooms (for example access revocation) is read from `socket.rooms`, which the adapter
 * keeps current, rather than from a separate local copy.
 *
 * Startup fails if REDIS_URL is set but Redis cannot be reached within REDIS_CONNECT_TIMEOUT_MS,
 * so an instance never runs isolated while its peers think it is part of the cluster. After
 * startup, a Redis outage is logged and node-redis reconnects with capped backoff; during the
 * outage, broadcasts reach only local sockets. Without REDIS_URL the default in-memory adapter
 * is used, which is correct for exactly one instance.
 *
 * Load balancers must use sticky sessions while the long-polling transport is enabled, because
 * a polling session's consecutive HTTP requests must reach the same instance.
 *
 * Code layout: this module owns the server instance, its lifecycle and the publishing helpers
 * that controllers call. realtime/socketProtocol.js holds the event names, codes, settings and
 * room names; realtime/handshake.js the handshake authentication; realtime/connectionHandlers.js
 * the per-connection handlers and connection registry; realtime/redisAdapterClients.js the
 * adapter's Redis connections.
 */

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { SOCKET_MESSAGES } from '../constants/messages.js';
import { canUserAccessConversation } from '../services/conversationAccess.js';
import { ROOM_NAMES, SOCKET_ERROR_CODES, SOCKET_EVENTS, SOCKET_SERVER_SETTINGS } from './realtime/socketProtocol.js';
import {
  activeClientConnections,
  countJoinedConversations,
  handleSocketConnection,
} from './realtime/connectionHandlers.js';
import { connectRedisAdapterClients } from './realtime/redisAdapterClients.js';
import { createHandshakeAuthenticator } from './realtime/handshake.js';
import { logger } from './logger.js';
import { toCustomerConversationStatusPayload, toCustomerMessagePayload } from './realtimePayloads.js';

// Part of this module's public interface since before the split into ./realtime/.
export { SOCKET_ERROR_CODES, SOCKET_EVENTS, SOCKET_SERVER_SETTINGS } from './realtime/socketProtocol.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {Server | null} */
let socketIoInstance = null;
let telemetryTimer = null;

/** Redis connections used by the adapter; null when running with the in-memory adapter. */
let redisAdapterClients = null;

function logTelemetry() {
  const connectionsByRole = {};
  let joinedConversationRoomCount = 0;
  for (const connectionRecord of activeClientConnections.values()) {
    connectionsByRole[connectionRecord.role] = (connectionsByRole[connectionRecord.role] ?? 0) + 1;
  }
  // Local sockets only: this instance's telemetry describes this instance.
  for (const localSocket of socketIoInstance?.of('/').sockets.values() ?? []) {
    joinedConversationRoomCount += countJoinedConversations(localSocket);
  }
  logger.info('Socket telemetry', {
    activeConnections: activeClientConnections.size,
    connectionsByRole,
    joinedConversationRoomCount,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Attaches Socket.IO to the HTTP server, with the Redis adapter when `config.redisUrl` is set.
 * Call once and await it before `httpServer.listen`. Rejects if Redis is configured but
 * unreachable, in which case nothing is attached.
 * @param {import('node:http').Server} httpServer
 * @param {{ corsOrigins: string[], jwtSecret: string, cookieSecure: boolean, redisUrl: string | null }} config
 * @returns {Promise<Server>}
 */
export async function initSocketServer(httpServer, config) {
  if (socketIoInstance) {
    throw new Error('initSocketServer was called more than once');
  }

  // Connect Redis before creating the server, so a failure leaves no half-initialised state.
  if (config.redisUrl) {
    redisAdapterClients = await connectRedisAdapterClients(config.redisUrl);
  }

  const allowedOrigins = new Set(config.corsOrigins);

  socketIoInstance = new Server(httpServer, {
    path: SOCKET_SERVER_SETTINGS.PATH,
    serveClient: false,
    // WebSocket first; long-polling remains as a fallback for networks that block upgrades.
    transports: ['websocket', 'polling'],
    cors: { origin: config.corsOrigins, credentials: true, methods: ['GET', 'POST'] },
    // Runs before any handshake. Requires a browser Origin from CORS_ORIGINS; see "Event flow".
    allowRequest: (handshakeRequest, decide) => {
      const requestOrigin = handshakeRequest.headers.origin;
      const isOriginAllowed = typeof requestOrigin === 'string' && allowedOrigins.has(requestOrigin);
      if (!isOriginAllowed) {
        logger.warn('Socket handshake rejected', {
          reason: SOCKET_ERROR_CODES.ORIGIN_NOT_ALLOWED,
          origin: requestOrigin ?? null,
        });
      }
      decide(isOriginAllowed ? null : SOCKET_MESSAGES.ORIGIN_NOT_ALLOWED, isOriginAllowed);
    },
    pingInterval: SOCKET_SERVER_SETTINGS.PING_INTERVAL_MS,
    pingTimeout: SOCKET_SERVER_SETTINGS.PING_TIMEOUT_MS,
    connectTimeout: SOCKET_SERVER_SETTINGS.CONNECT_TIMEOUT_MS,
    maxHttpBufferSize: SOCKET_SERVER_SETTINGS.MAX_HTTP_BUFFER_BYTES,
    // Engine.IO's own "io" cookie is only for sticky sessions; it is not needed and not set.
    cookie: false,
  });

  if (redisAdapterClients) {
    socketIoInstance.adapter(
      createAdapter(redisAdapterClients.publisherClient, redisAdapterClients.subscriberClient, {
        requestsTimeout: SOCKET_SERVER_SETTINGS.REDIS_ADAPTER_REQUESTS_TIMEOUT_MS,
      }),
    );
  }

  socketIoInstance.use(createHandshakeAuthenticator(config));
  socketIoInstance.on('connection', handleSocketConnection);

  socketIoInstance.engine.on('connection_error', (engineError) => {
    logger.warn('Socket transport connection error', {
      code: engineError.code,
      message: engineError.message,
      origin: engineError.req?.headers?.origin ?? null,
    });
  });

  telemetryTimer = setInterval(logTelemetry, SOCKET_SERVER_SETTINGS.TELEMETRY_INTERVAL_MS);
  telemetryTimer.unref();

  logger.info('Socket server initialised', {
    path: SOCKET_SERVER_SETTINGS.PATH,
    pingIntervalMs: SOCKET_SERVER_SETTINGS.PING_INTERVAL_MS,
    pingTimeoutMs: SOCKET_SERVER_SETTINGS.PING_TIMEOUT_MS,
    adapter: redisAdapterClients ? 'redis' : 'in-memory (single instance only)',
  });
  return socketIoInstance;
}

/**
 * Returns the Socket.IO server. Throws if `initSocketServer` has not run, so a misordered
 * startup fails loudly instead of silently dropping events.
 */
export function getSocketIoInstance() {
  if (!socketIoInstance) {
    throw new Error('Socket server is not initialised; call initSocketServer(httpServer, config) first');
  }
  return socketIoInstance;
}

/**
 * Disconnects every socket and closes Socket.IO, then the Redis adapter connections. Socket.IO
 * also closes the HTTP server it is attached to, which stops new connections and waits for
 * in-flight requests to finish. Redis is closed last because the adapter uses it while
 * Socket.IO shuts down.
 */
export async function closeSocketServer() {
  if (!socketIoInstance) return;
  clearInterval(telemetryTimer);
  telemetryTimer = null;
  const closingInstance = socketIoInstance;
  socketIoInstance = null;
  await closingInstance.close();

  if (redisAdapterClients) {
    const closingRedisClients = [redisAdapterClients.publisherClient, redisAdapterClients.subscriberClient];
    redisAdapterClients = null;
    const closeResults = await Promise.allSettled(closingRedisClients.map((redisClient) => redisClient.close()));
    for (const closeResult of closeResults) {
      if (closeResult.status === 'rejected') {
        logger.warn('Redis adapter connection did not close cleanly', { error: closeResult.reason?.message });
      }
    }
  }

  logger.info('Socket server closed', { remainingConnectionRecords: activeClientConnections.size });
}

// ---------------------------------------------------------------------------
// Publishing helpers (for controllers and ingestion pipelines)
// ---------------------------------------------------------------------------

/**
 * Publishes a stored message to the conversation's subscribers: the full payload to staff,
 * the customer-safe projection to the customer. Never throws; returns false if nothing could
 * be sent (server not initialised, or an unexpected error, which is logged).
 * @param {string|import('mongoose').Types.ObjectId} conversationId
 * @param {ReturnType<import('./realtimePayloads.js').toStaffMessagePayload>} messagePayload
 */
export function emitNewMessage(conversationId, messagePayload) {
  if (!socketIoInstance) {
    logger.debug('Socket server not initialised; NEW_MESSAGE not published', {
      conversationId: String(conversationId),
    });
    return false;
  }
  try {
    const normalizedConversationId = String(conversationId);
    socketIoInstance
      .to(ROOM_NAMES.conversationStaff(normalizedConversationId))
      .emit(SOCKET_EVENTS.NEW_MESSAGE, messagePayload);
    socketIoInstance
      .to(ROOM_NAMES.conversationCustomer(normalizedConversationId))
      .emit(SOCKET_EVENTS.NEW_MESSAGE, toCustomerMessagePayload(messagePayload));
    return true;
  } catch (publishError) {
    logger.error('Failed to publish NEW_MESSAGE', {
      conversationId: String(conversationId),
      error: { name: publishError.name, message: publishError.message, stack: publishError.stack },
    });
    return false;
  }
}

/**
 * Removes staff sockets that may no longer see a conversation (for example, another agent just
 * claimed it) from its staff room and tells each of them why.
 */
async function revokeUnauthorizedConversationMembers(conversationId, staffStatusPayload) {
  const staffRoomName = ROOM_NAMES.conversationStaff(conversationId);
  const roomMembers = await socketIoInstance.in(staffRoomName).fetchSockets();
  for (const memberSocket of roomMembers) {
    const memberUser = memberSocket.data.user;
    if (memberUser && !canUserAccessConversation(memberUser, staffStatusPayload)) {
      // RemoteSocket.leave works for sockets on any instance; the adapter applies it where the
      // socket lives, and that socket's `rooms` reflects the change.
      memberSocket.leave(staffRoomName);
      memberSocket.emit(SOCKET_EVENTS.CONVERSATION_ACCESS_REVOKED, {
        conversationId,
        code: SOCKET_ERROR_CODES.ACCESS_REVOKED,
        message: SOCKET_MESSAGES.ACCESS_REVOKED,
      });
      logger.info('Conversation access revoked', { conversationId, socketId: memberSocket.id, userId: memberUser.id });
    }
  }
}

/**
 * Publishes a conversation state change: the full payload to the conversation's staff room and
 * to every staff socket (queue views), the customer-safe projection to the customer. Before
 * publishing, staff sockets that lost access are removed from the conversation room.
 * Never throws; resolves to false if nothing could be sent.
 * @param {string|import('mongoose').Types.ObjectId} conversationId
 * @param {ReturnType<import('./realtimePayloads.js').toStaffConversationStatusPayload>} statusPayload
 */
export async function emitConversationStatusUpdate(conversationId, statusPayload) {
  if (!socketIoInstance) {
    logger.debug('Socket server not initialised; CONVERSATION_STATUS_UPDATED not published', {
      conversationId: String(conversationId),
    });
    return false;
  }
  const normalizedConversationId = String(conversationId);
  try {
    await revokeUnauthorizedConversationMembers(normalizedConversationId, statusPayload);
    // Chained .to() targets the union of both rooms, so a socket in both receives the event once.
    socketIoInstance
      .to(ROOM_NAMES.conversationStaff(normalizedConversationId))
      .to(ROOM_NAMES.staffLobby())
      .emit(SOCKET_EVENTS.CONVERSATION_STATUS_UPDATED, statusPayload);
    socketIoInstance
      .to(ROOM_NAMES.conversationCustomer(normalizedConversationId))
      .emit(SOCKET_EVENTS.CONVERSATION_STATUS_UPDATED, toCustomerConversationStatusPayload(statusPayload));
    return true;
  } catch (publishError) {
    logger.error('Failed to publish CONVERSATION_STATUS_UPDATED', {
      conversationId: normalizedConversationId,
      error: { name: publishError.name, message: publishError.message, stack: publishError.stack },
    });
    return false;
  }
}

/**
 * Publishes validated telemetry events (services/agentTelemetry.js normalizeTelemetryEvent) to
 * the agent-telemetry room, each under its own event name, in the order given (delivery
 * semantics: see "Agent telemetry channel"). Never throws; returns the number of events handed
 * to Socket.IO.
 * @param {Array<{ eventType: string }>} telemetryEvents
 */
export function emitAgentTelemetryEvents(telemetryEvents) {
  if (!socketIoInstance || telemetryEvents.length === 0) return 0;
  try {
    const telemetryRoom = socketIoInstance.to(ROOM_NAMES.agentTelemetry());
    for (const telemetryEvent of telemetryEvents) {
      telemetryRoom.emit(telemetryEvent.eventType, telemetryEvent);
    }
    return telemetryEvents.length;
  } catch (publishError) {
    logger.error('Failed to publish agent telemetry', {
      eventCount: telemetryEvents.length,
      error: { name: publishError.name, message: publishError.message, stack: publishError.stack },
    });
    return 0;
  }
}

/**
 * Ends every socket opened with a given login session (called on logout), after telling the
 * clients why. Never throws.
 */
export function disconnectSessionSockets(sessionId) {
  if (!socketIoInstance) return;
  try {
    const sessionRoomName = ROOM_NAMES.session(sessionId);
    socketIoInstance.in(sessionRoomName).emit(SOCKET_EVENTS.SESSION_ENDED, {
      code: SOCKET_ERROR_CODES.SESSION_LOGGED_OUT,
      message: SOCKET_MESSAGES.SESSION_ENDED,
    });
    socketIoInstance.in(sessionRoomName).disconnectSockets(true);
  } catch (disconnectError) {
    logger.error('Failed to disconnect session sockets', {
      error: { name: disconnectError.name, message: disconnectError.message, stack: disconnectError.stack },
    });
  }
}

/**
 * Ends every socket of one user, optionally except those opened with one session, after telling
 * the clients why. Used when a role changes (the role cached on each socket is now stale) and on
 * other devices when the password changes. Never throws.
 * @param {string} userId
 * @param {string} endReasonCode  One of SOCKET_ERROR_CODES (ROLE_CHANGED, PASSWORD_CHANGED).
 * @param {{ exceptSessionId?: string }} [options]
 */
export function disconnectUserSockets(userId, endReasonCode, { exceptSessionId } = {}) {
  if (!socketIoInstance) return;
  try {
    const userSockets = exceptSessionId
      ? socketIoInstance.in(ROOM_NAMES.user(userId)).except(ROOM_NAMES.session(exceptSessionId))
      : socketIoInstance.in(ROOM_NAMES.user(userId));
    userSockets.emit(SOCKET_EVENTS.SESSION_ENDED, { code: endReasonCode, message: SOCKET_MESSAGES.SESSION_ENDED });
    userSockets.disconnectSockets(true);
  } catch (disconnectError) {
    logger.error('Failed to disconnect user sockets', {
      userId,
      error: { name: disconnectError.name, message: disconnectError.message, stack: disconnectError.stack },
    });
  }
}
