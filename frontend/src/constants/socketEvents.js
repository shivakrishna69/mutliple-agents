/**
 * Socket.IO event names and codes. These mirror backend/utils/socketManager.js
 * (SOCKET_EVENTS, SOCKET_ERROR_CODES) and backend/services/sessionAuthenticator.js
 * (SESSION_FAILURE_REASON); a change on either side must be made on both.
 */

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

/**
 * Handshake rejection codes that mean the session itself is unusable. Retrying cannot succeed;
 * the user has to sign in again.
 */
export const SESSION_FAILURE_CODES = Object.freeze(
  new Set([
    'not_authenticated',
    'malformed_token',
    'token_expired',
    'token_not_yet_valid',
    'token_invalid',
    'missing_claims',
    'session_revoked',
    'account_not_found',
  ]),
);

/** Codes produced by the client itself (the server's codes arrive in error payloads). */
export const CLIENT_SOCKET_ERROR_CODES = Object.freeze({
  JOIN_TIMEOUT: 'join_timeout',
  CONNECTION_FAILED: 'connection_failed',
});

export const SOCKET_CONNECTION_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
});

export const CONVERSATION_JOIN_STATUS = Object.freeze({
  IDLE: 'idle',
  JOINING: 'joining',
  JOINED: 'joined',
  DENIED: 'denied',
  REVOKED: 'revoked',
  FAILED: 'failed',
});
