/**
 * AgentConsole: the support console page for staff. It connects the presentational ChatConsole to
 * the conversation API (api/conversationsApi.js) and to live updates (hooks/useSocket.js).
 *
 * Data flow
 *   - On mount: GET /api/conversations fills the list (scoped by role on the server).
 *   - Selecting a conversation: GET details and messages, and join its socket room.
 *   - Live updates (staff sockets also receive every visible conversation's status changes):
 *       NEW_MESSAGE                  appended to the open conversation (deduplicated by
 *                                    messageId, since the sender also gets it in the POST
 *                                    response); its list entry's preview and time are updated.
 *       CONVERSATION_STATUS_UPDATED  merged into the list and the open conversation; a
 *                                    conversation that becomes visible but is not listed yet
 *                                    triggers a list reload; one that is no longer visible to
 *                                    this user (claimed by someone else) leaves the list.
 *       re-join after a reconnect    reloads the open conversation's details and messages, since
 *                                    events published while disconnected are not replayed.
 *   - Actions: Claim (waiting conversations), Release (yours), and replying (yours, while
 *     assigned) call the API with the session's CSRF token.
 *   - A 401 from any request means the session ended: the UI signs out.
 *
 * Visibility mirrors backend services/conversationAccess.js: admins see everything; agents see
 * conversations assigned to them plus the escalated queue.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  requestClaimConversation,
  requestConversationDetails,
  requestConversationList,
  requestConversationMessages,
  requestReleaseConversation,
  requestSendAgentMessage,
} from '../api/conversationsApi.js';
import { ApiError, HTTP_STATUS_UNAUTHORIZED } from '../api/httpClient.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ChatConsole from '../components/ChatConsole.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { API_MESSAGES } from '../constants/messages.js';
import { useSocket } from '../hooks/useSocket.js';

/** Delay before reloading the list after a status event for an unlisted conversation (bursts collapse). */
const LIST_RELOAD_DEBOUNCE_MS = 500;
const MESSAGE_PREVIEW_LENGTH = 140;
/** A MongoDB ObjectId: 24 hexadecimal characters. Anything else in the URL is ignored. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

const STATUS = Object.freeze({
  UNASSIGNED: 'unassigned',
  PROCESSING_AI: 'processing-ai',
  ESCALATED_TO_HUMAN: 'escalated-to-human',
  ASSIGNED_AGENT: 'assigned-agent',
});

/** Client-side mirror of the backend visibility rule, used only to keep the list current. */
function isConversationVisibleToUser(statusPayload, currentUser) {
  if (currentUser.role === 'admin') return true;
  if (statusPayload.assignedAgentId) return statusPayload.assignedAgentId === currentUser.id;
  return statusPayload.status === STATUS.ESCALATED_TO_HUMAN;
}

