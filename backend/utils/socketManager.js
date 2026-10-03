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
 *   staff                             every admin/agent socket; receives every conversation's
 *                                     status changes so queue views stay current.
 *   conversation:<id>:staff           admins/agents viewing one conversation; full payloads.
 *   conversation:<id>:customer        the owning customer's sockets; customer-safe payloads.
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
 */

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import Conversation from '../models/Conversation.js';
import { SOCKET_MESSAGES } from '../constants/messages.js';
import { canUserAccessConversation, isStaffRole } from '../services/conversationAccess.js';
import { loadSessionUser, verifySessionToken } from '../services/sessionAuthenticator.js';
import { readCookieFromHeader, resolveAccessTokenCookieName } from './authCookies.js';
import { logger } from './logger.js';
import {
  toCustomerConversationStatusPayload,
  toCustomerMessagePayload,
  toStaffConversationStatusPayload,
} from './realtimePayloads.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SOCKET_EVENTS = Object.freeze({
  // Server -> client
  NEW_MESSAGE: 'NEW_MESSAGE',
  CONVERSATION_STATUS_UPDATED: 'CONVERSATION_STATUS_UPDATED',
  CONVERSATION_ACCESS_REVOKED: 'CONVERSATION_ACCESS_REVOKED',
  SESSION_ENDED: 'SESSION_ENDED',
  // Client -> server
  JOIN_CONVERSATION: 'JOIN_CONVERSATION',
  LEAVE_CONVERSATION: 'LEAVE_CONVERSATION',
});

/** Machine-readable codes in connect_error data, acknowledgements, and server events. */
export const SOCKET_ERROR_CODES = Object.freeze({
  ORIGIN_NOT_ALLOWED: 'origin_not_allowed',
  INVALID_PAYLOAD: 'invalid_payload',
  CONVERSATION_NOT_ACCESSIBLE: 'conversation_not_accessible',
  TOO_MANY_ROOMS: 'too_many_rooms',
  RATE_LIMITED: 'rate_limited',
  ACCESS_REVOKED: 'access_revoked',
  SESSION_EXPIRED: 'session_expired',
  SESSION_LOGGED_OUT: 'session_logged_out',
  SERVER_ERROR: 'server_error',
  // Handshake authentication failures use SESSION_FAILURE_REASON codes from sessionAuthenticator.
});

export const SOCKET_SERVER_SETTINGS = Object.freeze({
  PATH: '/socket.io',
  // Heartbeat: a ping every 25 s, answered within 20 s, so a dead peer is detected within ~45 s.
  PING_INTERVAL_MS: 25_000,
  PING_TIMEOUT_MS: 20_000,
  // Time a client has to complete the Socket.IO handshake after the transport connects.
  CONNECT_TIMEOUT_MS: 45_000,
  // Clients only send small control events (join/leave), so frames are capped at 64 KB.
  MAX_HTTP_BUFFER_BYTES: 64 * 1024,
  MAX_JOINED_CONVERSATIONS_PER_SOCKET: 100,
  ROOM_EVENT_WINDOW_MS: 10_000,
  ROOM_EVENTS_PER_WINDOW: 30,
  TELEMETRY_INTERVAL_MS: 5 * 60_000,
  // Redis adapter: how long startup waits for both connections, the reconnect backoff cap, and
  // how long cross-instance requests (fetchSockets) wait for every instance to answer.
  REDIS_CONNECT_TIMEOUT_MS: 10_000,
  REDIS_MAX_RECONNECT_DELAY_MS: 5_000,
  REDIS_ADAPTER_REQUESTS_TIMEOUT_MS: 5_000,
});

/** Largest delay setTimeout accepts (about 24.8 days); longer delays fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** MongoDB ObjectId as 24 hex characters (mongoose.isValidObjectId also accepts any 12-char string). */
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

const CONVERSATION_ROOM_PREFIX = 'conversation:';

const ROOM_NAMES = Object.freeze({
  staffLobby: () => 'staff',
  session: (sessionId) => `session:${sessionId}`,
  conversationStaff: (conversationId) => `${CONVERSATION_ROOM_PREFIX}${conversationId}:staff`,
  conversationCustomer: (conversationId) => `${CONVERSATION_ROOM_PREFIX}${conversationId}:customer`,
});

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {Server | null} */
let socketIoInstance = null;
let telemetryTimer = null;

