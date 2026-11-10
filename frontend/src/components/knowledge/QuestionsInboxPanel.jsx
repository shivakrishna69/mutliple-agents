/**
 * A department's Questions Inbox, on its knowledge base page (?tab=questions), for its head, its
 * knowledge lead and administrators: what the agent could not answer, and answers people rated
 * unhelpful, from the people it serves.
 *
 *   Open        answer the asker (they see the reply in their conversation and are notified in the
 *               app and by email), optionally saving it as an FAQ entry the agent can use next time;
 *               or close it without an answer
 *   Answered    the reply, and "Save as FAQ" if it was not saved yet
 *   Closed      questions closed without an answer
 *
 * A notification link opens a question directly (?question=<id>): it is shown first and scrolled to.
 * Every text and error comes from the backend.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import {
  requestDepartmentQuestions,
  requestQuestionAnswer,
  requestQuestionDismissal,
  requestQuestionFaq,
} from '../../api/knowledgeApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { QUESTION_REASON_DISPLAY, QUESTION_STATUSES, QUESTION_STATUS_DISPLAY } from '../../constants/agentChat.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { QuestionIcon } from '../Icons.jsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingBlock,
  Notice,
  Tabs,
  TextInput,
  Toggle,
  formatDateTime,
} from '../ui.jsx';

const QUESTION_PARAMETER = 'question';
const STATUS_TABS = Object.freeze([
  { id: QUESTION_STATUSES.OPEN, label: 'Open' },
  { id: QUESTION_STATUSES.ANSWERED, label: 'Answered' },
  { id: QUESTION_STATUSES.DISMISSED, label: 'Closed' },
]);

function AnswerForm({ departmentId, question, onDone }) {
  const { csrfToken } = useAuth();
  const [answer, setAnswer] = useState('');
  const [saveAsFaq, setSaveAsFaq] = useState(false);
  const [faqQuestion, setFaqQuestion] = useState(question.question);
  const [busyAction, setBusyAction] = useState(null);
  const [formError, setFormError] = useState(null);

  async function run(action) {
    setBusyAction(action);
    setFormError(null);
    try {
      const result =
        action === 'answer'
          ? await requestQuestionAnswer(
              departmentId,
              question.id,
              { answer, saveAsFaq, ...(saveAsFaq && faqQuestion.trim() ? { faqQuestion: faqQuestion.trim() } : {}) },
              csrfToken,
            )
          : await requestQuestionDismissal(departmentId, question.id, csrfToken);
      onDone(result.message);
    } catch (actionError) {
      setFormError(toDisplayError(actionError));
      setBusyAction(null);
    }
  }

  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        run('answer');
      }}
    >
      {formError && <Notice tone="error" title={formError.message} />}
      <Field label="Your answer" error={formError?.fieldErrors?.answer}>
        {(controlId, inputClassName) => (
          <textarea
            id={controlId}
            value={answer}
            onChange={(changeEvent) => setAnswer(changeEvent.target.value)}
            rows={4}
            required
            className={inputClassName}
            placeholder={`Reply to ${question.askedBy?.name ?? 'them'} directly`}
          />
        )}
      </Field>
      <Toggle
        label="Save as FAQ"
        description="Adds this question and your answer to the knowledge base, so the agent can answer it next time."
        checked={saveAsFaq}
        onChange={setSaveAsFaq}
      />
      {saveAsFaq && (
        <TextInput
          label="FAQ question"
          value={faqQuestion}
          onChange={(changeEvent) => setFaqQuestion(changeEvent.target.value)}
          error={formError?.fieldErrors?.faqQuestion}
          hint="How the question should read in the FAQ"
        />
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => run('dismiss')}
          isBusy={busyAction === 'dismiss'}
          disabled={Boolean(busyAction)}
        >
          Close without answering
        </Button>
        <Button type="submit" isBusy={busyAction === 'answer'} disabled={Boolean(busyAction) || !answer.trim()}>
          Send answer
        </Button>
      </div>
    </form>
  );
}

function SaveAsFaqButton({ departmentId, question, onDone }) {
  const { csrfToken } = useAuth();
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  async function save() {
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await requestQuestionFaq(departmentId, question.id, null, csrfToken);
      onDone(result.message);
    } catch (faqError) {
      setSaveError(toDisplayError(faqError));
      setIsSaving(false);
    }
  }
  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" onClick={save} isBusy={isSaving}>
        Save as FAQ
      </Button>
      {saveError && <span className="text-sm text-rose-600">{saveError.message}</span>}
    </div>
  );
}

function QuestionCard({ departmentId, question, isHighlighted, onChanged }) {
  const cardRef = useRef(null);
  useEffect(() => {
    if (isHighlighted) cardRef.current?.scrollIntoView?.({ block: 'center' });
  }, [isHighlighted]);
  const status = QUESTION_STATUS_DISPLAY[question.status];
  return (
    <li
      ref={cardRef}
      aria-label={`Question from ${question.askedBy?.name ?? 'someone'}`}
      className={`rounded-2xl bg-white p-5 shadow-sm ring-1 ${isHighlighted ? 'ring-2 ring-brand-400' : 'ring-slate-200'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-slate-500">
            <span className="font-semibold text-slate-700">{question.askedBy?.name ?? 'Someone'}</span> ·{' '}
            {formatDateTime(question.createdAt)} · {QUESTION_REASON_DISPLAY[question.reason]}
          </p>
          <p className="mt-2 text-base font-semibold whitespace-pre-wrap text-slate-900">{question.question}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <details className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200/70">
        <summary className="cursor-pointer font-medium text-slate-700">What the agent replied</summary>
        <p className="mt-2 whitespace-pre-wrap">{question.agentAnswer}</p>
      </details>
      {question.status === QUESTION_STATUSES.OPEN && (
        <AnswerForm departmentId={departmentId} question={question} onDone={onChanged} />
      )}
      {question.status === QUESTION_STATUSES.ANSWERED && (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-950 ring-1 ring-emerald-200">
            <p className="text-xs font-semibold text-emerald-800">
              Answered by {question.answeredBy?.name ?? 'the department'} · {formatDateTime(question.answeredAt)}
            </p>
            <p className="mt-1 whitespace-pre-wrap">{question.answer}</p>
          </div>
          {question.faqDocumentId ? (
            <Badge tone="emerald">Saved as FAQ</Badge>
          ) : (
            <SaveAsFaqButton departmentId={departmentId} question={question} onDone={onChanged} />
          )}
        </div>
      )}
    </li>
  );
}

export default function QuestionsInboxPanel({ departmentId }) {
  const [searchParameters] = useSearchParams();
  const location = useLocation();
  const highlightedId = searchParameters.get(QUESTION_PARAMETER);
  const [status, setStatus] = useState(QUESTION_STATUSES.OPEN);
  const [successMessage, setSuccessMessage] = useState(null);
  // A notification link reloads the inbox even when it is already open.
  const refreshToken = location.state?.refreshedAt ?? null;
  const questionsResource = useApiResource(
    (signal) => requestDepartmentQuestions(departmentId, status, signal),
    [departmentId, status, refreshToken],
  );
  const counts = questionsResource.data?.countsByStatus ?? {};

  function changed(message) {
    setSuccessMessage(message ?? null);
    questionsResource.reload();
  }

  const questions = [...(questionsResource.data?.questions ?? [])].sort(
    (first, second) => Number(second.id === highlightedId) - Number(first.id === highlightedId),
  );

  return (
    <Card
      title="Questions"
      subtitle="Questions the agent could not answer, and answers people found unhelpful. You reply to them directly."
      actions={
        <Tabs
          tabs={STATUS_TABS.map((tab) => ({ ...tab, badge: counts[tab.id] || null }))}
          activeTabId={status}
          onChange={(nextStatus) => {
            setSuccessMessage(null);
            setStatus(nextStatus);
          }}
          label="Question status"
        />
      }
    >
      <div className="space-y-4">
        {successMessage && <Notice tone="success" title={successMessage} onDismiss={() => setSuccessMessage(null)} />}
        {questionsResource.isLoading && !questionsResource.data && <LoadingBlock label="Loading questions…" />}
        {questionsResource.error && <Notice tone="error" title={questionsResource.error.message} />}
        {questionsResource.data && questions.length === 0 && (
          <EmptyState
            Icon={QuestionIcon}
            title={status === QUESTION_STATUSES.OPEN ? 'No open questions' : 'Nothing here'}
            description={
              status === QUESTION_STATUSES.OPEN
                ? 'When the agent cannot answer someone, their question appears here.'
                : 'Questions move here once they are handled.'
            }
          />
        )}
        <ul className="space-y-4">
          {questions.map((question) => (
            <QuestionCard
              key={question.id}
              departmentId={departmentId}
              question={question}
              isHighlighted={question.id === highlightedId}
              onChanged={changed}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}
