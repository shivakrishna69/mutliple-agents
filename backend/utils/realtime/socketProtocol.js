/**
 * The Socket.IO protocol shared by the server and its handlers: event names, error codes,
 * server settings and room names. See utils/socketManager.js for the design.
 */

import { AGENT_TELEMETRY_EVENTS } from '../../services/agentTelemetry.js';

export const SOCKET_EVENTS = Object.freeze({
  // Server -> client
  NEW_MESSAGE: 'NEW_MESSAGE',
  CONVERSATION_STATUS_UPDATED: 'CONVERSATION_STATUS_UPDATED',
  CONVERSATION_ACCESS_REVOKED: 'CONVERSATION_ACCESS_REVOKED',
  SESSION_ENDED: 'SESSION_ENDED',
  // Server -> client, agent telemetry channel (names are AGENT_TELEMETRY_EVENTS)
  AGENT_THINKING_EVENT: AGENT_TELEMETRY_EVENTS.AGENT_THINKING_EVENT,
  TOOL_EXECUTION_STARTED: AGENT_TELEMETRY_EVENTS.TOOL_EXECUTION_STARTED,
  TOOL_EXECUTION_COMPLETED: AGENT_TELEMETRY_EVENTS.TOOL_EXECUTION_COMPLETED,
  // Client -> server
  JOIN_CONVERSATION: 'JOIN_CONVERSATION',
  LEAVE_CONVERSATION: 'LEAVE_CONVERSATION',
  SUBSCRIBE_AGENT_TELEMETRY: 'SUBSCRIBE_AGENT_TELEMETRY',
  UNSUBSCRIBE_AGENT_TELEMETRY: 'UNSUBSCRIBE_AGENT_TELEMETRY',
});

/** Machine-readable codes in connect_error data, acknowledgements, and server events. */
export const SOCKET_ERROR_CODES = Object.freeze({
  ORIGIN_NOT_ALLOWED: 'origin_not_allowed',
  INVALID_PAYLOAD: 'invalid_payload',
  CONVERSATION_NOT_ACCESSIBLE: 'conversation_not_accessible',
  TOO_MANY_ROOMS: 'too_many_rooms',
  RATE_LIMITED: 'rate_limited',
  ACCESS_REVOKED: 'access_revoked',
  TELEMETRY_FORBIDDEN: 'telemetry_forbidden',
  SESSION_EXPIRED: 'session_expired',
  SESSION_LOGGED_OUT: 'session_logged_out',
  ROLE_CHANGED: 'role_changed',
  PASSWORD_CHANGED: 'password_changed',
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
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** MongoDB ObjectId as 24 hex characters (mongoose.isValidObjectId also accepts any 12-char string). */
export const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export const CONVERSATION_ROOM_PREFIX = 'conversation:';

export const ROOM_NAMES = Object.freeze({
  staffLobby: () => 'staff',
  session: (sessionId) => `session:${sessionId}`,
  user: (userId) => `user:${userId}`,
  conversationStaff: (conversationId) => `${CONVERSATION_ROOM_PREFIX}${conversationId}:staff`,
  conversationCustomer: (conversationId) => `${CONVERSATION_ROOM_PREFIX}${conversationId}:customer`,
  agentTelemetry: () => 'agent-telemetry',
});
