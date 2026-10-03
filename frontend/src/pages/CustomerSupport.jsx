/**
 * CustomerSupport: the customer's support chat.
 *
 * Flow
 *   - On load: the customer's conversation (GET /api/conversations returns only theirs, newest
 *     first) and its history. A customer with no conversation yet sees an empty chat; their first
 *     message creates it.
 *   - Sending: POST /api/support/messages. The message shows immediately as "Sending…", and the
 *     AI's reply (when the AI is handling the conversation) comes back in the response, usually
 *     within a few seconds, while "Support is replying…" is shown.
 *   - Live: the page joins the conversation's socket room (hooks/useSocket.js), so a human
 *     agent's replies and status changes (escalated, agent joined) appear without a reload.
 *     Messages arriving both over HTTP and the socket are de-duplicated by messageId.
 *   - A 401 from any request means the session ended: the UI signs out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { requestConversationList, requestConversationMessages } from '../api/conversationsApi.js';
import { ApiError, HTTP_STATUS_UNAUTHORIZED } from '../api/httpClient.js';
import { requestSendSupportMessage } from '../api/supportApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { MessageComposer, groupMessagesBySender } from '../components/ChatConsole.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { SparklesIcon } from '../components/Icons.jsx';
import MessageText from '../components/MessageText.jsx';
import { API_MESSAGES } from '../constants/messages.js';
import { useSocket } from '../hooks/useSocket.js';

/** How each sender appears to the customer. Their own messages are on the right. */
const CUSTOMER_VIEW_SENDERS = Object.freeze({
  customer: { label: 'You', isOwn: true, bubbleClassName: 'bg-indigo-600 text-white', labelClassName: 'text-indigo-700' },
  ai_supervisor: { label: 'Support Assistant (AI)', isOwn: false, bubbleClassName: 'bg-white text-slate-900 ring-1 ring-slate-200', labelClassName: 'text-slate-600' },
  ai_worker: { label: 'Support Assistant (AI)', isOwn: false, bubbleClassName: 'bg-white text-slate-900 ring-1 ring-slate-200', labelClassName: 'text-slate-600' },
  human_agent: { label: 'Support Agent', isOwn: false, bubbleClassName: 'bg-emerald-50 text-emerald-950 ring-1 ring-emerald-200', labelClassName: 'text-emerald-700' },
});

/** What the customer is told about who is handling their conversation. */
const STATUS_NOTICES = Object.freeze({
  unassigned: { text: "You're chatting with our AI support assistant.", className: 'bg-indigo-50 text-indigo-800' },
  'processing-ai': { text: "You're chatting with our AI support assistant.", className: 'bg-indigo-50 text-indigo-800' },
  'escalated-to-human': { text: 'A member of our support team will join this chat shortly.', className: 'bg-amber-50 text-amber-900' },
  'assigned-agent': { text: "You're chatting with a member of our support team.", className: 'bg-emerald-50 text-emerald-900' },
});

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function formatClockTime(isoTimestamp) {
  const parsedDate = isoTimestamp ? new Date(isoTimestamp) : null;
  return parsedDate && !Number.isNaN(parsedDate.getTime()) ? timeFormatter.format(parsedDate) : '';
}

