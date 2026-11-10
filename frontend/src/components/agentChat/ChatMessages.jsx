/**
 * The messages of a conversation with a department agent:
 *
 *   USER        the person's question, on the right
 *   ASSISTANT   the agent's answer: its text, with each citation mark ([1]) linking to the source
 *               card below it; the cited passages as cards (document, section, page, the quoted
 *               excerpt); thumbs up / down. An answer the agent could not give says that the
 *               question went to the department, and how far it got.
 *   LEAD        the department's reply from the Questions Inbox, with who wrote it
 *   pending     the question being asked and the answer as it streams in
 *
 * Text is never parsed as HTML (components/MessageText.jsx).
 */

import { useState } from 'react';
import { requestAnswerFeedback } from '../../api/agentChatApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  ANSWER_OUTCOMES,
  CITATION_MARK_PATTERN,
  ESCALATION_DISPLAY,
  FEEDBACK_RATINGS,
  MESSAGE_ROLES,
} from '../../constants/agentChat.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import MessageText from '../MessageText.jsx';
import { BookOpenIcon, ThumbDownIcon, ThumbUpIcon, UsersIcon } from '../Icons.jsx';
import { formatDateTime } from '../ui.jsx';

const citationAnchor = (messageId, number) => `citation-${messageId}-${number}`;

/** The answer's text with each [n] turned into a link to its source card. */
function AnswerText({ messageId, text, citationNumbers }) {
  const pieces = [];
  let previousEnd = 0;
  for (const mark of text.matchAll(CITATION_MARK_PATTERN)) {
    const number = Number(mark[1]);
    if (mark.index > previousEnd)
      pieces.push(<MessageText key={`t${previousEnd}`} text={text.slice(previousEnd, mark.index)} />);
    pieces.push(
      citationNumbers.has(number) ? (
        <a
          key={`c${mark.index}`}
          href={`#${citationAnchor(messageId, number)}`}
          aria-label={`Source ${number}`}
          className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-1 items-center justify-center rounded bg-brand-100 px-1 align-baseline text-[10px] font-bold text-brand-700 no-underline hover:bg-brand-200"
        >
          {number}
        </a>
      ) : (
        mark[0]
      ),
    );
    previousEnd = mark.index + mark[0].length;
  }
  if (previousEnd < text.length) pieces.push(<MessageText key={`t${previousEnd}`} text={text.slice(previousEnd)} />);
  return pieces;
}

