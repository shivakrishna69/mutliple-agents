/**
 * ChatConsole: the three-pane support workspace.
 *
 *   ┌────────────────────┬──────────────────────────────────┬──────────────────────┐
 *   │ ConversationList   │ ChatPane                         │ InspectorPane        │
 *   │ Pane               │   header (customer, status)      │   CustomerDetailsCard│
 *   │  list of active    │   message log, grouped by sender │   ConversationCard   │
 *   │  conversations,    │   MessageComposer (bottom)       │   SystemLogList      │
 *   │  status chips      │                                  │                      │
 *   └────────────────────┴──────────────────────────────────┴──────────────────────┘
 *    lg and up: three columns (18rem | flexible | 20rem), each scrolling independently.
 *    Below lg: the panes stack (list, chat, inspector) and the page scrolls.
 *    The grid fills its parent's height, so the page decides how much of the screen it gets.
 *
 * Purely presentational: it owns no server data. The caller supplies conversations and messages
 * and reacts to callbacks, so the same component works with HTTP-loaded data and with live
 * updates from hooks/useSocket.js. The only internal state is UI state: the composer draft,
 * whether a send is in flight, and the send error.
 *
 * Data shapes match what the backend already produces (utils/realtimePayloads.js):
 *
 * @typedef {Object} ConversationSummary
 * @property {string} conversationId
 * @property {string} status                'unassigned' | 'processing-ai' | 'escalated-to-human' | 'assigned-agent'
 * @property {string} [customerName]
 * @property {string} [customerEmail]
 * @property {string} [lastMessagePreview]
 * @property {string} [updatedAt]           ISO timestamp
 *
 * @typedef {Object} ToolExecutionLog
 * @property {number} step
 * @property {string} node
 * @property {string|null} [toolName]
 * @property {string} status               'success' | 'error'
 * @property {string|null} [error]
 * @property {unknown} [output]
 * @property {string} [startedAt]
 *
 * @typedef {Object} ChatMessage            Staff payload of NEW_MESSAGE
 * @property {string} messageId
 * @property {string} senderType           'customer' | 'ai_supervisor' | 'ai_worker' | 'human_agent'
 * @property {string} text
 * @property {string} createdAt
 * @property {ToolExecutionLog[]} [toolExecutionLogs]
 *
 * @typedef {Object} ConversationDetails   Staff payload of CONVERSATION_STATUS_UPDATED, plus customer
 * @property {string} conversationId
 * @property {string} status
 * @property {string} [currentActiveWorker]
 * @property {string|null} [assignedAgentId]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {{ id: string, name?: string, email?: string }} [customer]
 *
 * Security: every value is rendered as text through React, which escapes it; nothing uses
 * dangerouslySetInnerHTML. **bold** markdown from the AI is rendered by MessageText, which wraps text
 * nodes in <strong> without ever parsing HTML.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ACTIVE_WORKER_LABELS,
  CONVERSATION_STATUS_DISPLAY,
  LOG_STATUS_DISPLAY,
  MESSAGE_TEXT_MAX_LENGTH,
  SENDER_DISPLAY,
  UNKNOWN_SENDER_DISPLAY,
  UNKNOWN_STATUS_DISPLAY,
} from '../constants/conversationDisplay.js';
import MessageText from './MessageText.jsx';

// =================================================================================================
// Formatting and data helpers (pure functions)
// =================================================================================================

/** Consecutive messages from the same sender within this window share one header. */
const MESSAGE_GROUPING_WINDOW_MS = 5 * 60 * 1000;
/** Keep auto-scrolling only while the reader is this close to the bottom of the log. */
const AUTO_SCROLL_THRESHOLD_PX = 120;

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function parseTimestamp(isoTimestamp) {
  const parsedDate = isoTimestamp ? new Date(isoTimestamp) : null;
  return parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;
}

function formatClockTime(isoTimestamp) {
  const parsedDate = parseTimestamp(isoTimestamp);
  return parsedDate ? timeFormatter.format(parsedDate) : '';
}

function formatFullDateTime(isoTimestamp) {
  const parsedDate = parseTimestamp(isoTimestamp);
  return parsedDate ? dateTimeFormatter.format(parsedDate) : '—';
}