function createClientMessageId() {
  return crypto.randomUUID();
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

// =================================================================================================
// Render pieces
// =================================================================================================

function CustomerMessageGroup({ messageGroup }) {
  const senderDisplay = CUSTOMER_VIEW_SENDERS[messageGroup.senderType] ?? CUSTOMER_VIEW_SENDERS.ai_supervisor;
  return (
    <div className={`flex flex-col gap-1 ${senderDisplay.isOwn ? 'items-end' : 'items-start'}`}>
      <div className={`flex items-baseline gap-2 px-1 text-xs ${senderDisplay.isOwn ? 'flex-row-reverse' : ''}`}>
        <span className={`font-semibold ${senderDisplay.labelClassName}`}>{senderDisplay.label}</span>
        <time className="text-slate-400" dateTime={messageGroup.messages[0].createdAt}>
          {formatClockTime(messageGroup.messages[0].createdAt)}
        </time>
      </div>
      {messageGroup.messages.map((message) => (
        <div
          key={message.messageId}
          className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm sm:max-w-[75%] ${senderDisplay.bubbleClassName} ${message.isPending ? 'opacity-60' : ''}`}
        >
          <MessageText text={message.text} />
          {message.isPending && <span className="mt-1 block text-right text-[0.65rem] opacity-80">Sending…</span>}
        </div>
      ))}
    </div>
  );
}

function ReplyingIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-slate-500" role="status">
      <span className="flex gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
      </span>
      Support is replying…
    </div>
  );
}

// =================================================================================================
// Page
// =================================================================================================

export default function CustomerSupport() {
  const { csrfToken, markSessionEnded } = useAuth();

  const [conversationId, setConversationId] = useState(null);
  const [conversationStatus, setConversationStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAwaitingReply, setIsAwaitingReply] = useState(false);
  const [pageError, setPageError] = useState(null);
  const messageLogRef = useRef(null);
  const conversationIdRef = useRef(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

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

  /** Adds messages not already shown (by messageId) and removes the pending copy they replace. */
  const mergeMessages = useCallback((incomingMessages, replacedPendingId = null) => {
    setMessages((previousMessages) => {
      const remainingMessages = replacedPendingId
        ? previousMessages.filter((message) => message.messageId !== replacedPendingId)
        : previousMessages;
      const knownIds = new Set(remainingMessages.map((message) => message.messageId));
      const newMessages = incomingMessages.filter((message) => !knownIds.has(message.messageId));
      return newMessages.length > 0 || replacedPendingId ? [...remainingMessages, ...newMessages] : previousMessages;
    });
  }, []);

  const loadConversation = useCallback(
    async (signal) => {
      try {
        const customerConversations = await requestConversationList({ signal });
        const latestConversation = customerConversations[0];
        if (!latestConversation) return;
        setConversationId(latestConversation.conversationId);
        setConversationStatus(latestConversation.status);
        const history = await requestConversationMessages(latestConversation.conversationId, { signal });
        setMessages(history);
      } catch (error) {
        reportError(error);
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    const loadController = new AbortController();
    loadConversation(loadController.signal);
    return () => loadController.abort();
  }, [loadConversation]);

  // Keep the newest message in view.
  useEffect(() => {
    if (messageLogRef.current) messageLogRef.current.scrollTop = messageLogRef.current.scrollHeight;
  }, [messages, isAwaitingReply]);

  const { connectionStatus } = useSocket({
    conversationId,
    onNewMessage: (messagePayload) => mergeMessages([messagePayload]),
    onConversationStatusUpdated: (statusPayload) => {
      if (statusPayload.conversationId === conversationIdRef.current) setConversationStatus(statusPayload.status);
    },
    onConversationJoined: async (conversationSnapshot) => {
      // Joined or re-joined: pick up anything sent while the page was not connected.
      if (conversationSnapshot?.status) setConversationStatus(conversationSnapshot.status);
      try {
        const history = await requestConversationMessages(conversationIdRef.current);
        mergeMessages(history);
      } catch (error) {
        reportError(error);
      }
    },
  });

  async function sendMessage(messageText) {
    const clientMessageId = createClientMessageId();
    const pendingMessageId = `pending-${clientMessageId}`;
    const sentAt = new Date().toISOString();
    setPageError(null);
    mergeMessages([{ messageId: pendingMessageId, senderType: 'customer', text: messageText, createdAt: sentAt, isPending: true }]);
    setIsAwaitingReply(true);
    try {
      const sendResult = await requestSendSupportMessage(messageText, clientMessageId, csrfToken);
      if (sendResult.conversation) {
        setConversationId(sendResult.conversation.id);
        setConversationStatus(sendResult.conversation.status);
      }
      const confirmedMessages = [{ messageId: sendResult.customerMessageId, senderType: 'customer', text: messageText, createdAt: sentAt }];
      if (sendResult.reply) {
        confirmedMessages.push({ ...sendResult.reply, createdAt: new Date().toISOString() });
      }
      mergeMessages(confirmedMessages, pendingMessageId);
    } catch (error) {
      // Remove the pending copy; the composer keeps the draft so the customer can retry.
      setMessages((previousMessages) => previousMessages.filter((message) => message.messageId !== pendingMessageId));
      if (error instanceof ApiError && error.status === HTTP_STATUS_UNAUTHORIZED) markSessionEnded();
      throw error instanceof ApiError ? new Error(error.message) : error;
    } finally {
      setIsAwaitingReply(false);
    }
  }

  const statusNotice = STATUS_NOTICES[conversationStatus];

  return (
    // Fills AppShell's content area; only the message log scrolls.
    <div className="flex h-full flex-col bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-500/30">
            <SparklesIcon className="h-5 w-5" />
            <span
              className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full ring-2 ring-white ${connectionStatus === 'connected' || !conversationId ? 'bg-emerald-500' : 'bg-amber-500'}`}
              aria-hidden="true"
            />
          </span>
          <div>
            <h1 className="text-base font-bold text-slate-900">Support chat</h1>
            <p className="text-xs text-slate-500">
              {connectionStatus === 'connected' || !conversationId ? 'Online · we usually reply within seconds' : 'Reconnecting…'}
            </p>
          </div>
        </div>
      </header>

      <section aria-label="Support conversation" className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        {statusNotice && <p className={`mx-4 mt-3 rounded-lg px-3 py-2 text-sm ${statusNotice.className}`}>{statusNotice.text}</p>}
        {pageError && (
          <div className="mx-4 mt-3">
            <ErrorBanner title="Something went wrong" message={pageError.message} requestId={pageError.requestId} onDismiss={() => setPageError(null)} />
          </div>
        )}

        <div ref={messageLogRef} role="log" aria-live="polite" aria-label="Conversation" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {isLoading ? (
            <p className="py-12 text-center text-sm text-slate-500" role="status">Loading your conversation…</p>
          ) : messages.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-base font-semibold text-slate-800">How can we help?</p>
              <p className="mt-1 text-sm text-slate-500">Describe your problem below and our assistant will reply right away.</p>
            </div>
          ) : (
            groupMessagesBySender(messages).map((messageGroup) => <CustomerMessageGroup key={messageGroup.groupKey} messageGroup={messageGroup} />)
          )}
          {isAwaitingReply && <ReplyingIndicator />}
        </div>

        <MessageComposer canSendMessage={!isLoading} sendDisabledReason="Loading your conversation…" onSendMessage={sendMessage} />
      </section>
    </div>
  );
}
