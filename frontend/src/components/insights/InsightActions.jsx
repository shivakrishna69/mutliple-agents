/**
 * A briefing card's actions (the backend's labels), shared by the briefing bar and the panel:
 *
 *   APPROVE_LEAVE   one click; for APPROVE_UNDO_MS it can be undone, then it is sent
 *   DECLINE_LEAVE   (panel only) opens an inline reason, required, then sends the decline
 *   OPEN_TASK, REVIEW_TASK, OPEN_PAGE   links to the page (a task opens on its board, ?task=<id>)
 *   ASK_NSK         links to Ask NSK with the prompt in the box, never sent by itself (?q=)
 *
 * A leave card being decided shows its state instead of its buttons: the undo countdown, sending, the
 * backend's message once done, or its error.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { INSIGHT_ACTIONS, INSIGHT_LABELS } from '../../constants/insights.js';
import { NSK_PREFILL_PARAMETER } from '../../constants/nskBot.js';
import { ROUTE_PATHS } from '../../constants/routes.js';
import { Button, Spinner } from '../ui.jsx';
import { useInsights } from './InsightsContext.jsx';

const LINK_KINDS = new Set([INSIGHT_ACTIONS.OPEN_TASK, INSIGHT_ACTIONS.REVIEW_TASK, INSIGHT_ACTIONS.OPEN_PAGE]);

/** Where a link action goes. */
export function actionPath(action) {
  if (action.kind === INSIGHT_ACTIONS.ASK_NSK) {
    return `${ROUTE_PATHS.ASK_NSK}?${new URLSearchParams({ [NSK_PREFILL_PARAMETER]: action.prompt ?? '' })}`;
  }
  return action.path;
}

const linkClassName = (isPrimary, size) =>
  `inline-flex shrink-0 items-center justify-center rounded-xl font-semibold transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
    size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
  } ${
    isPrimary
      ? 'bg-gradient-to-r from-brand-600 to-brand-700 text-white shadow-sm shadow-brand-600/20 hover:from-brand-500 hover:to-brand-600'
      : 'bg-white/70 text-slate-700 ring-1 ring-slate-900/10 ring-inset hover:bg-white/90 hover:text-slate-900'
  }`;

function secondsLeft(until) {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** "Approving in 4s · Undo" while it can still be taken back. */
function UndoCountdown({ cardId, until, size }) {
  const insights = useInsights();
  const [seconds, setSeconds] = useState(() => secondsLeft(until));
  useEffect(() => {
    const ticker = setInterval(() => setSeconds(secondsLeft(until)), 250);
    return () => clearInterval(ticker);
  }, [until]);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-slate-600" role="status">
      <span>
        {INSIGHT_LABELS.APPROVING} {seconds}s
      </span>
      <Button size={size} variant="ghost" onClick={() => insights.undo(cardId)}>
        {INSIGHT_LABELS.UNDO}
      </Button>
    </span>
  );
}

/** The state of a card being decided, or null when it is not. */
export function DecisionState({ card, size = 'sm' }) {
  const insights = useInsights();
  const decision = insights?.decisions[card.id];
  if (!decision) return null;
  if (decision.phase === 'undo') return <UndoCountdown cardId={card.id} until={decision.until} size={size} />;
  if (decision.phase === 'sending') return <Spinner className="h-4 w-4 text-brand-600" />;
  if (decision.phase === 'done') {
    return (
      <span className="text-xs font-medium text-emerald-700" role="status">
        {decision.notice}
      </span>
    );
  }
  return (
    <span className="text-xs font-medium text-rose-700" role="alert">
      {decision.error}
    </span>
  );
}

/**
 * One action as a button or link.
 * @param {{ card: object, action: object, isPrimary?: boolean, size?: 'sm'|'md', onDecline?: () => void,
 *   onNavigate?: () => void }} props
 */
export function InsightAction({ card, action, isPrimary = false, size = 'sm', onDecline, onNavigate }) {
  const insights = useInsights();
  if (action.kind === INSIGHT_ACTIONS.APPROVE_LEAVE) {
    return (
      <Button size={size} variant={isPrimary ? 'primary' : 'secondary'} onClick={() => insights.approve(card, action)}>
        {action.label}
      </Button>
    );
  }
  if (action.kind === INSIGHT_ACTIONS.DECLINE_LEAVE) {
    if (!onDecline) return null;
    return (
      <Button size={size} variant="secondary" onClick={onDecline}>
        {action.label}
      </Button>
    );
  }
  if (LINK_KINDS.has(action.kind) || action.kind === INSIGHT_ACTIONS.ASK_NSK) {
    return (
      <Link to={actionPath(action)} onClick={onNavigate} className={linkClassName(isPrimary, size)}>
        {action.label}
      </Link>
    );
  }
  return null;
}
