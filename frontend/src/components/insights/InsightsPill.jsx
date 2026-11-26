/**
 * The top bar's ✦ pill beside Ask NSK: how many briefing cards wait on the person, rose when any is
 * urgent; it opens the briefing panel. Hidden at 0 (and before the briefing has loaded).
 */

import { INSIGHT_LABELS } from '../../constants/insights.js';
import { useInsights } from './InsightsContext.jsx';

export default function InsightsPill() {
  const insights = useInsights();
  const total = insights?.briefing?.counts.total ?? 0;
  if (total === 0) return null;
  const urgent = insights.briefing.counts.urgent;
  const tone =
    urgent > 0
      ? 'bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100'
      : 'bg-white/70 text-brand-700 ring-slate-900/[0.06] hover:bg-white';
  return (
    <button
      type="button"
      onClick={insights.openPanel}
      aria-label={INSIGHT_LABELS.PILL(total, urgent)}
      aria-haspopup="dialog"
      data-testid="insights-pill"
      data-urgent={urgent > 0 || undefined}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold shadow-[inset_0_1px_1px_rgb(255_255_255/0.9)] ring-1 backdrop-blur transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${tone}`}
    >
      <span aria-hidden="true">{INSIGHT_LABELS.MARK}</span>
      <span aria-hidden="true">{total}</span>
    </button>
  );
}
