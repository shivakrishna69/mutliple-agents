/**
 * One department agent's chat (/agents/:departmentId), for the people it answers:
 *
 *   left     the person's conversations with this agent, newest first: open one, start a new one,
 *            delete one, or delete them all
 *   right    the open conversation (components/agentChat/ChatMessages.jsx) and the question box
 *
 * Asking streams the answer (api/agentChatApi.js streamAgentQuestion): the question shows at once,
 * the answer as it is written, and the stored answer replaces it when it is complete (the backend's
 * checks may change it). A new conversation gets its address (?conversation=<id>) as soon as the
 * backend stores the question, so a reload or a notification link opens it again. When asking fails,
 * the question goes back into the box so it can be sent again.
 *
 * Who may ask is the backend's decision: a refusal is shown as it sends it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import {
  requestAgentConversation,
  requestAgentConversationDeletion,
  requestAgentConversations,
  requestAgentConversationsClear,
  requestAvailableAgents,
  streamAgentQuestion,
} from '../api/agentChatApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ChatMessages from '../components/agentChat/ChatMessages.jsx';
import { ArrowLeftIcon, PaperAirplaneIcon, PlusIcon } from '../components/Icons.jsx';
import { Badge, LoadingBlock, Notice, formatDateTime } from '../components/ui.jsx';
import { AUDIENCE_DISPLAY, QUESTION_MAX_LENGTH, STREAM_EVENTS } from '../constants/agentChat.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';

const CONVERSATION_PARAMETER = 'conversation';

function ConversationList({ conversations, activeId, onOpen, onNew, onDelete, onClear, isBusy }) {
  return (
    <nav aria-label="Your conversations" className="flex h-full flex-col">
      <div className="p-3">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-500 focus-visible:ring-4 focus-visible:ring-brand-200 focus-visible:outline-none"
        >
          <PlusIcon className="h-4 w-4" />
          New conversation
        </button>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-3 pb-3 scroll-thin">
        {conversations.length === 0 && <li className="px-2 py-4 text-sm text-slate-500">No conversations yet.</li>}
        {conversations.map((conversation) => {
          const isActive = conversation.id === activeId;
          return (
            <li key={conversation.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => onOpen(conversation.id)}
                aria-current={isActive ? 'true' : undefined}
                className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
                  isActive ? 'bg-brand-50 text-brand-900' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span className="block truncate text-sm font-medium">{conversation.title}</span>
                <span className="block text-xs text-slate-500">{formatDateTime(conversation.lastMessageAt)}</span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(conversation)}
                disabled={isBusy}
                aria-label={`Delete conversation ${conversation.title}`}
                className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600 focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:outline-none disabled:opacity-50"
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>
      {conversations.length > 0 && (
        <div className="border-t border-slate-100 p-3">
          <button
            type="button"
            onClick={onClear}
            disabled={isBusy}
            className="w-full rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none disabled:opacity-50"
          >
            Delete all conversations
          </button>
        </div>
      )}
    </nav>
  );
}

function QuestionBox({ isAsking, onAsk, draft, onDraftChange }) {
  function submit(submitEvent) {
    submitEvent.preventDefault();
    if (draft.trim() && !isAsking) onAsk(draft.trim());
  }
  return (
    <form onSubmit={submit} className="border-t border-slate-200 bg-white p-3 sm:p-4">
      <label htmlFor="agent-question" className="sr-only">
        Your question
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id="agent-question"
          value={draft}
          onChange={(changeEvent) => onDraftChange(changeEvent.target.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) submit(keyEvent);
          }}
          rows={2}
          maxLength={QUESTION_MAX_LENGTH}
          placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
          className="block max-h-40 min-h-[2.75rem] w-full resize-y rounded-xl border-0 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 ring-1 ring-slate-300 ring-inset placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isAsking || !draft.trim()}
          aria-label="Send question"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm transition hover:bg-brand-500 focus-visible:ring-4 focus-visible:ring-brand-200 focus-visible:outline-none disabled:opacity-50"
        >
          <PaperAirplaneIcon className="h-5 w-5" />
        </button>
      </div>
    </form>
  );
}

export default function AgentChat() {
  const { departmentId } = useParams();
  const [searchParameters, setSearchParameters] = useSearchParams();
  const location = useLocation();
  const { csrfToken } = useAuth();
  const conversationId = searchParameters.get(CONVERSATION_PARAMETER);

  const agentsResource = useApiResource((signal) => requestAvailableAgents(signal), []);
  const conversationsResource = useApiResource(
    (signal) => requestAgentConversations(departmentId, signal),
    [departmentId],
  );
  const entry = useMemo(
    () => agentsResource.data?.agents.find((candidate) => candidate.department.id === departmentId) ?? null,
    [agentsResource.data, departmentId],
  );

  // The messages on screen, with the conversation (and load) they belong to: what is shown is
  // worked out from the address, so opening another conversation never shows the last one's.
  const [thread, setThread] = useState({ key: null, messages: [] });
  const [failedLoadKey, setFailedLoadKey] = useState(null);
  const [pending, setPending] = useState(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [isChanging, setIsChanging] = useState(false);
  const loadedKey = useRef(null);
  // The stored question of the answer being streamed (from the "started" event).
  const askedMessage = useRef(null);
  const endOfMessages = useRef(null);

  // Opening a conversation (or opening it again from a notification) loads its messages.
  const refreshToken = location.state?.refreshedAt ?? null;
  const loadKey = conversationId ? `${conversationId}|${refreshToken}` : null;
  const messages = useMemo(() => (loadKey && thread.key === loadKey ? thread.messages : []), [loadKey, thread]);
  const isLoadingMessages = Boolean(loadKey) && thread.key !== loadKey && failedLoadKey !== loadKey;
  useEffect(() => {
    if (!loadKey || loadKey === loadedKey.current) return undefined;
    const controller = new AbortController();
    requestAgentConversation(departmentId, conversationId, controller.signal)
      .then((data) => {
        loadedKey.current = loadKey;
        setThread({ key: loadKey, messages: data.messages });
        setError(null);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        loadedKey.current = loadKey;
        setFailedLoadKey(loadKey);
        setError(toDisplayError(loadError));
      });
    return () => controller.abort();
  }, [loadKey, departmentId, conversationId]);

  const setMessages = (update) => setThread((current) => ({ ...current, messages: update(current.messages) }));

  useEffect(() => {
    endOfMessages.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, pending]);

  function openConversation(id) {
    setError(null);
    setSearchParameters(id ? { [CONVERSATION_PARAMETER]: id } : {});
  }

  function upsertConversation(conversation) {
    const others = (conversationsResource.data?.conversations ?? []).filter(
      (existing) => existing.id !== conversation.id,
    );
    conversationsResource.setData({ conversations: [conversation, ...others] });
  }

  async function ask(question) {
    setError(null);
    setPending({ question, answerText: '' });
    setDraft('');
    let failed = null;
    try {
      await streamAgentQuestion({
        departmentId,
        question,
        conversationId,
        csrfToken,
        onEvent: (event) => {
          if (event.type === STREAM_EVENTS.STARTED) {
            upsertConversation(event.conversation);
            if (event.conversation.id !== conversationId) {
              // A new conversation: give it its address without reloading what is on screen.
              const newKey = `${event.conversation.id}|null`;
              loadedKey.current = newKey;
              setThread({ key: newKey, messages: [] });
              setSearchParameters({ [CONVERSATION_PARAMETER]: event.conversation.id }, { replace: true });
            }
            askedMessage.current = event.userMessage;
          } else if (event.type === STREAM_EVENTS.DELTA) {
            setPending((current) => current && { ...current, answerText: current.answerText + event.text });
          } else if (event.type === STREAM_EVENTS.FINAL) {
            const asked = askedMessage.current;
            askedMessage.current = null;
            setMessages((existing) => [...existing, asked, event.message].filter(Boolean));
            setPending(null);
            upsertConversation(event.conversation);
          } else if (event.type === STREAM_EVENTS.ERROR) {
            failed = { message: event.message };
          }
        },
      });
    } catch (askError) {
      failed = toDisplayError(askError);
    }
    if (failed) {
      setPending(null);
      setError(failed);
      setDraft(question);
    }
  }

  function updateMessage(updated) {
    if (!updated) return;
    setMessages((existing) => existing.map((message) => (message.id === updated.id ? updated : message)));
  }

  async function deleteConversation(conversation) {
    if (!window.confirm(`Delete "${conversation.title}"? This cannot be undone.`)) return;
    setIsChanging(true);
    try {
      await requestAgentConversationDeletion(departmentId, conversation.id, csrfToken);
      conversationsResource.setData({
        conversations: conversationsResource.data.conversations.filter((existing) => existing.id !== conversation.id),
      });
      if (conversation.id === conversationId) openConversation(null);
    } catch (deleteError) {
      setError(toDisplayError(deleteError));
    } finally {
      setIsChanging(false);
    }
  }

  async function clearConversations() {
    if (!window.confirm('Delete all your conversations with this agent? This cannot be undone.')) return;
    setIsChanging(true);
    try {
      await requestAgentConversationsClear(departmentId, csrfToken);
      conversationsResource.setData({ conversations: [] });
      openConversation(null);
    } catch (clearError) {
      setError(toDisplayError(clearError));
    } finally {
      setIsChanging(false);
    }
  }

  const backLink = (
    <Link
      to={ROUTE_PATHS.ASK_AGENTS}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      All agents
    </Link>
  );

  if (agentsResource.isLoading && !agentsResource.data) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 sm:px-8">
        {backLink}
        <LoadingBlock label="Loading the agent…" />
      </div>
    );
  }
  if (!entry) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 sm:px-8">
        {backLink}
        <Notice
          tone="warning"
          title={agentsResource.error?.message ?? "This agent isn't available to you. Pick one from the list."}
        />
      </div>
    );
  }

  const departmentName = entry.department.name;
  const isEmpty = messages.length === 0 && !pending && !isLoadingMessages;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="min-w-0">
          {backLink}
          <h1 className="mt-1 truncate text-lg font-semibold text-slate-900">{entry.agent.name}</h1>
          <p className="text-sm text-slate-500">{departmentName}</p>
        </div>
        <Badge tone={entry.audience === 'COMPANY' ? 'sky' : 'slate'}>{AUDIENCE_DISPLAY[entry.audience]}</Badge>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-white md:block">
          <ConversationList
            conversations={conversationsResource.data?.conversations ?? []}
            activeId={conversationId}
            onOpen={openConversation}
            onNew={() => openConversation(null)}
            onDelete={deleteConversation}
            onClear={clearConversations}
            isBusy={isChanging || Boolean(pending)}
          />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col" aria-label={`Chat with ${entry.agent.name}`}>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 scroll-thin sm:px-6">
            {error && (
              <div className="mb-4">
                <Notice tone="error" title={error.message} onDismiss={() => setError(null)} />
              </div>
            )}
            {isLoadingMessages && <LoadingBlock label="Loading the conversation…" />}
            {isEmpty && (
              <div className="mx-auto max-w-lg py-12 text-center">
                <p className="text-base font-semibold text-slate-800">Ask {entry.agent.name}</p>
                <p className="mt-2 text-sm text-slate-500">
                  It answers from {departmentName}'s documents and shows its sources. If it can't answer, your question
                  goes to the {departmentName} team, and you'll be notified when they reply.
                </p>
              </div>
            )}
            <ChatMessages
              departmentId={departmentId}
              departmentName={departmentName}
              agentName={entry.agent.name}
              messages={messages}
              pending={pending}
              onMessageUpdated={updateMessage}
            />
            <div ref={endOfMessages} />
          </div>
          <QuestionBox isAsking={Boolean(pending)} onAsk={ask} draft={draft} onDraftChange={setDraft} />
        </section>
      </div>
    </div>
  );
}