/** "5 minutes ago", "yesterday", ...; the largest unit that fits. */
function formatRelativeTime(isoTimestamp) {
  const parsedDate = parseTimestamp(isoTimestamp);
  if (!parsedDate) return '';
  const elapsedSeconds = Math.round((parsedDate.getTime() - Date.now()) / 1000);
  const relativeUnits = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unitName, unitSeconds] of relativeUnits) {
    if (Math.abs(elapsedSeconds) >= unitSeconds) {
      return relativeTimeFormatter.format(Math.round(elapsedSeconds / unitSeconds), unitName);
    }
  }
  return 'just now';
}

function resolveStatusDisplay(status) {
  return CONVERSATION_STATUS_DISPLAY[status] ?? UNKNOWN_STATUS_DISPLAY;
}

function resolveSenderDisplay(senderType) {
  return SENDER_DISPLAY[senderType] ?? UNKNOWN_SENDER_DISPLAY;
}

/**
 * Groups consecutive messages from the same sender that are no more than
 * MESSAGE_GROUPING_WINDOW_MS apart, so the sender label and time render once per group.
 * @param {ChatMessage[]} messages  Oldest first.
 * @returns {{ groupKey: string, senderType: string, messages: ChatMessage[] }[]}
 */
export function groupMessagesBySender(messages) {
  const messageGroups = [];
  for (const message of messages) {
    const currentGroup = messageGroups.at(-1);
    const previousMessage = currentGroup?.messages.at(-1);
    const previousTime = parseTimestamp(previousMessage?.createdAt)?.getTime();
    const messageTime = parseTimestamp(message.createdAt)?.getTime();
    const isWithinWindow =
      previousTime !== undefined && messageTime !== undefined && messageTime - previousTime <= MESSAGE_GROUPING_WINDOW_MS;

    if (currentGroup && currentGroup.senderType === message.senderType && isWithinWindow) {
      currentGroup.messages.push(message);
    } else {
      messageGroups.push({ groupKey: message.messageId, senderType: message.senderType, messages: [message] });
    }
  }
  return messageGroups;
}

/**
 * Flattens the AI's audit trail (toolExecutionLogs on each message) into one list for the
 * inspector, newest first.
 * @param {ChatMessage[]} messages
 */
export function buildSystemLogEntries(messages) {
  const systemLogEntries = [];
  for (const message of messages) {
    for (const logEntry of message.toolExecutionLogs ?? []) {
      systemLogEntries.push({
        entryKey: `${message.messageId}-${logEntry.step}`,
        node: logEntry.node,
        status: logEntry.status,
        detail: logEntry.error || (typeof logEntry.output === 'string' ? logEntry.output : logEntry.toolName) || '',
        timestamp: logEntry.startedAt || message.createdAt,
      });
    }
  }
  return systemLogEntries.reverse();
}

// =================================================================================================
// Shared presentational pieces
// =================================================================================================

