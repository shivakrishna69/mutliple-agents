/**
 * One message of an NSK conversation:
 *
 *   USER        the person's words, on the right
 *   ASSISTANT   NSK's reply: its text with each [n] linking to its source badge; a tag when it did not
 *               simply answer (needs a detail, nothing found, refused); the sources, each badge saying
 *               what it is (live portal data, a policy document with its page, an earlier conversation,
 *               a web page with its address and fetch date, or an unverified search snippet); the
 *               escalation banner for urgent, frustrated or sensitive messages; the suggestion chips
 *               (next questions, or the people to choose between); and the action cards for one person
 *               (start their offboarding, view their profile).
 *
 * Every text comes from the backend as it sent it; nothing is parsed as HTML (MessageText.jsx).
 */

import { useState } from 'react';
import {
  NSK_ACTION_KINDS,
  NSK_LABELS,
  NSK_MESSAGE_ROLES,
  NSK_SOURCE_KINDS,
  OUTCOME_DISPLAY,
  SOURCE_KIND_DISPLAY,
} from '../../constants/nskBot.js';
import { hostOf, sourceBadgeKind, splitCitations } from '../../utils/nskBot.js';
import MessageText from '../MessageText.jsx';
import { BookOpenIcon, ChatIcon, DocumentIcon, FlagIcon, SearchIcon, SparklesIcon, UserCircleIcon } from '../Icons.jsx';
import { Badge, formatDate } from '../ui.jsx';

const sourceAnchor = (messageId, number) => `nsk-source-${messageId}-${number}`;

const BADGE_ICONS = Object.freeze({
  [NSK_SOURCE_KINDS.TOOL]: SparklesIcon,
  [NSK_SOURCE_KINDS.DOCUMENT]: BookOpenIcon,
  [NSK_SOURCE_KINDS.CONVERSATION]: ChatIcon,
  [NSK_SOURCE_KINDS.WEB]: DocumentIcon,
  SNIPPET: SearchIcon,
});

function ReplyText({ messageId, text, citationNumbers }) {
  return splitCitations(text, citationNumbers).map((piece, index) =>
    piece.kind === 'text' ? (
      <MessageText key={index} text={piece.text} />
    ) : (
      <a
        key={index}
        href={`#${sourceAnchor(messageId, piece.number)}`}
        aria-label={`Source ${piece.number}`}
        className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-1 items-center justify-center rounded bg-brand-100 px-1 align-baseline text-[10px] font-bold text-brand-700 no-underline hover:bg-brand-200"
      >
        {piece.number}
      </a>
    ),
  );
}

