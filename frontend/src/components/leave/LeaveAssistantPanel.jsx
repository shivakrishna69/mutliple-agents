/**
 * The leave assistant on My leave: the employee asks about their own leave in plain words, and
 * the assistant answers from their real balances, rules, requests and office calendar. It can
 * prepare a draft, shown with "Review and send", which opens the normal apply form filled in; the
 * employee checks the live price and sends it themselves. The assistant never sends anything.
 *
 *   POST /api/leave/assistant { message, history }   (backend controllers/leaveAssistantController.js)
 *
 * The conversation lives only in this page: the last few messages go with each question, and it
 * starts afresh on reload. Replies are shown as plain text (never rendered as HTML).
 */

import { useState } from 'react';
import { requestLeaveAssistant } from '../../api/leaveApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ASSISTANT_UNAVAILABLE_MESSAGE, LEAVE_FIELD_LIMITS, describeLeaveDates } from '../../constants/leave.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { SparklesIcon } from '../Icons.jsx';
import { Button, Card, Notice, Spinner } from '../ui.jsx';

const HTTP_SERVER_ERROR_FLOOR = 500;
const ROLES = Object.freeze({ USER: 'user', ASSISTANT: 'assistant' });
const STARTER_QUESTIONS = Object.freeze([
  'How much leave do I have?',
  'What holidays are coming up?',
  'What would next Friday off cost me?',
]);

function DraftCard({ draft, leaveTypes, onReview }) {
  const leaveType = leaveTypes.find((type) => type.id === draft.leaveTypeId);
  return (
    <div className="mt-2 rounded-xl bg-white p-3 ring-1 ring-brand-200">
      <p className="text-xs font-semibold tracking-wide text-brand-700 uppercase">Draft, not sent</p>
      <p className="mt-1 text-sm font-medium text-slate-900">
        {leaveType?.name ?? 'Leave'} · {describeLeaveDates(draft)}
      </p>
      {draft.reason && <p className="text-xs text-slate-500">“{draft.reason}”</p>}
      <Button size="sm" className="mt-2" onClick={() => onReview(draft)}>
        Review and send
      </Button>
    </div>
  );
}

/**
 * @param {{ leaveTypes: object[], onReviewDraft: (draft: object) => void }} props
 */
export default function LeaveAssistantPanel({ leaveTypes, onReviewDraft }) {
  const { csrfToken } = useAuth();
  // [{ role, content, draft? }], oldest first.
  const [conversation, setConversation] = useState([]);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [askError, setAskError] = useState(null);

  async function ask(text) {
    const message = text.trim();
    if (!message || isAsking) return;
    const history = conversation
      .slice(-LEAVE_FIELD_LIMITS.ASSISTANT_HISTORY_MAX_MESSAGES)
      .map(({ role, content }) => ({ role, content }));
    setConversation((previous) => [...previous, { role: ROLES.USER, content: message }]);
    setQuestion('');
    setIsAsking(true);
    setAskError(null);
    try {
      const { reply, draft } = await requestLeaveAssistant({ message, history }, csrfToken);
      setConversation((previous) => [...previous, { role: ROLES.ASSISTANT, content: reply, draft }]);
    } catch (assistantError) {
      const displayError = toDisplayError(assistantError);
      // Any server-side failure (the AI, or the leave data behind it) gets one plain message; limits
      // and bad input keep the backend's own.
      setAskError(
        displayError.status >= HTTP_SERVER_ERROR_FLOOR
          ? { ...displayError, message: ASSISTANT_UNAVAILABLE_MESSAGE }
          : displayError,
      );
      // The question was not answered, so it is not part of the conversation.
      setConversation((previous) => previous.slice(0, -1));
      setQuestion(message);
    } finally {
      setIsAsking(false);
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <SparklesIcon className="h-5 w-5 text-brand-500" /> Leave assistant
        </span>
      }
      subtitle="Ask about your balances, holidays or what a leave would cost. It can draft a request for you to send."
    >
      <div className="space-y-4">
        {conversation.length === 0 ? (
          <div className="flex flex-wrap gap-2">
            {STARTER_QUESTIONS.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => ask(starter)}
                disabled={isAsking}
                className="rounded-full bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100"
              >
                {starter}
              </button>
            ))}
          </div>
        ) : (
          <ol
            className="max-h-96 space-y-3 overflow-y-auto pr-1 scroll-thin"
            aria-label="Conversation"
            aria-live="polite"
          >
            {conversation.map((entry, entryIndex) => (
              <li key={entryIndex} className={entry.role === ROLES.USER ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-line ${
                    entry.role === ROLES.USER ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-800'
                  }`}
                >
                  {entry.content}
                  {entry.draft && <DraftCard draft={entry.draft} leaveTypes={leaveTypes} onReview={onReviewDraft} />}
                </div>
              </li>
            ))}
          </ol>
        )}
        {isAsking && (
          <p className="flex items-center gap-2 text-xs text-slate-500" role="status">
            <Spinner className="h-4 w-4 text-brand-500" /> Checking your leave…
          </p>
        )}
        {askError && <Notice tone="warning" title={askError.message} onDismiss={() => setAskError(null)} />}
        <form
          className="flex gap-2"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            ask(question);
          }}
        >
          <label className="sr-only" htmlFor="leave-assistant-question">
            Ask the leave assistant
          </label>
          <input
            id="leave-assistant-question"
            value={question}
            onChange={(changeEvent) => setQuestion(changeEvent.target.value)}
            maxLength={LEAVE_FIELD_LIMITS.ASSISTANT_MESSAGE_MAX_LENGTH}
            placeholder="e.g. Book next Friday afternoon off for a doctor's visit"
            className="min-w-0 flex-1 rounded-xl border-0 px-3.5 py-2.5 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-500"
          />
          <Button type="submit" isBusy={isAsking} disabled={!question.trim()}>
            Ask
          </Button>
        </form>
      </div>
    </Card>
  );
}
