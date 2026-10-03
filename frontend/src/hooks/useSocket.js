/**
 * useSocket: one authenticated Socket.IO connection for the component that calls it, with
 * automatic conversation re-join after reconnects.
 *
 * Usage (call once per page; each call opens its own connection):
 *
 *   const { connectionStatus, conversationJoinStatus, lastSocketError, rejoinConversation } = useSocket({
 *     conversationId,                                    // string or null
 *     onNewMessage: (messagePayload) => { ... },
 *     onConversationStatusUpdated: (statusPayload) => { ... },
 *     onConversationJoined: (conversationSnapshot) => { ... },   // also after every re-join
 *     onConversationAccessRevoked: (revocationPayload) => { ... },
 *   });
 *
 * Lifecycle
 *   - The socket exists only while AuthContext reports AUTHENTICATED. It connects through the
 *     same origin (the Vite proxy forwards /socket.io in development) with
 *     `withCredentials: true`, so the browser sends the HttpOnly session cookie in the handshake.
 *     The token itself is never visible to this code.
 *   - Every `connect` event, the first connection and every successful reconnect alike, joins
 *     the current conversation. Room membership lives on the server and is lost when a
 *     connection drops, so it is re-established each time. Socket.IO v4 emits `connect` on the
 *     socket after each reconnection (the separate `reconnect` event belongs to the Manager),
 *     so listening to `connect` alone covers both without joining twice.
 *   - Events published while the client was disconnected are not replayed. `onConversationJoined`
 *     fires after each (re)join with the conversation's current state, so the caller can reload
 *     anything it may have missed over HTTP.
 *   - Changing `conversationId` leaves the previous conversation and joins the new one on the
 *     same connection. Join results that arrive after the conversation changed are discarded.
 *   - Unmounting (or signing out) removes all listeners, cancels pending retries, and calls
 *     `socket.disconnect()`, so no connection or timer outlives the component.
 *
 * Reconnection
 *   - Transport failures (network drop, server restart, proxy errors) are retried by the
 *     Socket.IO manager with randomised exponential backoff from 1 s up to 30 s, indefinitely.
 *   - Handshake rejections by the server are not retried by Socket.IO. If the code is a session
 *     failure (expired, revoked, not signed in) the hook calls `markSessionEnded`, which signs
 *     the UI out; retrying could never succeed. Any other rejection (a transient server error)
 *     is retried by this hook with the same backoff policy.
 *   - SESSION_ENDED from the server (logout elsewhere, expiry) also signs the UI out.
 *
 * Callbacks are read through a ref, so passing new function instances on each render does not
 * reconnect or re-subscribe. A callback that throws is reported to the console and does not
 * break event handling for later events.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { AUTH_STATUS, useAuth } from '../auth/AuthContext.jsx';
import { SOCKET_CLIENT_MESSAGES } from '../constants/messages.js';
import {
  CLIENT_SOCKET_ERROR_CODES,
  CONVERSATION_JOIN_STATUS,
  SESSION_FAILURE_CODES,
  SOCKET_CONNECTION_STATUS,
  SOCKET_EVENTS,
} from '../constants/socketEvents.js';

/** Empty means same origin; otherwise the API origin used for HTTP calls. */
const SOCKET_SERVER_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '') || undefined;
const SOCKET_PATH = '/socket.io';

const RECONNECT_DELAY_INITIAL_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 30_000;
const RECONNECT_RANDOMIZATION_FACTOR = 0.5;
/** How long the server has to answer a join before it is reported as failed. */
const JOIN_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;
/** How long the client waits for a connection attempt before treating it as failed. */
const CONNECTION_ATTEMPT_TIMEOUT_MS = 20_000;

function isPlainObject(candidateValue) {
  return typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
}

/** Backoff for hook-managed retries, matching the manager's policy: exponential with jitter. */
function computeReconnectDelayMs(attemptNumber) {
  const exponentialDelayMs = Math.min(RECONNECT_DELAY_INITIAL_MS * 2 ** attemptNumber, RECONNECT_DELAY_MAX_MS);
  const jitterMs = exponentialDelayMs * RECONNECT_RANDOMIZATION_FACTOR * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_DELAY_INITIAL_MS, Math.round(exponentialDelayMs + jitterMs));
}

/** Calls a consumer callback without letting an exception in it break the socket listener. */
function invokeCallbackSafely(callbackName, consumerCallback, callbackPayload) {
  if (typeof consumerCallback !== 'function') return;
  try {
    consumerCallback(callbackPayload);
  } catch (callbackError) {
    console.error(`useSocket: ${callbackName} callback threw`, callbackError);
  }
}