/** Colour-coded status indicator used in the list, chat header, and inspector. */
function StatusChip({ status }) {
  const statusDisplay = resolveStatusDisplay(status);
  return (
    <span
      title={statusDisplay.description}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusDisplay.chipClassName}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${statusDisplay.dotClassName}`} aria-hidden="true" />
      {statusDisplay.label}
    </span>
  );
}

function PaneHeader({ title, subtitle, children }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ title, description }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="mt-1 max-w-xs text-sm text-slate-500">{description}</p>}
    </div>
  );
}

function LoadingRows({ rowCount = 4, label }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 p-4">
      {Array.from({ length: rowCount }, (_, rowIndex) => (
        <div key={rowIndex} className="animate-pulse space-y-2 rounded-lg border border-slate-100 p-3">
          <div className="h-3 w-2/3 rounded bg-slate-200" />
          <div className="h-3 w-1/2 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

// =================================================================================================
// Left pane: conversation list
// =================================================================================================

function ConversationListItem({ conversation, isSelected, onSelect }) {
  const displayName = conversation.customerName || conversation.customerEmail || 'Unknown customer';
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(conversation.conversationId)}
        aria-current={isSelected ? 'true' : undefined}
        className={[
          'w-full rounded-lg px-3 py-2.5 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
          isSelected ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-slate-50',
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-slate-900">{displayName}</span>
          <span className="shrink-0 text-xs text-slate-400">{formatRelativeTime(conversation.updatedAt)}</span>
        </div>
        {conversation.lastMessagePreview && (
          <p className="mt-0.5 truncate text-xs text-slate-500">{conversation.lastMessagePreview}</p>
        )}
        <div className="mt-2">
          <StatusChip status={conversation.status} />
        </div>
      </button>
    </li>
  );
}

function ConversationListPane({ conversations, selectedConversationId, isLoading, onSelectConversation }) {
  return (
    <section aria-label="Conversations" className="flex min-h-0 flex-col border-b border-slate-200 bg-white lg:border-r lg:border-b-0">
      <PaneHeader title="Conversations" subtitle={isLoading ? 'Loading…' : `${conversations.length} active`} />
      <div className="max-h-80 min-h-0 flex-1 overflow-y-auto lg:max-h-none">
        {isLoading ? (
          <LoadingRows label="Loading conversations" />
        ) : conversations.length === 0 ? (
          <EmptyState title="No active conversations" description="New customer conversations appear here as they arrive." />
        ) : (
          <ul className="space-y-1 p-2">
            {conversations.map((conversation) => (
              <ConversationListItem
                key={conversation.conversationId}
                conversation={conversation}
                isSelected={conversation.conversationId === selectedConversationId}
                onSelect={onSelectConversation}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// =================================================================================================
// Center pane: chat log and composer
// =================================================================================================

function MessageGroup({ messageGroup }) {
  const senderDisplay = resolveSenderDisplay(messageGroup.senderType);
  const isEndAligned = senderDisplay.alignment === 'end';
  return (
    <div className={`flex flex-col gap-1 ${isEndAligned ? 'items-end' : 'items-start'}`}>
      <div className={`flex items-baseline gap-2 px-1 text-xs ${isEndAligned ? 'flex-row-reverse' : ''}`}>
        <span className={`font-semibold ${senderDisplay.labelClassName}`}>{senderDisplay.label}</span>
        <time className="text-slate-400" dateTime={messageGroup.messages[0].createdAt}>
          {formatClockTime(messageGroup.messages[0].createdAt)}
        </time>
      </div>
      {messageGroup.messages.map((message) => (
        <div
          key={message.messageId}
          className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm sm:max-w-[75%] ${senderDisplay.bubbleClassName}`}
        >
          <MessageText text={message.text} />
        </div>
      ))}
    </div>
  );
}

/**
 * Text input at the bottom of the chat. Enter sends, Shift+Enter inserts a line break.
 * `onSendMessage(text)` may return a promise: the draft is kept and the error shown if it rejects,
 * and cleared when it resolves. Sending is blocked while a send is in flight, so a double Enter
 * cannot send twice.
 */
export function MessageComposer({ canSendMessage, sendDisabledReason, onSendMessage }) {
  const [draftText, setDraftText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendErrorMessage, setSendErrorMessage] = useState(null);
  const isSendingRef = useRef(false);

  const trimmedDraft = draftText.trim();
  const isOverLimit = draftText.length > MESSAGE_TEXT_MAX_LENGTH;
  const isSendBlocked = !canSendMessage || isSending || trimmedDraft.length === 0 || isOverLimit;

  async function submitDraft() {
    if (isSendBlocked || isSendingRef.current) return;
    isSendingRef.current = true;
    setIsSending(true);
    setSendErrorMessage(null);
    try {
      await onSendMessage(trimmedDraft);
      setDraftText('');
    } catch (sendFailure) {
      setSendErrorMessage(sendFailure instanceof Error && sendFailure.message ? sendFailure.message : 'The message could not be sent.');
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
    }
  }

  function handleComposerKeyDown(keyboardEvent) {
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey && !keyboardEvent.nativeEvent.isComposing) {
      keyboardEvent.preventDefault();
      submitDraft();
    }
  }

  function handleComposerSubmit(submitEvent) {
    submitEvent.preventDefault();
    submitDraft();
  }

  return (
    <form onSubmit={handleComposerSubmit} className="border-t border-slate-200 bg-white p-3">
      <label htmlFor="chat-composer" className="sr-only">
        Message
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id="chat-composer"
          rows={2}
          value={draftText}
          onChange={(changeEvent) => setDraftText(changeEvent.target.value)}
          onKeyDown={handleComposerKeyDown}
          disabled={!canSendMessage || isSending}
          placeholder={canSendMessage ? 'Write a reply… (Enter to send, Shift+Enter for a new line)' : 'Replies are disabled'}
          aria-invalid={isOverLimit ? 'true' : 'false'}
          aria-describedby="chat-composer-hint"
          className="block max-h-40 min-h-[2.75rem] flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-100"
        />
        <button
          type="submit"
          disabled={isSendBlocked}
          aria-busy={isSending}
          className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-indigo-300"
        >
          {isSending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div id="chat-composer-hint" className="mt-1 flex justify-between gap-2 px-1 text-xs">
        <span className={sendErrorMessage ? 'text-red-600' : 'text-slate-400'} role={sendErrorMessage ? 'alert' : undefined}>
          {sendErrorMessage ?? (canSendMessage ? '' : sendDisabledReason)}
        </span>
        <span className={isOverLimit ? 'font-medium text-red-600' : 'text-slate-400'}>
          {draftText.length > MESSAGE_TEXT_MAX_LENGTH * 0.9 ? `${draftText.length.toLocaleString()} / ${MESSAGE_TEXT_MAX_LENGTH.toLocaleString()}` : ''}
        </span>
      </div>
    </form>
  );
}