function sortByRecentActivity(conversations) {
  return [...conversations].sort((first, second) => String(second.updatedAt ?? '').localeCompare(String(first.updatedAt ?? '')));
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Why the composer is disabled for this conversation, or null when the user may reply. */
function resolveReplyRestriction(conversationDetails, currentUser) {
  if (!conversationDetails) return 'Select a conversation.';
  if (conversationDetails.status === STATUS.ASSIGNED_AGENT) {
    return conversationDetails.assignedAgentId === currentUser.id ? null : 'Another agent is handling this conversation.';
  }
  if (conversationDetails.status === STATUS.PROCESSING_AI) return 'The AI assistant is handling this conversation.';
  return 'Claim this conversation to reply.';
}

export default function AgentConsole() {
  const { currentUser, csrfToken, markSessionEnded } = useAuth();

  const [conversations, setConversations] = useState([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  // A link such as /console?conversation=<id> (from the overview) opens that conversation.
  const [searchParams] = useSearchParams();
  const [selectedConversationId, setSelectedConversationId] = useState(() => {
    const linkedConversationId = searchParams.get('conversation');
    return linkedConversationId && OBJECT_ID_PATTERN.test(linkedConversationId) ? linkedConversationId : null;
  });
  const [conversationDetails, setConversationDetails] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isPerformingAction, setIsPerformingAction] = useState(false);
  const [pageError, setPageError] = useState(null);

  const selectedConversationIdRef = useRef(null);
  const listReloadTimerRef = useRef(null);
  const listedConversationIdsRef = useRef(new Set());

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);
  useEffect(() => {
    listedConversationIdsRef.current = new Set(conversations.map((conversation) => conversation.conversationId));
  }, [conversations]);

  /** Shows an API failure, or signs out when the session has ended. */
  const reportError = useCallback(
    (error) => {
      if (isAbortError(error)) return;
      if (error instanceof ApiError && error.status === HTTP_STATUS_UNAUTHORIZED) {
        markSessionEnded();
        return;
      }
      setPageError({
        message: error instanceof ApiError ? error.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR,
        requestId: error instanceof ApiError && error.status >= 500 ? error.requestId : null,
      });
    },
    [markSessionEnded],
  );

  // ---- Conversation list ------------------------------------------------------------------
  const loadConversationList = useCallback(
    async (signal) => {
      try {
        const loadedConversations = await requestConversationList({ signal });
        setConversations(sortByRecentActivity(loadedConversations));
      } catch (error) {
        reportError(error);
      } finally {
        if (!signal?.aborted) setIsLoadingConversations(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    const listController = new AbortController();
    loadConversationList(listController.signal);
    return () => {
      listController.abort();
      clearTimeout(listReloadTimerRef.current);
    };
  }, [loadConversationList]);

  const scheduleListReload = useCallback(() => {
    clearTimeout(listReloadTimerRef.current);
    listReloadTimerRef.current = setTimeout(() => loadConversationList(), LIST_RELOAD_DEBOUNCE_MS);
  }, [loadConversationList]);

  // ---- Selected conversation --------------------------------------------------------------
  const loadSelectedConversation = useCallback(
    async (conversationId, signal) => {
      try {
        const [loadedDetails, loadedMessages] = await Promise.all([
          requestConversationDetails(conversationId, { signal }),
          requestConversationMessages(conversationId, { signal }),
        ]);
        if (selectedConversationIdRef.current !== conversationId) return;
        setConversationDetails(loadedDetails);
        setMessages(loadedMessages);
      } catch (error) {
        reportError(error);
      } finally {
        if (!signal?.aborted && selectedConversationIdRef.current === conversationId) setIsLoadingMessages(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    if (!selectedConversationId) {
      setConversationDetails(null);
      setMessages([]);
      return undefined;
    }
    const conversationController = new AbortController();
    setIsLoadingMessages(true);
    setConversationDetails(null);
    setMessages([]);
    loadSelectedConversation(selectedConversationId, conversationController.signal);
    return () => conversationController.abort();
  }, [selectedConversationId, loadSelectedConversation]);

  // ---- Live updates -----------------------------------------------------------------------
  const appendMessage = useCallback((messagePayload) => {
    setMessages((previousMessages) =>
      previousMessages.some((existingMessage) => existingMessage.messageId === messagePayload.messageId)
        ? previousMessages
        : [...previousMessages, messagePayload],
    );
    setConversations((previousConversations) =>
      sortByRecentActivity(
        previousConversations.map((conversation) =>
          conversation.conversationId === messagePayload.conversationId
            ? {
                ...conversation,
                lastMessagePreview: messagePayload.text.slice(0, MESSAGE_PREVIEW_LENGTH),
                lastMessageSenderType: messagePayload.senderType,
                updatedAt: messagePayload.createdAt,
              }
            : conversation,
        ),
      ),
    );
  }, []);

  const applyStatusUpdate = useCallback(
    (statusPayload) => {
      const isVisible = isConversationVisibleToUser(statusPayload, currentUser);
      const isListed = listedConversationIdsRef.current.has(statusPayload.conversationId);

      if (isVisible && !isListed) {
        scheduleListReload();
      } else if (isListed) {
        setConversations((previousConversations) =>
          isVisible
            ? sortByRecentActivity(
                previousConversations.map((conversation) =>
                  conversation.conversationId === statusPayload.conversationId ? { ...conversation, ...statusPayload } : conversation,
                ),
              )
            : previousConversations.filter((conversation) => conversation.conversationId !== statusPayload.conversationId),
        );
      }

      if (statusPayload.conversationId === selectedConversationIdRef.current) {
        setConversationDetails((previousDetails) => (previousDetails ? { ...previousDetails, ...statusPayload } : previousDetails));
      }
    },
    [currentUser, scheduleListReload],
  );

  const { connectionStatus } = useSocket({
    conversationId: selectedConversationId,
    onNewMessage: appendMessage,
    onConversationStatusUpdated: applyStatusUpdate,
    onConversationJoined: () => {
      // Re-joined after a reconnect: reload what may have been missed while disconnected.
      if (selectedConversationIdRef.current) loadSelectedConversation(selectedConversationIdRef.current);
    },
    onConversationAccessRevoked: (revocationPayload) => {
      if (revocationPayload.conversationId === selectedConversationIdRef.current) {
        setPageError({ message: revocationPayload.message, requestId: null });
        setSelectedConversationId(null);
      }
    },
  });

  // ---- Actions ----------------------------------------------------------------------------
  async function performConversationAction(requestAction) {
    if (isPerformingAction || !selectedConversationId) return;
    setIsPerformingAction(true);
    setPageError(null);
    try {
      const updatedDetails = await requestAction(selectedConversationId, csrfToken);
      setConversationDetails(updatedDetails);
      applyStatusUpdate(updatedDetails);
    } catch (error) {
      reportError(error);
    } finally {
      setIsPerformingAction(false);
    }
  }

  async function sendAgentMessage(messageText) {
    try {
      const storedMessage = await requestSendAgentMessage(selectedConversationId, messageText, csrfToken);
      appendMessage(storedMessage);
    } catch (error) {
      if (error instanceof ApiError && error.status === HTTP_STATUS_UNAUTHORIZED) markSessionEnded();
      // Rethrown so the composer keeps the draft and shows the message.
      throw error instanceof ApiError ? new Error(error.message) : error;
    }
  }

  // ---- Render -----------------------------------------------------------------------------
  const replyRestriction = resolveReplyRestriction(conversationDetails, currentUser);
  const isWaitingForAgent =
    conversationDetails?.status === STATUS.ESCALATED_TO_HUMAN || conversationDetails?.status === STATUS.UNASSIGNED;
  const isAssignedToCurrentUser =
    conversationDetails?.status === STATUS.ASSIGNED_AGENT && conversationDetails.assignedAgentId === currentUser.id;

  const chatHeaderActions = isWaitingForAgent ? (
    <button
      type="button"
      onClick={() => performConversationAction(requestClaimConversation)}
      disabled={isPerformingAction}
      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-indigo-300"
    >
      {isPerformingAction ? 'Claiming…' : 'Claim'}
    </button>
  ) : isAssignedToCurrentUser ? (
    <button
      type="button"
      onClick={() => performConversationAction(requestReleaseConversation)}
      disabled={isPerformingAction}
      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isPerformingAction ? 'Releasing…' : 'Return to queue'}
    </button>
  ) : null;

  return (
    // Fills AppShell's content area: the list and chat panes scroll on their own on large screens.
    <div className="flex min-h-full flex-col lg:h-full">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900">Support console</h1>
          <p className="text-xs text-slate-500">
            {currentUser.role === 'admin' ? 'All conversations' : 'Your conversations and the escalation queue'}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
            connectionStatus === 'connected' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-amber-50 text-amber-800 ring-amber-600/30'
          }`}
          title="Live updates connection"
        >
          <span className={`h-2 w-2 rounded-full ${connectionStatus === 'connected' ? 'animate-pulse bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
          {connectionStatus === 'connected' ? 'Live' : 'Reconnecting…'}
        </span>
      </header>

      {pageError && (
        <div className="border-b border-slate-200 bg-white px-4 py-3">
          <ErrorBanner
            title="Something went wrong"
            message={pageError.message}
            requestId={pageError.requestId}
            onDismiss={() => setPageError(null)}
          />
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ChatConsole
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          onSelectConversation={setSelectedConversationId}
          conversationDetails={conversationDetails}
          messages={messages}
          onSendMessage={sendAgentMessage}
          canSendMessage={replyRestriction === null}
          sendDisabledReason={replyRestriction ?? ''}
          isLoadingConversations={isLoadingConversations}
          isLoadingMessages={isLoadingMessages}
          chatHeaderActions={chatHeaderActions}
        />
      </div>
    </div>
  );
}
