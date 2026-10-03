/**
 * useAgentTelemetry: a dedicated Socket.IO connection that subscribes to the live agent telemetry
 * channel (admins only) and buffers the most recent events.
 *
 * ================================================================================================
 * WebSocket event handler architecture
 * ================================================================================================
 *
 *   connect                    (first connect and every reconnect) -> emit SUBSCRIBE_AGENT_TELEMETRY
 *                              with an acknowledgement. Rooms live on the server and are lost when a
 *                              connection drops, so the subscription is renewed on every `connect`.
 *                              ack.ok            -> status "live"
 *                              ack.error.code    -> "telemetry_forbidden": status "forbidden" (no retry)
 *                              no ack in time    -> status "error"; the next reconnect retries
 *   AGENT_THINKING_EVENT       \
 *   TOOL_EXECUTION_STARTED      > appendEvent(): one shared handler. Events go into a ref-held queue
 *   TOOL_EXECUTION_COMPLETED   /  and are flushed into React state once per animation frame, so a
 *                              burst (a turn emits ~15 events in a few ms) costs one render, not 15.
 *                              The buffer keeps the newest MAX_BUFFERED_EVENTS; older ones are dropped.
 *                              While paused, events are still received and counted but held back.
 *   disconnect                 status "reconnecting" (Socket.IO retries with backoff 1 s -> 30 s),
 *                              except for a client-initiated disconnect (unmount).
 *   connect_error              session failure codes (expired, revoked, signed out) end the session in
 *                              AuthContext; other errors keep retrying.
 *   SESSION_ENDED              the server ended the session: sign the UI out.
 *
 * ================================================================================================
 * Lifecycle and cleanup
 * ================================================================================================
 *
 * The connection exists only while the component is mounted and the user is signed in. On unmount
 * (or sign-out) the cleanup, in order: marks the hook disposed (late callbacks become no-ops),
 * cancels the pending animation frame, best-effort UNSUBSCRIBE, removes every listener it added,
 * and disconnects the socket. Nothing (sockets, timers, frames, closures over state setters)
 * outlives the component.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { AUTH_STATUS, useAuth } from '../auth/AuthContext.jsx';
import { AGENT_TELEMETRY_EVENT_NAMES, SESSION_FAILURE_CODES, SOCKET_EVENTS } from '../constants/socketEvents.js';

const SOCKET_SERVER_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '') || undefined;
const SOCKET_PATH = '/socket.io';
const SUBSCRIBE_ACK_TIMEOUT_MS = 5_000;
export const MAX_BUFFERED_EVENTS = 1_000;

export const TELEMETRY_CONNECTION_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  FORBIDDEN: 'forbidden',
  ERROR: 'error',
});

export function useAgentTelemetry() {
  const { authStatus, markSessionEnded } = useAuth();
  const [connectionStatus, setConnectionStatus] = useState(TELEMETRY_CONNECTION_STATUS.CONNECTING);
  const [events, setEvents] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  const [heldBackCount, setHeldBackCount] = useState(0);

  const pendingEventsRef = useRef([]);
  const heldBackEventsRef = useRef([]);
  const isPausedRef = useRef(false);
  const flushFrameRef = useRef(null);

  const flushPendingEvents = useCallback(() => {
    flushFrameRef.current = null;
    const arrivedEvents = pendingEventsRef.current;
    pendingEventsRef.current = [];
    if (arrivedEvents.length === 0) return;
    setEvents((previousEvents) => {
      const combinedEvents = previousEvents.concat(arrivedEvents);
      return combinedEvents.length > MAX_BUFFERED_EVENTS ? combinedEvents.slice(-MAX_BUFFERED_EVENTS) : combinedEvents;
    });
  }, []);

  const setPaused = useCallback(
    (shouldPause) => {
      isPausedRef.current = shouldPause;
      setIsPaused(shouldPause);
      if (!shouldPause && heldBackEventsRef.current.length > 0) {
        pendingEventsRef.current.push(...heldBackEventsRef.current.slice(-MAX_BUFFERED_EVENTS));
        heldBackEventsRef.current = [];
        setHeldBackCount(0);
        flushPendingEvents();
      }
    },
    [flushPendingEvents],
  );

  const clearEvents = useCallback(() => {
    pendingEventsRef.current = [];
    heldBackEventsRef.current = [];
    setHeldBackCount(0);
    setEvents([]);
  }, []);

  const isAuthenticated = authStatus === AUTH_STATUS.AUTHENTICATED;

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    let isDisposed = false;

    const socket = io(SOCKET_SERVER_ORIGIN, {
      path: SOCKET_PATH,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });

    function appendEvent(telemetryEvent) {
      if (isDisposed || !telemetryEvent || typeof telemetryEvent !== 'object') return;
      if (isPausedRef.current) {
        heldBackEventsRef.current.push(telemetryEvent);
        if (heldBackEventsRef.current.length > MAX_BUFFERED_EVENTS) heldBackEventsRef.current.shift();
        setHeldBackCount(heldBackEventsRef.current.length);
        return;
      }
      pendingEventsRef.current.push(telemetryEvent);
      if (flushFrameRef.current === null) flushFrameRef.current = requestAnimationFrame(flushPendingEvents);
    }

    async function subscribe() {
      try {
        const subscribeAck = await socket.timeout(SUBSCRIBE_ACK_TIMEOUT_MS).emitWithAck(SOCKET_EVENTS.SUBSCRIBE_AGENT_TELEMETRY, {});
        if (isDisposed) return;
        if (subscribeAck?.ok) setConnectionStatus(TELEMETRY_CONNECTION_STATUS.LIVE);
        else if (subscribeAck?.error?.code === 'telemetry_forbidden') {
          setConnectionStatus(TELEMETRY_CONNECTION_STATUS.FORBIDDEN);
          socket.disconnect();
        } else setConnectionStatus(TELEMETRY_CONNECTION_STATUS.ERROR);
      } catch {
        if (!isDisposed) setConnectionStatus(TELEMETRY_CONNECTION_STATUS.ERROR);
      }
    }

    function handleDisconnect(disconnectReason) {
      if (!isDisposed && disconnectReason !== 'io client disconnect') setConnectionStatus(TELEMETRY_CONNECTION_STATUS.RECONNECTING);
    }

    function handleConnectError(connectionError) {
      if (isDisposed) return;
      if (SESSION_FAILURE_CODES.has(connectionError?.data?.code)) {
        markSessionEnded();
        return;
      }
      setConnectionStatus(TELEMETRY_CONNECTION_STATUS.RECONNECTING);
    }

    function handleSessionEnded() {
      if (!isDisposed) markSessionEnded();
    }

    socket.on('connect', subscribe);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on(SOCKET_EVENTS.SESSION_ENDED, handleSessionEnded);
    for (const eventName of AGENT_TELEMETRY_EVENT_NAMES) socket.on(eventName, appendEvent);

    return () => {
      isDisposed = true;
      if (flushFrameRef.current !== null) {
        cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
      if (socket.connected) socket.emit(SOCKET_EVENTS.UNSUBSCRIBE_AGENT_TELEMETRY, {});
      socket.off('connect', subscribe);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off(SOCKET_EVENTS.SESSION_ENDED, handleSessionEnded);
      for (const eventName of AGENT_TELEMETRY_EVENT_NAMES) socket.off(eventName, appendEvent);
      socket.disconnect();
    };
  }, [isAuthenticated, markSessionEnded, flushPendingEvents]);

  return { connectionStatus, events, isPaused, setPaused, heldBackCount, clearEvents };
}