/** Redis connections used by the adapter; null when running with the in-memory adapter. */
let redisAdapterClients = null;

/**
 * socketId -> {
 *   userId, role, sessionId, transport, connectedAtMs, lastHeartbeatAtMs,
 *   roomEventWindow: { eventCount, windowStartedAtMs },
 *   sessionExpiryTimer: NodeJS.Timeout | null
 * }
 * Created on connection, deleted on disconnect; see "Memory management" above.
 * Room membership is deliberately not duplicated here: it is read from `socket.rooms`.
 */
const activeClientConnections = new Map();

/** Number of conversation rooms this socket is in, read from Socket.IO's own room state. */
function countJoinedConversations(socket) {
  let joinedConversationCount = 0;
  for (const roomName of socket.rooms) {
    if (roomName.startsWith(CONVERSATION_ROOM_PREFIX)) joinedConversationCount += 1;
  }
  return joinedConversationCount;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildErrorAck(errorCode, message) {
  return { ok: false, error: { code: errorCode, message } };
}

/** Error passed to a handshake middleware's next(); the client receives it as connect_error. */
function buildConnectionError(errorCode, message) {
  const connectionError = new Error(message);
  connectionError.data = { code: errorCode, message };
  return connectionError;
}

/** Returns the conversation id from a join/leave payload, or null if it is not a valid ObjectId string. */
function extractConversationId(eventPayload) {
  const isPlainObject = typeof eventPayload === 'object' && eventPayload !== null && !Array.isArray(eventPayload);
  if (!isPlainObject) return null;
  const { conversationId } = eventPayload;
  return typeof conversationId === 'string' && OBJECT_ID_PATTERN.test(conversationId) ? conversationId.toLowerCase() : null;
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
// Handshake authentication
// ---------------------------------------------------------------------------

/**
 * io.use middleware: authenticates the handshake from the session cookie and stores the
 * caller on `socket.data` ({ user, session }). Runs once per connection, before `connection`.
 */
function createHandshakeAuthenticator(config) {
  return async function authenticateHandshake(socket, next) {
    const handshakeContext = { socketId: socket.id, remoteAddress: socket.handshake.address };
    try {
      const accessToken = readCookieFromHeader(socket.request.headers.cookie, resolveAccessTokenCookieName(config));

      const tokenVerification = verifySessionToken(accessToken, config);
      if (!tokenVerification.isValid) {
        logger.warn('Socket handshake rejected', { ...handshakeContext, reason: tokenVerification.failureReason });
        return next(buildConnectionError(tokenVerification.failureReason, tokenVerification.clientMessage));
      }

      const userLookup = await loadSessionUser(tokenVerification.sessionClaims);
      if (!userLookup.isValid) {
        logger.warn('Socket handshake rejected', {
          ...handshakeContext,
          reason: userLookup.failureReason,
          userId: tokenVerification.sessionClaims.userId,
        });
        return next(buildConnectionError(userLookup.failureReason, userLookup.clientMessage));
      }

      socket.data.user = userLookup.user;
      socket.data.session = {
        sessionId: tokenVerification.sessionClaims.sessionId,
        expiresAtMs: tokenVerification.sessionClaims.expiresAtMs,
      };
      return next();
    } catch (handshakeError) {
      logger.error('Socket handshake failed', {
        ...handshakeContext,
        error: { name: handshakeError.name, message: handshakeError.message, stack: handshakeError.stack },
      });
      return next(buildConnectionError(SOCKET_ERROR_CODES.SERVER_ERROR, SOCKET_MESSAGES.SERVER_ERROR));
    }
  };
}

// ---------------------------------------------------------------------------
// Per-connection handlers
// ---------------------------------------------------------------------------

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
    const roomName = isStaffSocket ? ROOM_NAMES.conversationStaff(conversationId) : ROOM_NAMES.conversationCustomer(conversationId);
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
        logger.warn('Conversation join denied', { ...eventContext, conversationId, conversationExists: Boolean(conversationRecord) });
        return respond(buildErrorAck(SOCKET_ERROR_CODES.CONVERSATION_NOT_ACCESSIBLE, SOCKET_MESSAGES.CONVERSATION_NOT_ACCESSIBLE));
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

/** Connection handler: registers state, rooms, timers, handlers, and the disconnect cleanup. */
function handleSocketConnection(socket) {
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** REDIS_URL with any password replaced, safe to log. */
function redactRedisUrl(redisUrl) {
  const parsedRedisUrl = new URL(redisUrl);
  if (parsedRedisUrl.password) parsedRedisUrl.password = '***';
  return parsedRedisUrl.toString();
}

/**
 * Opens the adapter's publisher and subscriber connections.
 *
 * Reconnect policy: before both connections have succeeded once, a failed attempt is final, so
 * startup fails within REDIS_CONNECT_TIMEOUT_MS instead of retrying forever. After that, a lost
 * connection is retried with exponential backoff capped at REDIS_MAX_RECONNECT_DELAY_MS, and
 * every state change is logged. An `error` listener is attached to each client because
 * node-redis emits connection failures as events, and an unhandled `error` event would crash
 * the process.
 *
 * @param {string} redisUrl
 * @returns {Promise<{ publisherClient: object, subscriberClient: object }>}
 * @throws {Error} if either connection cannot be established
 */
async function connectRedisAdapterClients(redisUrl) {
  const connectionState = { hasCompletedInitialConnect: false };
  const redactedRedisUrl = redactRedisUrl(redisUrl);

  const publisherClient = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: SOCKET_SERVER_SETTINGS.REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retryCount, failureCause) => {
        if (!connectionState.hasCompletedInitialConnect) {
          return new Error(`Initial Redis connection failed: ${failureCause?.message ?? 'unknown error'}`);
        }
        return Math.min(2 ** retryCount * 100, SOCKET_SERVER_SETTINGS.REDIS_MAX_RECONNECT_DELAY_MS);
      },
    },
  });
  // duplicate() copies the URL and socket options, including the reconnect strategy.
  const subscriberClient = publisherClient.duplicate();

  for (const [connectionRole, redisClient] of [
    ['publisher', publisherClient],
    ['subscriber', subscriberClient],
  ]) {
    redisClient.on('error', (redisError) => {
      logger.error('Redis adapter connection error', { connectionRole, redisUrl: redactedRedisUrl, error: redisError.message });
    });
    redisClient.on('reconnecting', () => {
      logger.warn('Redis adapter connection reconnecting', { connectionRole, redisUrl: redactedRedisUrl });
    });
    redisClient.on('ready', () => {
      logger.info('Redis adapter connection ready', { connectionRole, redisUrl: redactedRedisUrl });
    });
  }

  try {
    await Promise.all([publisherClient.connect(), subscriberClient.connect()]);
  } catch (connectError) {
    // Release whichever connection did open so the failed startup leaves no sockets behind.
    await Promise.allSettled([publisherClient, subscriberClient].map((redisClient) => redisClient.destroy()));
    throw new Error(`Could not connect to Redis at ${redactedRedisUrl}: ${connectError.message}`);
  }

  connectionState.hasCompletedInitialConnect = true;
  return { publisherClient, subscriberClient };
}

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
        logger.warn('Socket handshake rejected', { reason: SOCKET_ERROR_CODES.ORIGIN_NOT_ALLOWED, origin: requestOrigin ?? null });
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
    logger.debug('Socket server not initialised; NEW_MESSAGE not published', { conversationId: String(conversationId) });
    return false;
  }
  try {
    const normalizedConversationId = String(conversationId);
    socketIoInstance.to(ROOM_NAMES.conversationStaff(normalizedConversationId)).emit(SOCKET_EVENTS.NEW_MESSAGE, messagePayload);
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
 * Ends every socket opened with a given login session (called on logout), after telling the
 * clients why. Never throws.
 */
export function disconnectSessionSockets(sessionId) {
  if (!socketIoInstance) return;
  try {
    const sessionRoomName = ROOM_NAMES.session(sessionId);
    socketIoInstance
      .in(sessionRoomName)
      .emit(SOCKET_EVENTS.SESSION_ENDED, { code: SOCKET_ERROR_CODES.SESSION_LOGGED_OUT, message: SOCKET_MESSAGES.SESSION_ENDED });
    socketIoInstance.in(sessionRoomName).disconnectSockets(true);
  } catch (disconnectError) {
    logger.error('Failed to disconnect session sockets', {
      error: { name: disconnectError.name, message: disconnectError.message, stack: disconnectError.stack },
    });
  }
}