function ChatPane({
  conversationDetails,
  messages,
  isLoadingMessages,
  canSendMessage,
  sendDisabledReason,
  onSendMessage,
  chatHeaderActions,
}) {
  const messageLogRef = useRef(null);
  const isPinnedToBottomRef = useRef(true);
  const selectedConversationId = conversationDetails?.conversationId;

  // Track whether the reader is at the bottom, so new messages only auto-scroll if they were.
  function handleMessageLogScroll() {
    const messageLog = messageLogRef.current;
    if (!messageLog) return;
    isPinnedToBottomRef.current =
      messageLog.scrollHeight - messageLog.scrollTop - messageLog.clientHeight <= AUTO_SCROLL_THRESHOLD_PX;
  }

  // Opening a conversation always starts at its newest message.
  useEffect(() => {
    isPinnedToBottomRef.current = true;
  }, [selectedConversationId]);

  useEffect(() => {
    const messageLog = messageLogRef.current;
    if (messageLog && isPinnedToBottomRef.current) {
      messageLog.scrollTop = messageLog.scrollHeight;
    }
  }, [messages, selectedConversationId]);

  if (!conversationDetails) {
    return (
      <section aria-label="Chat" className="flex min-h-[24rem] flex-col bg-slate-50 lg:min-h-0">
        <EmptyState title="No conversation selected" description="Choose a conversation from the list to read and reply." />
      </section>
    );
  }

  const customerLabel = conversationDetails.customer?.name || conversationDetails.customer?.email || 'Customer';
  return (
    <section aria-label={`Chat with ${customerLabel}`} className="flex min-h-[32rem] flex-col bg-slate-50 lg:min-h-0">
      <PaneHeader title={customerLabel} subtitle={conversationDetails.customer?.email}>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip status={conversationDetails.status} />
          {chatHeaderActions}
        </div>
      </PaneHeader>

      <div
        ref={messageLogRef}
        onScroll={handleMessageLogScroll}
        role="log"
        aria-live="polite"
        aria-label="Messages"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {isLoadingMessages ? (
          <LoadingRows rowCount={3} label="Loading messages" />
        ) : messages.length === 0 ? (
          <EmptyState title="No messages yet" />
        ) : (
          groupMessagesBySender(messages).map((messageGroup) => (
            <MessageGroup key={messageGroup.groupKey} messageGroup={messageGroup} />
          ))
        )}
      </div>

      {/* Keyed by conversation so a draft never carries over to a different customer. */}
      <MessageComposer
        key={selectedConversationId}
        canSendMessage={canSendMessage}
        sendDisabledReason={sendDisabledReason}
        onSendMessage={onSendMessage}
      />
    </section>
  );
}

// =================================================================================================
// Right pane: metadata inspector
// =================================================================================================

function DetailRow({ label, children }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-slate-900">{children}</dd>
    </div>
  );
}

function InspectorCard({ title, children }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
      {children}
    </div>
  );
}

function CustomerDetailsCard({ customer }) {
  return (
    <InspectorCard title="Customer">
      <dl className="divide-y divide-slate-100">
        <DetailRow label="Name">{customer?.name || '—'}</DetailRow>
        <DetailRow label="Email">{customer?.email || '—'}</DetailRow>
        <DetailRow label="Customer ID">
          <span className="font-mono text-xs">{customer?.id || '—'}</span>
        </DetailRow>
      </dl>
    </InspectorCard>
  );
}

