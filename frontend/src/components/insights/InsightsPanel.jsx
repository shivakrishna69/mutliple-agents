/**
 * The briefing panel: a frosted slide-over from the right, opened from the ✦ pill or a briefing bar.
 * Cards are grouped Urgent, High priority, Also today; each shows its label, title, body and facts
 * (for a leave request: dates and days, the balance left and days taken this year, teammates off over
 * the same dates) with its actions:
 *
 *   Approve        one click, with Undo for a few seconds before it is sent
 *   Decline        an inline reason (required), then Decline request
 *   links          View in Department Board / Review task / Open (the panel closes as they open)
 *   Ask NSK        Ask NSK with a prepared question in the box, not sent
 *
 * Accessibility: role="dialog", aria-modal, labelled by its title; focus moves in on open and back on
 * close; Escape and the backdrop close it; Tab stays inside.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { INSIGHT_ACTIONS, INSIGHT_GROUPS, INSIGHT_LABELS, INSIGHT_SEVERITIES } from '../../constants/insights.js';
import { CloseIcon } from '../Icons.jsx';
import { Button } from '../ui.jsx';
import { DecisionState, InsightAction } from './InsightActions.jsx';
import { useInsights } from './InsightsContext.jsx';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
const NOTE_MAX_LENGTH = 1000;

const LABEL_TONES = Object.freeze({
  [INSIGHT_SEVERITIES.URGENT]: 'bg-rose-100 text-rose-700',
  [INSIGHT_SEVERITIES.HIGH]: 'bg-amber-100 text-amber-800',
  [INSIGHT_SEVERITIES.NORMAL]: 'bg-slate-100 text-slate-600',
});

/** The inline reason for declining a leave request. */
function DeclineForm({ card, action, onCancel }) {
  const insights = useInsights();
  const noteId = useId();
  const [note, setNote] = useState('');
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        if (note.trim()) insights.decline(card, action, note);
      }}
    >
      <label htmlFor={noteId} className="block text-xs font-medium text-slate-700">
        {INSIGHT_LABELS.DECLINE_REASON}
      </label>
      <textarea
        id={noteId}
        value={note}
        onChange={(changeEvent) => setNote(changeEvent.target.value)}
        maxLength={NOTE_MAX_LENGTH}
        rows={2}
        required
        autoFocus
        className="block w-full rounded-lg border-0 bg-white/80 px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500"
      />
      <p className="text-xs text-slate-500">{INSIGHT_LABELS.DECLINE_HINT}</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {INSIGHT_LABELS.CANCEL}
        </Button>
        <Button size="sm" variant="danger" type="submit" disabled={!note.trim()}>
          {INSIGHT_LABELS.CONFIRM_DECLINE}
        </Button>
      </div>
    </form>
  );
}

function InsightCard({ card, onNavigate }) {
  const insights = useInsights();
  const [isDeclining, setIsDeclining] = useState(false);
  const decision = insights.decisions[card.id];
  const declineAction = card.actions.find((action) => action.kind === INSIGHT_ACTIONS.DECLINE_LEAVE);
  return (
    <li
      className="rounded-2xl bg-white/75 p-4 shadow-sm ring-1 ring-slate-900/[0.06]"
      data-testid="insight-card"
      data-kind={card.kind}
    >
      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${LABEL_TONES[card.severity]}`}>
        {card.label}
      </span>
      <h3 className="mt-2 text-sm font-semibold text-slate-900">{card.title}</h3>
      {card.body && <p className="mt-1 text-sm whitespace-pre-wrap text-slate-700">{card.body}</p>}
      {card.facts.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
          {card.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {decision ? (
          <DecisionState card={card} />
        ) : (
          !isDeclining &&
          card.actions.map((action, index) => (
            <InsightAction
              key={`${action.kind}:${index}`}
              card={card}
              action={action}
              isPrimary={index === 0}
              onDecline={() => setIsDeclining(true)}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
      {isDeclining && !decision && declineAction && (
        <DeclineForm card={card} action={declineAction} onCancel={() => setIsDeclining(false)} />
      )}
    </li>
  );
}

export default function InsightsPanel() {
  const insights = useInsights();
  const titleId = useId();
  const panelRef = useRef(null);
  const isOpen = Boolean(insights?.isPanelOpen);
  const close = insights?.closePanel;

  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    (panel.querySelector('[data-autofocus]') ?? panel).focus();
    function handleKeyDown(keyEvent) {
      if (keyEvent.key === 'Escape') close();
      if (keyEvent.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [isOpen, close]);

  if (!isOpen) return null;
  const cards = insights.briefing?.cards ?? [];
  const groups = INSIGHT_GROUPS.map((group) => ({
    ...group,
    cards: cards.filter((card) => card.severity === group.severity),
  })).filter((group) => group.cards.length > 0);
  // Decided cards drop out of the briefing as it reloads; their outcome stays shown until the panel closes.
  const shownIds = new Set(cards.map((card) => card.id));
  const finished = Object.entries(insights.decisions).filter(
    ([cardId, decision]) => !shownIds.has(cardId) && (decision.phase === 'done' || decision.phase === 'error'),
  );

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px]"
        aria-label={INSIGHT_LABELS.CLOSE}
        tabIndex={-1}
        onClick={close}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="insights-panel"
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white/70 shadow-2xl ring-1 ring-white/60 backdrop-blur-2xl backdrop-saturate-150 focus:outline-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-900/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              <span className="mr-1.5 text-brand-600" aria-hidden="true">
                {INSIGHT_LABELS.MARK}
              </span>
              {INSIGHT_LABELS.PANEL_TITLE}
            </h2>
            {insights.briefing && <p className="mt-0.5 text-sm text-slate-600">{insights.briefing.headline}</p>}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={INSIGHT_LABELS.CLOSE}
            data-autofocus
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-900/[0.05] hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 scroll-thin">
          {finished.length > 0 && (
            <ul className="space-y-2" aria-label="Decided">
              {finished.map(([cardId, decision]) => (
                <li
                  key={cardId}
                  role={decision.phase === 'error' ? 'alert' : 'status'}
                  className={`rounded-xl px-3 py-2 text-xs ring-1 ${
                    decision.phase === 'error'
                      ? 'bg-rose-50 text-rose-800 ring-rose-200'
                      : 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                  }`}
                >
                  <span className="font-semibold">{decision.title}</span> · {decision.notice ?? decision.error}
                </li>
              ))}
            </ul>
          )}
          {groups.length === 0 && finished.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-500">{INSIGHT_LABELS.EMPTY}</p>
          )}
          {groups.map((group) => (
            <section key={group.severity} aria-label={group.label}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {group.label} · {group.cards.length}
              </h3>
              <ul className="space-y-3">
                {group.cards.map((card) => (
                  <InsightCard key={card.id} card={card} onNavigate={close} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