export function useSocket({
  conversationId = null,
  onNewMessage,
  onConversationStatusUpdated,
  onConversationJoined,
  onConversationAccessRevoked,
} = {}) {
  const { authStatus, markSessionEnded } = useAuth();
  const isAuthenticated = authStatus === AUTH_STATUS.AUTHENTICATED;

  const [connectionStatus, setConnectionStatus] = useState(SOCKET_CONNECTION_STATUS.DISCONNECTED);
  const [conversationJoinStatus, setConversationJoinStatus] = useState(CONVERSATION_JOIN_STATUS.IDLE);
  const [lastSocketError, setLastSocketError] = useState(null);

  const socketRef = useRef(null);
  const activeConversationIdRef = useRef(conversationId);
  const consumerCallbacksRef = useRef({});

  // Always read the latest callbacks without re-subscribing to events.
  useEffect(() => {
    consumerCallbacksRef.current = {
      onNewMessage,
      onConversationStatusUpdated,
      onConversationJoined,
      onConversationAccessRevoked,
    };
  });

  /**
   * Joins the active conversation on the current socket. A no-op when not connected or when no
   * conversation is selected; `connect` calls it again once a connection exists.
   */
  const joinActiveConversation = useCallback(async () => {
    const connectedSocket = socketRef.current;
    const targetConversationId = activeConversationIdRef.current;
    if (!connectedSocket?.connected || !targetConversationId) return;

    setConversationJoinStatus(CONVERSATION_JOIN_STATUS.JOINING);
    let joinAcknowledgement;
    try {
      joinAcknowledgement = await connectedSocket
        .timeout(JOIN_ACKNOWLEDGEMENT_TIMEOUT_MS)
        .emitWithAck(SOCKET_EVENTS.JOIN_CONVERSATION, { conversationId: targetConversationId });
    } catch {
      // No acknowledgement in time, or the connection dropped mid-request. A drop is followed by
      // a reconnect, whose `connect` handler re-joins.
      if (socketRef.current !== connectedSocket || activeConversationIdRef.current !== targetConversationId) return;
      setConversationJoinStatus(CONVERSATION_JOIN_STATUS.FAILED);
      setLastSocketError({ code: CLIENT_SOCKET_ERROR_CODES.JOIN_TIMEOUT, message: SOCKET_CLIENT_MESSAGES.JOIN_TIMEOUT });
      return;
    }

    // The conversation or the socket changed while waiting; this result is no longer relevant.
    if (socketRef.current !== connectedSocket || activeConversationIdRef.current !== targetConversationId) return;

    if (joinAcknowledgement?.ok === true) {
      setConversationJoinStatus(CONVERSATION_JOIN_STATUS.JOINED);
      setLastSocketError(null);
      invokeCallbackSafely('onConversationJoined', consumerCallbacksRef.current.onConversationJoined, joinAcknowledgement.conversation);
    } else {
      setConversationJoinStatus(CONVERSATION_JOIN_STATUS.DENIED);
      setLastSocketError(isPlainObject(joinAcknowledgement?.error) ? joinAcknowledgement.error : null);
    }
  }, []);

  // ---- Connection lifecycle: one socket per authenticated mount ----------------------------
  useEffect(() => {
    if (!isAuthenticated) return undefined;

    const socket = io(SOCKET_SERVER_ORIGIN, {
      path: SOCKET_PATH,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: RECONNECT_DELAY_INITIAL_MS,
      reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
      randomizationFactor: RECONNECT_RANDOMIZATION_FACTOR,
      timeout: CONNECTION_ATTEMPT_TIMEOUT_MS,
    });
    socketRef.current = socket;

    let isDisposed = false;
    let rejectedHandshakeRetryTimer = null;
    let rejectedHandshakeRetryCount = 0;

    const handleConnect = () => {
      rejectedHandshakeRetryCount = 0;
      setConnectionStatus(SOCKET_CONNECTION_STATUS.CONNECTED);
      setLastSocketError(null);
      joinActiveConversation();
    };

    const handleDisconnect = () => {
      // `socket.active` is true when the manager will reconnect by itself (transport loss), and
      // false when the server or this client closed the connection deliberately.
      setConnectionStatus(socket.active ? SOCKET_CONNECTION_STATUS.RECONNECTING : SOCKET_CONNECTION_STATUS.DISCONNECTED);
      // Server-side room membership ended with the connection; the next `connect` re-joins.
      setConversationJoinStatus(CONVERSATION_JOIN_STATUS.IDLE);
    };

    const handleConnectError = (connectError) => {
      if (isDisposed) return;
      const serverErrorPayload = isPlainObject(connectError?.data) ? connectError.data : null;

      if (socket.active) {
        // Transport-level failure; the manager is already scheduling the next attempt.
        setConnectionStatus(SOCKET_CONNECTION_STATUS.RECONNECTING);
        setLastSocketError({ code: CLIENT_SOCKET_ERROR_CODES.CONNECTION_FAILED, message: SOCKET_CLIENT_MESSAGES.CONNECTION_FAILED });
        return;
      }

      if (serverErrorPayload && SESSION_FAILURE_CODES.has(serverErrorPayload.code)) {
        setConnectionStatus(SOCKET_CONNECTION_STATUS.DISCONNECTED);
        setLastSocketError(serverErrorPayload);
        markSessionEnded();
        return;
      }

      // Rejected for a reason that may be transient; Socket.IO will not retry this by itself.
      setConnectionStatus(SOCKET_CONNECTION_STATUS.RECONNECTING);
      setLastSocketError(serverErrorPayload ?? { code: CLIENT_SOCKET_ERROR_CODES.CONNECTION_FAILED, message: SOCKET_CLIENT_MESSAGES.CONNECTION_FAILED });
      const retryDelayMs = computeReconnectDelayMs(rejectedHandshakeRetryCount);
      rejectedHandshakeRetryCount += 1;
      clearTimeout(rejectedHandshakeRetryTimer);
      rejectedHandshakeRetryTimer = setTimeout(() => {
        if (!isDisposed) socket.connect();
      }, retryDelayMs);
    };

    const handleSessionEnded = (sessionEndedPayload) => {
      setConnectionStatus(SOCKET_CONNECTION_STATUS.DISCONNECTED);
      setConversationJoinStatus(CONVERSATION_JOIN_STATUS.IDLE);
      setLastSocketError(isPlainObject(sessionEndedPayload) ? sessionEndedPayload : null);
      markSessionEnded();
    };

    const handleNewMessage = (messagePayload) => {
      // Drop events for a conversation the caller has already navigated away from.
      if (!isPlainObject(messagePayload) || messagePayload.conversationId !== activeConversationIdRef.current) return;
      invokeCallbackSafely('onNewMessage', consumerCallbacksRef.current.onNewMessage, messagePayload);
    };

    const handleConversationStatusUpdated = (statusPayload) => {
      // Not filtered by conversation: staff sockets receive every conversation's updates so that
      // queue views stay current; the caller decides which ones it needs.
      if (!isPlainObject(statusPayload)) return;
      invokeCallbackSafely('onConversationStatusUpdated', consumerCallbacksRef.current.onConversationStatusUpdated, statusPayload);
    };

    const handleConversationAccessRevoked = (revocationPayload) => {
      if (!isPlainObject(revocationPayload)) return;
      if (revocationPayload.conversationId === activeConversationIdRef.current) {
        setConversationJoinStatus(CONVERSATION_JOIN_STATUS.REVOKED);
        setLastSocketError({ code: revocationPayload.code, message: revocationPayload.message });
      }
      invokeCallbackSafely('onConversationAccessRevoked', consumerCallbacksRef.current.onConversationAccessRevoked, revocationPayload);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on(SOCKET_EVENTS.SESSION_ENDED, handleSessionEnded);
    socket.on(SOCKET_EVENTS.NEW_MESSAGE, handleNewMessage);
    socket.on(SOCKET_EVENTS.CONVERSATION_STATUS_UPDATED, handleConversationStatusUpdated);
    socket.on(SOCKET_EVENTS.CONVERSATION_ACCESS_REVOKED, handleConversationAccessRevoked);

    setConnectionStatus(SOCKET_CONNECTION_STATUS.CONNECTING);
    socket.connect();

    return () => {
      isDisposed = true;
      clearTimeout(rejectedHandshakeRetryTimer);
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      setConnectionStatus(SOCKET_CONNECTION_STATUS.DISCONNECTED);
      setConversationJoinStatus(CONVERSATION_JOIN_STATUS.IDLE);
    };
  }, [isAuthenticated, joinActiveConversation, markSessionEnded]);

  // ---- Conversation selection: leave the old room, join the new one ------------------------
  useEffect(() => {
    const previousConversationId = activeConversationIdRef.current;
    activeConversationIdRef.current = conversationId;
    const currentSocket = socketRef.current;

    if (previousConversationId && previousConversationId !== conversationId && currentSocket?.connected) {
      // Fire-and-forget with an acknowledgement handler so the server's answer is consumed;
      // the room is also left automatically if the connection closes.
      currentSocket.emit(SOCKET_EVENTS.LEAVE_CONVERSATION, { conversationId: previousConversationId }, () => {});
    }

    if (!conversationId) {
      setConversationJoinStatus(CONVERSATION_JOIN_STATUS.IDLE);
      return;
    }
    joinActiveConversation();
  }, [conversationId, joinActiveConversation]);

  return { connectionStatus, conversationJoinStatus, lastSocketError, rejoinConversation: joinActiveConversation };
}