function SourceBadge({ messageId, citation }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const badgeKind = sourceBadgeKind(citation);
  const display = SOURCE_KIND_DISPLAY[badgeKind];
  const Icon = BADGE_ICONS[badgeKind];
  const detail =
    citation.kind === NSK_SOURCE_KINDS.DOCUMENT
      ? [citation.headingPath?.join(' › '), citation.page ? `page ${citation.page}` : null].filter(Boolean).join(' · ')
      : null;
  return (
    <li
      id={sourceAnchor(messageId, citation.number)}
      data-source-kind={badgeKind}
      className="rounded-xl bg-white p-2.5 ring-1 ring-slate-200 target:ring-2 target:ring-brand-400"
    >
      <div className="flex items-start gap-2">
        <span className="flex h-5 min-w-5 items-center justify-center rounded bg-brand-100 px-1 text-[11px] font-bold text-brand-700">
          {citation.number}
        </span>
        <div className="min-w-0 flex-1">
          <Badge tone={display.tone}>
            <Icon className="h-3.5 w-3.5" />
            {display.label}
          </Badge>
          <p className="mt-1 text-sm font-medium break-words text-slate-800">{citation.label}</p>
          {detail && <p className="mt-0.5 text-xs text-slate-500">{detail}</p>}
          {citation.kind === NSK_SOURCE_KINDS.WEB && citation.sourceUrl && (
            <p className="mt-0.5 text-xs text-slate-500">
              <a
                href={citation.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="font-semibold text-sky-700 underline hover:text-sky-600"
              >
                {hostOf(citation.sourceUrl)}
              </a>
              {citation.fetchedAt && ` · ${NSK_LABELS.FETCHED} ${formatDate(citation.fetchedAt)}`}
            </p>
          )}
          {citation.excerpt && (
            <>
              <blockquote
                className={`mt-1.5 border-l-2 border-slate-200 pl-2.5 text-xs whitespace-pre-wrap text-slate-600 ${isExpanded ? '' : 'line-clamp-2'}`}
              >
                {citation.excerpt}
              </blockquote>
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => setIsExpanded((current) => !current)}
                className="mt-0.5 text-xs font-semibold text-brand-600 hover:text-brand-500"
              >
                {isExpanded ? 'Show less' : 'Show more'}
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function EscalationBanner({ hint }) {
  return (
    <div
      role="alert"
      className="mt-2 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200"
    >
      <FlagIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <span>{hint}</span>
    </div>
  );
}

function ActionCards({ actions, onAction, disabled }) {
  return (
    <div className="mt-2 grid gap-2">
      {actions.map((action) => (
        <button
          key={`${action.kind}-${action.employeeId}`}
          type="button"
          disabled={disabled}
          onClick={() => onAction(action)}
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold ring-1 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none disabled:opacity-60 ${
            action.kind === NSK_ACTION_KINDS.START_OFFBOARDING
              ? 'bg-brand-600 text-white ring-brand-600 hover:bg-brand-500'
              : 'bg-white text-slate-800 ring-slate-200 hover:bg-slate-50'
          }`}
        >
          {action.kind === NSK_ACTION_KINDS.START_OFFBOARDING ? (
            <DocumentIcon className="h-4 w-4 shrink-0" />
          ) : (
            <UserCircleIcon className="h-4 w-4 shrink-0" />
          )}
          {action.label}
        </button>
      ))}
    </div>
  );
}

export function SuggestionChips({ suggestions, onSelect, disabled, label = NSK_LABELS.SUGGESTED }) {
  if (!suggestions?.length) return null;
  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.text}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(suggestion.text, suggestion)}
            data-action={suggestion.actionKind ?? undefined}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none disabled:opacity-60 ${
              suggestion.actionKind
                ? 'bg-brand-600 text-white ring-brand-600 hover:bg-brand-500'
                : 'bg-brand-50 text-brand-800 ring-brand-200 hover:bg-brand-100'
            }`}
          >
            {suggestion.text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * @param {{ message: object, isLatest: boolean, isBusy: boolean, onSuggestion: (text: string) => void,
 *   onAction: (action: object) => void }} props  suggestions and actions show on the latest reply only.
 *   A chip tied to one of the reply's cards ("Yes, start offboarding for …": actionKind and
 *   employeeId) does what that card does instead of sending its text.
 */
export default function NskMessage({ message, isLatest, isBusy, onSuggestion, onAction }) {
  if (message.role === NSK_MESSAGE_ROLES.USER) {
    return (
      <li className="flex justify-end" data-role="user">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-sm whitespace-pre-wrap text-white">
          {message.content}
        </div>
      </li>
    );
  }
  const citationNumbers = new Set(message.citations.map((citation) => citation.number));
  const chooseSuggestion = (text, suggestion) => {
    const action = suggestion?.actionKind
      ? message.actions?.find(
          (candidate) => candidate.kind === suggestion.actionKind && candidate.employeeId === suggestion.employeeId,
        )
      : null;
    if (action) onAction(action);
    else onSuggestion(text);
  };
  const outcome = OUTCOME_DISPLAY[message.outcome];
  return (
    <li className="flex justify-start" data-role="assistant" data-outcome={message.outcome}>
      <div className="w-full max-w-[95%]">
        <div className="rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2.5 text-sm whitespace-pre-wrap text-slate-800">
          <ReplyText messageId={message.id} text={message.content} citationNumbers={citationNumbers} />
        </div>
        {outcome && (
          <Badge tone={outcome.tone} className="mt-1.5">
            {outcome.label}
          </Badge>
        )}
        {message.escalation && <EscalationBanner hint={message.escalation.hint} />}
        {message.citations.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{NSK_LABELS.SOURCES}</p>
            <ul className="mt-1 space-y-1.5">
              {message.citations.map((citation) => (
                <SourceBadge key={citation.number} messageId={message.id} citation={citation} />
              ))}
            </ul>
          </div>
        )}
        {isLatest && message.actions?.length > 0 && (
          <ActionCards actions={message.actions} onAction={onAction} disabled={isBusy} />
        )}
        {isLatest && (
          <SuggestionChips suggestions={message.suggestions} onSelect={chooseSuggestion} disabled={isBusy} />
        )}
      </div>
    </li>
  );
}