function CitationCard({ messageId, citation }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const location = [citation.headingPath?.join(' › '), citation.page ? `page ${citation.page}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <li
      id={citationAnchor(messageId, citation.number)}
      className="rounded-xl bg-white p-3 ring-1 ring-slate-200 target:ring-2 target:ring-brand-400"
    >
      <div className="flex items-start gap-2">
        <span className="flex h-5 min-w-5 items-center justify-center rounded bg-brand-100 px-1 text-[11px] font-bold text-brand-700">
          {citation.number}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-800">
            <BookOpenIcon className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="truncate">{citation.documentName ?? 'Knowledge base document'}</span>
          </p>
          {location && <p className="mt-0.5 truncate text-xs text-slate-500">{location}</p>}
          <blockquote
            className={`mt-2 border-l-2 border-slate-200 pl-3 text-sm whitespace-pre-wrap text-slate-600 ${isExpanded ? '' : 'line-clamp-3'}`}
          >
            {citation.excerpt}
          </blockquote>
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
            className="mt-1 text-xs font-semibold text-brand-600 hover:text-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
          >
            {isExpanded ? 'Show less' : 'Show the whole excerpt'}
          </button>
        </div>
      </div>
    </li>
  );
}

function FeedbackButtons({ departmentId, message, onRated }) {
  const { csrfToken } = useAuth();
  const [isSending, setIsSending] = useState(false);
  const [notice, setNotice] = useState(null);
  const current = message.feedback?.rating ?? null;

  async function rate(rating) {
    if (isSending || rating === current) return;
    setIsSending(true);
    setNotice(null);
    try {
      const result = await requestAnswerFeedback(departmentId, { messageId: message.id, rating }, csrfToken);
      onRated(result.ratedMessage);
      setNotice({ tone: 'success', text: result.notice });
    } catch (feedbackError) {
      setNotice({ tone: 'error', text: toDisplayError(feedbackError).message });
    } finally {
      setIsSending(false);
    }
  }

  const buttonClass = (rating) =>
    `rounded-lg p-1.5 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none disabled:opacity-50 ${
      current === rating ? 'bg-brand-100 text-brand-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
    }`;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Helpful"
        aria-pressed={current === FEEDBACK_RATINGS.UP}
        disabled={isSending}
        onClick={() => rate(FEEDBACK_RATINGS.UP)}
        className={buttonClass(FEEDBACK_RATINGS.UP)}
      >
        <ThumbUpIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Not helpful"
        aria-pressed={current === FEEDBACK_RATINGS.DOWN}
        disabled={isSending}
        onClick={() => rate(FEEDBACK_RATINGS.DOWN)}
        className={buttonClass(FEEDBACK_RATINGS.DOWN)}
      >
        <ThumbDownIcon className="h-4 w-4" />
      </button>
      {notice?.text && (
        <span role="status" className={`ml-1 text-xs ${notice.tone === 'error' ? 'text-rose-600' : 'text-slate-500'}`}>
          {notice.text}
        </span>
      )}
    </div>
  );
}

function AssistantMessage({ departmentId, agentName, message, onRated }) {
  const isAnswered = message.outcome === ANSWER_OUTCOMES.ANSWERED;
  const citationNumbers = new Set(message.citations.map((citation) => citation.number));
  return (
    <div className="flex max-w-3xl gap-3">
      <span
        className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white"
        aria-hidden="true"
      >
        <BookOpenIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs font-semibold text-slate-500">
          {agentName} · <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
        </p>
        <div
          className={`rounded-2xl rounded-tl-sm px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap ring-1 ${
            isAnswered ? 'bg-white text-slate-800 ring-slate-200' : 'bg-amber-50 text-amber-900 ring-amber-200'
          }`}
        >
          {isAnswered ? (
            <AnswerText messageId={message.id} text={message.content} citationNumbers={citationNumbers} />
          ) : (
            <MessageText text={message.content} />
          )}
          {message.question?.status && (
            <p className="mt-2 text-xs font-medium text-amber-700">{ESCALATION_DISPLAY[message.question.status]}</p>
          )}
        </div>
        {message.citations.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">Sources</p>
            <ol className="grid gap-2 sm:grid-cols-2" aria-label="Sources">
              {message.citations.map((citation) => (
                <CitationCard key={citation.number} messageId={message.id} citation={citation} />
              ))}
            </ol>
          </div>
        )}
        {isAnswered && <FeedbackButtons departmentId={departmentId} message={message} onRated={onRated} />}
      </div>
    </div>
  );
}

function LeadMessage({ departmentName, message }) {
  return (
    <div className="flex max-w-3xl gap-3">
      <span
        className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
        aria-hidden="true"
      >
        <UsersIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-semibold text-slate-500">
          Reply from {message.author?.name ?? departmentName} ({departmentName}) ·{' '}
          <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
        </p>
        <div className="rounded-2xl rounded-tl-sm bg-emerald-50 px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-emerald-950 ring-1 ring-emerald-200">
          <MessageText text={message.content} />
        </div>
      </div>
    </div>
  );
}

function UserMessage({ text }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-2xl rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-white shadow-sm">
        <MessageText text={text} />
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * @param {{ departmentId: string, departmentName: string, agentName: string, messages: object[],
 *   pending: { question: string, answerText: string }|null, onMessageUpdated: (message) => void }} props
 */
export default function ChatMessages({ departmentId, departmentName, agentName, messages, pending, onMessageUpdated }) {
  return (
    <ol className="space-y-6" aria-label="Conversation">
      {messages.map((message) => (
        <li key={message.id}>
          {message.role === MESSAGE_ROLES.USER && <UserMessage text={message.content} />}
          {message.role === MESSAGE_ROLES.ASSISTANT && (
            <AssistantMessage
              departmentId={departmentId}
              agentName={agentName}
              message={message}
              onRated={onMessageUpdated}
            />
          )}
          {message.role === MESSAGE_ROLES.LEAD && <LeadMessage departmentName={departmentName} message={message} />}
        </li>
      ))}
      {pending && (
        <>
          <li>
            <UserMessage text={pending.question} />
          </li>
          <li aria-live="polite" aria-busy="true">
            <div className="flex max-w-3xl gap-3">
              <span
                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white"
                aria-hidden="true"
              >
                <BookOpenIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs font-semibold text-slate-500">{agentName}</p>
                <div className="rounded-2xl rounded-tl-sm bg-white px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-slate-800 ring-1 ring-slate-200">
                  {pending.answerText ? (
                    <MessageText text={pending.answerText} />
                  ) : (
                    <span className="sr-only">The agent is answering</span>
                  )}
                  <span className="ml-1 align-middle">
                    <TypingDots />
                  </span>
                </div>
              </div>
            </div>
          </li>
        </>
      )}
    </ol>
  );
}
