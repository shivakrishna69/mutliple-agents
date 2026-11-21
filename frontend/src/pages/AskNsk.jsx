/**
 * Ask NSK (/ask-nsk, USE_NSK_ASSISTANT): the NSK assistant as a full page, laid out like a department
 * agent's chat (pages/AgentChat.jsx). Opened from the top bar, the sidebar, the mobile header and the
 * My Access launcher.
 *
 *   rail       New conversation, then the person's conversations (GET /api/nsk-bot/sessions), newest
 *              first, the open one highlighted; each can be deleted (DELETE /api/nsk-bot/sessions/:id).
 *              Below md the rail is a compact menu above the chat.
 *   resume     on a fresh chat, the backend's "pick up where you left off" banner for the latest
 *              conversation, with its "Continue: …" chip and the questions it predicted next
 *   quick start  on a fresh chat, the backend's complete starters for what this person may ask (its
 *              promptHelpers whose text needs nothing added), one tap to ask
 *   a turn     POST /api/nsk-bot/message; the person's words show at once and a typing indicator runs
 *              while NSK checks its tools and sources; the reply comes back checked, with its sources
 *   cards      suggestion chips send their text (a "Yes, start offboarding for …" chip does what its
 *              card does); Start offboarding package opens the offboarding form in the conversation
 *              (OffboardingPanel.jsx); View profile first asks for the profile
 *   type-ahead as the person types, up to three sentence starters above the box (the backend's
 *              promptHelpers for their intents, matched on the device: utils/nskBot.js
 *              matchPromptHelpers); a click puts the starter in the box to finish or send
 *
 * Errors are the backend's messages.
 */

import { useEffect, useRef, useState } from 'react';
import { requestNskSession, requestNskSessionDeletion, requestNskSessions, sendNskMessage } from '../api/nskBotApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import NskMessage, { SuggestionChips } from '../components/nskBot/NskMessage.jsx';
import OffboardingPanel from '../components/nskBot/OffboardingPanel.jsx';
import {
  ChatIcon,
  ChevronDownIcon,
  CloseIcon,
  PaperAirplaneIcon,
  PlusIcon,
  SparklesIcon,
} from '../components/Icons.jsx';
import { Notice, Spinner, formatDateTime } from '../components/ui.jsx';
import {
  NSK_ACTION_KINDS,
  NSK_LABELS,
  NSK_MESSAGE_MAX_LENGTH,
  NSK_MESSAGE_ROLES,
  NSK_QUICK_START_LIMIT,
  viewProfileMessage,
} from '../constants/nskBot.js';
import { toDisplayError } from '../hooks/useApiResource.js';
import { matchPromptHelpers, quickStartsFrom } from '../utils/nskBot.js';

let pendingCounter = 0;

function TypingIndicator() {
  return (
    <li className="flex justify-start" role="status" aria-live="polite" data-testid="nsk-typing">
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2.5 text-xs text-slate-500">
        <span className="flex gap-1" aria-hidden="true">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        {NSK_LABELS.THINKING}
      </div>
    </li>
  );
}

