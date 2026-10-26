/**
 * Authenticates every Socket.IO handshake from the session cookie (the same checks as HTTP).
 */

import { SOCKET_MESSAGES } from '../../constants/messages.js';
import { loadSessionUser, verifySessionToken } from '../../services/sessionAuthenticator.js';
import { readCookieFromHeader, resolveAccessTokenCookieName } from '../authCookies.js';
import { logger } from '../logger.js';
import { SOCKET_ERROR_CODES } from './socketProtocol.js';

/** Error passed to a handshake middleware's next(); the client receives it as connect_error. */
function buildConnectionError(errorCode, message) {
  const connectionError = new Error(message);
  connectionError.data = { code: errorCode, message };
  return connectionError;
}

/**
 * io.use middleware: authenticates the handshake from the session cookie and stores the
 * caller on `socket.data` ({ user, session }). Runs once per connection, before `connection`.
 */
export function createHandshakeAuthenticator(config) {
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
