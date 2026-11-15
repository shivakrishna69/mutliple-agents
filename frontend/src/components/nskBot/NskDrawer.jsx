/**
 * The NSK assistant's drawer, on every signed-in page for people with use_nsk_assistant, opened from
 * the top bar, the sidebar or the mobile header (nskDrawerState.js).
 *
 *   sessions   the person's conversations (GET /api/nsk-bot/sessions), newest first: open one, start a
 *              new one, or delete one (DELETE /api/nsk-bot/sessions/:id)
 *   resume     on a fresh chat, the backend's "pick up where you left off" banner for the latest
 *              conversation, with its "Continue: …" chip and the questions it predicted next
 *   a turn     POST /api/nsk-bot/message; the person's words show at once and a typing indicator runs
 *              while NSK checks its tools and sources; the reply comes back checked, with its sources
 *   cards      suggestion chips send their text; Start offboarding package opens the offboarding form in
 *              the conversation (OffboardingPanel.jsx); View profile first asks for the profile
 *
 * Errors are the backend's messages. Escape closes the drawer.
 */

import { useEffect, useRef, useState } from 'react';
import {
  requestNskSession,
  requestNskSessionDeletion,
  requestNskSessions,
  sendNskMessage,
} from '../../api/nskBotApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  NSK_ACTION_KINDS,
  NSK_LABELS,
  NSK_MESSAGE_MAX_LENGTH,
  NSK_MESSAGE_ROLES,
  viewProfileMessage,
} from '../../constants/nskBot.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { ChatIcon, ChevronDownIcon, CloseIcon, PaperAirplaneIcon, PlusIcon, SparklesIcon } from '../Icons.jsx';
import { Notice, Spinner, formatDateTime } from '../ui.jsx';
import NskMessage, { SuggestionChips } from './NskMessage.jsx';
import { useNskDrawer } from './nskDrawerState.js';
import OffboardingPanel from './OffboardingPanel.jsx';

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

function SessionMenu({ sessions, activeSessionId, onOpen, onDelete, onNew, isBusy }) {
  const [isOpen, setIsOpen] = useState(false);
  const active = sessions.find((session) => session.id === activeSessionId);
  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-haspopup="true"
          onClick={() => setIsOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
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
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50 disabled:opacity-60"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          {NSK_LABELS.NEW_CHAT}
        </button>
      </div>
      {isOpen && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-xl bg-white p-1 shadow-lg ring-1 ring-slate-200">
          <p className="px-2 py-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            {NSK_LABELS.SESSIONS}
          </p>
          {sessions.length === 0 && <p className="px-2 py-2 text-xs text-slate-500">{NSK_LABELS.NO_SESSIONS}</p>}
          <ul aria-label={NSK_LABELS.SESSIONS}>
            {sessions.map((session) => (
              <li key={session.id} className="group flex items-center gap-1 rounded-lg hover:bg-slate-50">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    setIsOpen(false);
                    onOpen(session.id);
                  }}
                  className={`min-w-0 flex-1 px-2 py-1.5 text-left ${session.id === activeSessionId ? 'font-semibold text-brand-700' : 'text-slate-700'}`}
                >
                  <span className="block truncate text-xs">{session.title}</span>
                  <span className="block text-[11px] text-slate-400">{formatDateTime(session.lastMessageAt)}</span>
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`${NSK_LABELS.DELETE_SESSION}: ${session.title}`}
                  onClick={() => onDelete(session)}
                  className="rounded-md p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-600"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ResumeBanner({ resume, onContinue, onSuggestion, isBusy }) {
  return (
    <div className="rounded-xl bg-brand-50 p-3 ring-1 ring-brand-200" data-testid="nsk-resume">
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

export default function NskDrawer() {
  const { isOpen, close } = useNskDrawer();
  const { csrfToken } = useAuth();
  const [sessions, setSessions] = useState(null);
  const [resume, setResume] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [offboardingTarget, setOffboardingTarget] = useState(null);
  const listEndRef = useRef(null);
  const inputRef = useRef(null);
  const isSending = busy === 'send';

  // Sessions are read the first time the drawer opens.
  useEffect(() => {
    if (!isOpen || sessions !== null) return undefined;
    const controller = new AbortController();
    requestNskSessions(controller.signal)
      .then((data) => {
        setSessions(data.sessions);
        setResume(data.resume);
      })
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') {
          setSessions([]);
          setError(toDisplayError(loadError).message);
        }
      });
    return () => controller.abort();
  }, [isOpen, sessions]);

  useEffect(() => {
    if (!isOpen) return undefined;
    inputRef.current?.focus();
    const handleKey = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, close]);

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

  if (!isOpen) return null;
  const latestReplyId = [...messages].reverse().find((message) => message.role === NSK_MESSAGE_ROLES.ASSISTANT)?.id;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={NSK_LABELS.TITLE}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-slate-200 bg-white shadow-2xl sm:w-[28rem]"
    >
      <header className="space-y-2.5 border-b border-slate-200 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
              <SparklesIcon className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{NSK_LABELS.TITLE}</h2>
              <p className="text-xs text-slate-500">{NSK_LABELS.SUBTITLE}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label={NSK_LABELS.CLOSE}
            onClick={close}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <SessionMenu
          sessions={sessions ?? []}
          activeSessionId={activeSessionId}
          onOpen={openSession}
          onDelete={deleteSession}
          onNew={newChat}
          isBusy={busy !== null}
        />
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 scroll-thin">
        {sessions === null && (
          <div className="flex justify-center py-8">
            <Spinner className="h-5 w-5 text-brand-500" />
          </div>
        )}
        {resume && !activeSessionId && messages.length === 0 && (
          <ResumeBanner resume={resume} onContinue={continueResume} onSuggestion={resumeWith} isBusy={busy !== null} />
        )}
        {sessions !== null && messages.length === 0 && (
          <div className="py-6 text-center">
            <ChatIcon className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-2 text-sm font-semibold text-slate-700">{NSK_LABELS.EMPTY_TITLE}</p>
            <p className="mt-1 text-xs text-slate-500">{NSK_LABELS.EMPTY_HINT}</p>
          </div>
        )}
        <ul className="space-y-3" aria-label="Conversation">
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

      <form
        className="border-t border-slate-200 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
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
            className="min-h-[2.75rem] flex-1 resize-none rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500 focus:outline-none"
          />
          <button
            type="submit"
            aria-label={NSK_LABELS.SEND}
            disabled={!draft.trim() || busy !== null}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
          >
            <PaperAirplaneIcon className="h-4 w-4" />
          </button>
        </div>
      </form>
    </aside>
  );
}