/** The conversations, as the left rail (md and up). */
function ConversationRail({ sessions, activeSessionId, onOpen, onDelete, onNew, isBusy }) {
  return (
    <nav aria-label={NSK_LABELS.SESSIONS} className="flex h-full flex-col">
      <div className="p-3">
        <button
          type="button"
          onClick={onNew}
          disabled={isBusy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm shadow-indigo-500/30 transition hover:brightness-110 focus-visible:ring-4 focus-visible:ring-brand-200 focus-visible:outline-none disabled:opacity-60"
        >
          <PlusIcon className="h-4 w-4" />
          {NSK_LABELS.NEW_CONVERSATION}
        </button>
      </div>
      <p className="px-5 pt-1 pb-2 text-[0.68rem] font-semibold tracking-[0.12em] text-slate-500 uppercase">
        {NSK_LABELS.SESSIONS}
      </p>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3 scroll-thin" data-testid="nsk-conversations">
        {sessions === null && (
          <li className="flex justify-center py-6">
            <Spinner className="h-5 w-5 text-brand-500" />
          </li>
        )}
        {sessions?.length === 0 && <li className="px-2 py-4 text-sm text-slate-500">{NSK_LABELS.NO_SESSIONS}</li>}
        {(sessions ?? []).map((session) => {
          const isActive = session.id === activeSessionId;
          return (
            <li key={session.id} className="group flex items-center gap-1">
              <button
                type="button"
                disabled={isBusy}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onOpen(session.id)}
                className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
                  isActive ? 'nav-pill-active text-white' : 'text-slate-700 hover:bg-white/70'
                }`}
              >
                <span className="block truncate text-sm font-medium">{session.title}</span>
                <span className={`block text-xs ${isActive ? 'text-white/80' : 'text-slate-500'}`}>
                  {formatDateTime(session.lastMessageAt)}
                </span>
              </button>
              <button
                type="button"
                disabled={isBusy}
                aria-label={`${NSK_LABELS.DELETE_SESSION}: ${session.title}`}
                onClick={() => onDelete(session)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:outline-none disabled:opacity-50"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The conversations as a compact menu, below md (the rail is hidden there). */
function ConversationMenu({ sessions, activeSessionId, onOpen, onNew, isBusy }) {
  const [isOpen, setIsOpen] = useState(false);
  const active = (sessions ?? []).find((session) => session.id === activeSessionId);
  return (
    <div className="relative md:hidden">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 ring-1 ring-slate-200"
        >
          <span className="truncate">{active?.title ?? NSK_LABELS.NEW_CHAT}</span>
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
        </button>
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            onNew();
          }}
          disabled={isBusy}
          aria-label={NSK_LABELS.NEW_CONVERSATION}
          className="rounded-lg p-1.5 text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50 disabled:opacity-60"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>
      {isOpen && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-xl bg-white p-1 shadow-lg ring-1 ring-slate-200">
          {(sessions ?? []).length === 0 && (
            <li className="px-2 py-2 text-xs text-slate-500">{NSK_LABELS.NO_SESSIONS}</li>
          )}
          {(sessions ?? []).map((session) => (
            <li key={session.id}>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  setIsOpen(false);
                  onOpen(session.id);
                }}
                className={`w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-50 ${session.id === activeSessionId ? 'font-semibold text-brand-700' : 'text-slate-700'}`}
              >
                {session.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PromptHelpers({ helpers, onPick }) {
  if (helpers.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={NSK_LABELS.PROMPT_HELPERS} data-testid="nsk-prompt-helpers">
      {helpers.map((helper) => (
        <li key={helper.label}>
          <button
            type="button"
            // Keeps the focus in the message box while clicking.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(helper)}
            className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-200 transition hover:bg-brand-50 hover:text-brand-800 hover:ring-brand-200 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
          >
            <SparklesIcon className="h-3 w-3 shrink-0 text-brand-500" />
            {helper.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One-tap questions for a fresh chat. */
function QuickStarts({ starters, onAsk, isBusy }) {
  if (starters.length === 0) return null;
  return (
    <ul
      className="mt-6 flex flex-wrap justify-center gap-2"
      aria-label={NSK_LABELS.QUICK_START}
      data-testid="nsk-quick-start"
    >
      {starters.map((starter) => (
        <li key={starter.label}>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => onAsk(starter.fill)}
            className="flex items-center gap-1.5 rounded-full bg-white/80 px-3.5 py-2 text-sm text-slate-700 shadow-[inset_0_1px_1px_rgb(255_255_255/0.9)] ring-1 ring-slate-900/[0.08] transition hover:bg-white hover:text-brand-800 hover:ring-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none disabled:opacity-60"
          >
            <SparklesIcon className="h-3.5 w-3.5 shrink-0 text-brand-600" />
            {starter.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ResumeBanner({ resume, onContinue, onSuggestion, isBusy }) {
  return (
    <div className="mx-auto max-w-3xl rounded-xl bg-brand-50 p-3 ring-1 ring-brand-200" data-testid="nsk-resume">
      <p className="text-sm font-medium text-brand-900">{resume.prompt}</p>
      <SuggestionChips
        suggestions={resume.suggestions}
        disabled={isBusy}
        onSelect={(text) =>
          text === resume.suggestions[0]?.text && resume.session.lastIntent ? onContinue() : onSuggestion(text)
        }
        label=""
      />
    </div>
  );
}

export default function AskNsk() {
  const { csrfToken } = useAuth();
  const [sessions, setSessions] = useState(null);
  const [resume, setResume] = useState(null);
  const [promptHelpers, setPromptHelpers] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [offboardingTarget, setOffboardingTarget] = useState(null);
  const listEndRef = useRef(null);
  const inputRef = useRef(null);
  const isSending = busy === 'send';

  useEffect(() => {
    const controller = new AbortController();
    requestNskSessions(controller.signal)
      .then((data) => {
        setSessions(data.sessions);
        setResume(data.resume);
        setPromptHelpers(data.promptHelpers ?? []);
      })
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') {
          setSessions([]);
          setError(toDisplayError(loadError).message);
        }
      });
    inputRef.current?.focus();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, busy, offboardingTarget]);

  async function openSession(sessionId) {
    setBusy('load');
    setError(null);
    setOffboardingTarget(null);
    try {
      const data = await requestNskSession(sessionId);
      setActiveSessionId(sessionId);
      setMessages(data.messages);
      setResume(null);
      return true;
    } catch (loadError) {
      setError(toDisplayError(loadError).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  function newChat() {
    setActiveSessionId(null);
    setMessages([]);
    setOffboardingTarget(null);
    setError(null);
    inputRef.current?.focus();
  }

  async function deleteSession(session) {
    setBusy('delete');
    setError(null);
    try {
      await requestNskSessionDeletion(session.id, csrfToken);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      if (resume?.session.id === session.id) setResume(null);
      if (activeSessionId === session.id) newChat();
    } catch (deleteError) {
      setError(toDisplayError(deleteError).message);
    } finally {
      setBusy(null);
    }
  }

  async function send(text, sessionId = activeSessionId) {
    const message = text.trim();
    if (!message || busy) return;
    pendingCounter += 1;
    const pendingId = `pending-${pendingCounter}`;
    setMessages((current) => [...current, { id: pendingId, role: NSK_MESSAGE_ROLES.USER, content: message }]);
    setDraft('');
    setBusy('send');
    setError(null);
    setResume(null);
    try {
      const result = await sendNskMessage({ message, sessionId }, csrfToken);
      setActiveSessionId(result.session.id);
      setMessages((current) => [
        ...current.filter((item) => item.id !== pendingId),
        result.userMessage,
        result.message,
      ]);
      setSessions((current) => [result.session, ...(current ?? []).filter((item) => item.id !== result.session.id)]);
    } catch (sendError) {
      setMessages((current) => current.filter((item) => item.id !== pendingId));
      setDraft(message);
      setError(toDisplayError(sendError).message);
    } finally {
      setBusy(null);
    }
  }

  async function continueResume() {
    await openSession(resume.session.id);
  }

  async function resumeWith(text) {
    const sessionId = resume.session.id;
    if (await openSession(sessionId)) await send(text, sessionId);
  }

  function handleAction(action) {
    if (action.kind === NSK_ACTION_KINDS.START_OFFBOARDING) {
      setOffboardingTarget({
        employeeId: action.employeeId,
        employeeName: action.employeeName,
        employeeCode: action.employeeCode,
      });
    } else {
      send(viewProfileMessage(action.employeeName, action.employeeCode));
    }
  }

  function pickPromptHelper(helper) {
    setDraft(helper.fill);
    inputRef.current?.focus();
  }

  const isFresh = messages.length === 0 && !activeSessionId;
  const helperMatches = busy === null ? matchPromptHelpers(draft, promptHelpers) : [];
  const quickStarts = quickStartsFrom(promptHelpers, NSK_QUICK_START_LIMIT);
  const latestReplyId = [...messages].reverse().find((message) => message.role === NSK_MESSAGE_ROLES.ASSISTANT)?.id;
  const railProps = {
    sessions,
    activeSessionId,
    onOpen: openSession,
    onNew: newChat,
    isBusy: busy !== null,
  };

  return (
    <div className="flex h-full min-h-0 gap-4 p-3 sm:p-4" data-testid="nsk-workspace">
      <aside className="glass-card hidden w-[280px] shrink-0 overflow-hidden md:block">
        <ConversationRail {...railProps} onDelete={deleteSession} />
      </aside>

      <section className="glass-card flex min-w-0 flex-1 flex-col overflow-hidden" aria-labelledby="ask-nsk-title">
        <header className="hairline-b flex shrink-0 flex-col gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 via-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-500/30">
              <SparklesIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 id="ask-nsk-title" className="text-lg font-semibold text-slate-900">
                {NSK_LABELS.OPEN}
              </h1>
              <p className="text-sm text-slate-500">{NSK_LABELS.SUBTITLE}</p>
            </div>
          </div>
          <ConversationMenu {...railProps} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 scroll-thin sm:px-6">
          <div className="mx-auto max-w-4xl space-y-4">
            {resume && isFresh && (
              <ResumeBanner
                resume={resume}
                onContinue={continueResume}
                onSuggestion={resumeWith}
                isBusy={busy !== null}
              />
            )}
            {sessions !== null && isFresh && (
              <div className="py-8 text-center">
                <ChatIcon className="mx-auto h-10 w-10 text-brand-300" />
                <p className="mt-3 text-base font-semibold text-slate-800">{NSK_LABELS.EMPTY_TITLE}</p>
                <p className="mt-1 text-sm text-slate-500">{NSK_LABELS.EMPTY_HINT}</p>
                <QuickStarts starters={quickStarts} onAsk={(text) => send(text)} isBusy={busy !== null} />
              </div>
            )}
            <ul className="space-y-4" aria-label="Conversation">
              {messages.map((message) => (
                <NskMessage
                  key={message.id}
                  message={message}
                  isLatest={message.id === latestReplyId}
                  isBusy={busy !== null}
                  onSuggestion={(text) => send(text)}
                  onAction={handleAction}
                />
              ))}
              {isSending && <TypingIndicator />}
            </ul>
            {offboardingTarget && (
              <OffboardingPanel
                key={offboardingTarget.employeeId}
                target={offboardingTarget}
                onClose={() => setOffboardingTarget(null)}
              />
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <div ref={listEndRef} />
          </div>
        </div>

        <form
          className="hairline-t shrink-0 px-4 py-3 sm:px-6 sm:py-4"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <div className="mx-auto max-w-4xl">
            <PromptHelpers helpers={helperMatches} onPick={pickPromptHelper} />
            <div className="flex items-end gap-2">
              <label htmlFor="nsk-message" className="sr-only">
                {NSK_LABELS.PLACEHOLDER}
              </label>
              <textarea
                id="nsk-message"
                ref={inputRef}
                rows={2}
                value={draft}
                maxLength={NSK_MESSAGE_MAX_LENGTH}
                placeholder={NSK_LABELS.PLACEHOLDER}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send(draft);
                  }
                }}
                className="block max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm text-slate-900 ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-500 focus:outline-none"
              />
              <button
                type="submit"
                aria-label={NSK_LABELS.SEND}
                disabled={!draft.trim() || busy !== null}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 to-indigo-600 text-white shadow-sm transition hover:brightness-110 focus-visible:ring-4 focus-visible:ring-brand-200 focus-visible:outline-none disabled:opacity-50"
              >
                <PaperAirplaneIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
