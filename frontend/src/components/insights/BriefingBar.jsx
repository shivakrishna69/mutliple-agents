/**
 * The briefing bar: one 44px line on My Access (above the tiles) and Overview (below the greeting).
 *
 *   ✦  headline ("1 revision needed · 2 overdue")  [n urgent]  │ top card's title  [its first action]
 *                                                                                  [Open briefing]
 *
 * The top card is the most pressing one (the backend sorts them); its first action works right here
 * (an Approve can be undone). With nothing waiting the bar says so, without buttons. It keeps its
 * height while the briefing loads, and is left out when the briefing cannot be read.
 */

import { INSIGHT_LABELS } from '../../constants/insights.js';
import { Button } from '../ui.jsx';
import { DecisionState, InsightAction } from './InsightActions.jsx';
import { useInsights } from './InsightsContext.jsx';

const BAR_CLASS_NAME =
  'flex h-11 min-w-0 items-center gap-3 rounded-2xl bg-white/60 px-4 text-sm shadow-[inset_0_1px_1px_rgb(255_255_255/0.9)] ring-1 ring-slate-900/[0.06] backdrop-blur';

export default function BriefingBar({ className = '' }) {
  const insights = useInsights();
  if (!insights) return null;
  const { briefing } = insights;
  if (!briefing) {
    if (insights.error) return null;
    return (
      <div className={`${BAR_CLASS_NAME} animate-pulse ${className}`} aria-hidden="true" data-testid="briefing-bar" />
    );
  }
  const [top] = briefing.cards;
  const urgent = briefing.counts.urgent;
  const primary = top?.actions[0] ?? null;
  return (
    <section
      className={`${BAR_CLASS_NAME} ${className}`}
      aria-label={INSIGHT_LABELS.PANEL_TITLE}
      data-testid="briefing-bar"
    >
      <span className="shrink-0 text-base text-brand-600" aria-hidden="true">
        {INSIGHT_LABELS.MARK}
      </span>
      <p className="min-w-0 truncate font-semibold text-slate-900" data-testid="briefing-headline">
        {briefing.headline}
      </p>
      {urgent > 0 && (
        <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
          {urgent} {INSIGHT_LABELS.URGENT}
        </span>
      )}
      {top && (
        <>
          <span className="hidden h-5 w-px shrink-0 bg-slate-900/10 md:block" aria-hidden="true" />
          <p className="hidden min-w-0 flex-1 truncate text-slate-600 md:block" title={top.title}>
            {top.title}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {insights.decisions[top.id] ? (
              <DecisionState card={top} />
            ) : (
              primary && <InsightAction card={top} action={primary} isPrimary />
            )}
            <Button size="sm" variant="secondary" onClick={insights.openPanel} data-testid="briefing-open">
              {INSIGHT_LABELS.OPEN_BRIEFING}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