function ConversationCard({ conversationDetails }) {
  return (
    <InspectorCard title="Conversation">
      <dl className="divide-y divide-slate-100">
        <DetailRow label="Status">
          <StatusChip status={conversationDetails.status} />
        </DetailRow>
        <DetailRow label="Handled by">
          {ACTIVE_WORKER_LABELS[conversationDetails.currentActiveWorker] || conversationDetails.currentActiveWorker || '—'}
        </DetailRow>
        <DetailRow label="Assigned agent">
          <span className="font-mono text-xs">{conversationDetails.assignedAgentId || 'None'}</span>
        </DetailRow>
        <DetailRow label="Started">{formatFullDateTime(conversationDetails.createdAt)}</DetailRow>
        <DetailRow label="Last update">{formatFullDateTime(conversationDetails.updatedAt)}</DetailRow>
        <DetailRow label="Conversation ID">
          <span className="font-mono text-xs">{conversationDetails.conversationId}</span>
        </DetailRow>
      </dl>
    </InspectorCard>
  );
}

function SystemLogList({ systemLogEntries }) {
  return (
    <InspectorCard title="System logs">
      {systemLogEntries.length === 0 ? (
        <p className="text-sm text-slate-500">No AI activity recorded for this conversation yet.</p>
      ) : (
        <ol className="space-y-2">
          {systemLogEntries.map((systemLogEntry) => {
            const logStatusDisplay = LOG_STATUS_DISPLAY[systemLogEntry.status] ?? LOG_STATUS_DISPLAY.success;
            return (
              <li key={systemLogEntry.entryKey} className="rounded-lg bg-slate-50 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-medium text-slate-700">{systemLogEntry.node}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold ring-1 ring-inset ${logStatusDisplay.className}`}>
                    {logStatusDisplay.label}
                  </span>
                </div>
                {systemLogEntry.detail && (
                  <p className="mt-1 text-xs break-words text-slate-600">{systemLogEntry.detail}</p>
                )}
                <time className="mt-1 block text-[0.65rem] text-slate-400" dateTime={systemLogEntry.timestamp}>
                  {formatFullDateTime(systemLogEntry.timestamp)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </InspectorCard>
  );
}

function InspectorPane({ conversationDetails, messages }) {
  return (
    <aside aria-label="Conversation details" className="min-h-0 border-t border-slate-200 bg-slate-50 lg:border-t-0 lg:border-l">
      <div className="h-full space-y-4 overflow-y-auto p-4">
        {conversationDetails ? (
          <>
            <CustomerDetailsCard customer={conversationDetails.customer} />
            <ConversationCard conversationDetails={conversationDetails} />
            <SystemLogList systemLogEntries={buildSystemLogEntries(messages)} />
          </>
        ) : (
          <EmptyState title="Details" description="Customer details and system logs for the selected conversation appear here." />
        )}
      </div>
    </aside>
  );
}

// =================================================================================================
// Layout
// =================================================================================================

/**
 * @param {Object} props
 * @param {ConversationSummary[]} props.conversations      Shown in the left pane, in the given order.
 * @param {string|null} props.selectedConversationId
 * @param {(conversationId: string) => void} props.onSelectConversation
 * @param {ConversationDetails|null} props.conversationDetails  The selected conversation, or null.
 * @param {ChatMessage[]} props.messages                   The selected conversation's messages, oldest first.
 * @param {(text: string) => Promise<void>|void} props.onSendMessage  Rejecting keeps the draft and shows the error.
 * @param {boolean} [props.canSendMessage]                 False disables the composer.
 * @param {string} [props.sendDisabledReason]              Shown in the composer while sending is disabled.
 * @param {boolean} [props.isLoadingConversations]
 * @param {boolean} [props.isLoadingMessages]
 * @param {import('react').ReactNode} [props.chatHeaderActions]  Extra controls in the chat header (e.g. Claim).
 */
export default function ChatConsole({
  conversations,
  selectedConversationId,
  onSelectConversation,
  conversationDetails,
  messages,
  onSendMessage,
  canSendMessage = true,
  sendDisabledReason = 'You cannot reply to this conversation.',
  isLoadingConversations = false,
  isLoadingMessages = false,
  chatHeaderActions = null,
}) {
  return (
    <div className="grid min-h-full grid-cols-1 bg-slate-100 lg:h-full lg:grid-cols-[18rem_minmax(0,1fr)_20rem] lg:overflow-hidden">
      <ConversationListPane
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        isLoading={isLoadingConversations}
        onSelectConversation={onSelectConversation}
      />
      <ChatPane
        conversationDetails={conversationDetails}
        messages={messages}
        isLoadingMessages={isLoadingMessages}
        canSendMessage={canSendMessage}
        sendDisabledReason={sendDisabledReason}
        onSendMessage={onSendMessage}
        chatHeaderActions={chatHeaderActions}
      />
      <InspectorPane conversationDetails={conversationDetails} messages={messages} />
    </div>
  );
}
