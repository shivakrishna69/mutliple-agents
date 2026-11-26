/**
 * The daily briefing for the whole signed-in app, shared by the top bar's ✦ pill, the briefing bars
 * (My Access, Overview), the slide-over panel and the My Access badges, so it is fetched once
 * (GET /api/insights/daily-briefing) and kept current:
 *
 *   live       the app shell's socket calls `scheduleReload` on INSIGHTS_CHANGED and after a
 *              reconnect; a burst of changes loads it once (INSIGHTS_RELOAD_DEBOUNCE_MS)
 *   panel      `openPanel` / `closePanel`
 *   decisions  leave cards decided from the briefing, by card id:
 *                approve   waits APPROVE_UNDO_MS ("Undo" cancels it), then is sent
 *                decline   sent at once, with the reason the person typed
 *              each is { phase: 'undo' | 'sending' | 'done' | 'error', notice?, error?, title }, and the
 *              backend's message is shown; the briefing reloads after each decision
 *
 * Outside the provider (a page rendered on its own, as in unit tests) useInsights() is null and the
 * briefing pieces render nothing.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { requestDailyBriefing } from '../../api/insightsApi.js';
import { requestLeaveApproval, requestLeaveRejection } from '../../api/leaveApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { APPROVE_UNDO_MS, INSIGHTS_RELOAD_DEBOUNCE_MS } from '../../constants/insights.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';

const InsightsContext = createContext(null);

/** The shared briefing state, or null outside the app shell. */
export function useInsights() {
  return useContext(InsightsContext);
}

/** The provider's value; the app shell calls it once and passes it to <InsightsProvider>. */
export function useInsightsState() {
  const { csrfToken } = useAuth();
  const resource = useApiResource((signal) => requestDailyBriefing(signal), []);
  const { reload } = resource;
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [decisions, setDecisions] = useState({});
  const reloadTimerRef = useRef(null);
  const undoTimersRef = useRef(new Map());

  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(reload, INSIGHTS_RELOAD_DEBOUNCE_MS);
  }, [reload]);

  useEffect(() => {
    const undoTimers = undoTimersRef.current;
    return () => {
      clearTimeout(reloadTimerRef.current);
      undoTimers.forEach((timer) => clearTimeout(timer));
      undoTimers.clear();
    };
  }, []);

  const setDecision = useCallback(
    (cardId, decision) => setDecisions((current) => ({ ...current, [cardId]: decision })),
    [],
  );

  const send = useCallback(
    async (card, title, request) => {
      setDecision(card.id, { phase: 'sending', title });
      try {
        const result = await request();
        setDecision(card.id, { phase: 'done', title, notice: result.notice ?? null });
      } catch (decisionError) {
        setDecision(card.id, { phase: 'error', title, error: toDisplayError(decisionError).message });
      }
      scheduleReload();
    },
    [scheduleReload, setDecision],
  );

  /** Approve after the undo window. */
  const approve = useCallback(
    (card, action) => {
      setDecision(card.id, { phase: 'undo', title: card.title, until: Date.now() + APPROVE_UNDO_MS });
      const timer = setTimeout(() => {
        undoTimersRef.current.delete(card.id);
        send(card, card.title, () =>
          requestLeaveApproval(action.requestId, { note: null, step: action.step }, csrfToken),
        );
      }, APPROVE_UNDO_MS);
      undoTimersRef.current.set(card.id, timer);
    },
    [csrfToken, send, setDecision],
  );

  const undo = useCallback((cardId) => {
    clearTimeout(undoTimersRef.current.get(cardId));
    undoTimersRef.current.delete(cardId);
    setDecisions((current) => {
      const next = { ...current };
      delete next[cardId];
      return next;
    });
  }, []);

  const decline = useCallback(
    (card, action, note) =>
      send(card, card.title, () =>
        requestLeaveRejection(action.requestId, { note: note.trim(), step: action.step }, csrfToken),
      ),
    [csrfToken, send],
  );

  /** Forgets the finished decisions (their cards are gone from the briefing by now). */
  const clearFinished = useCallback(
    () =>
      setDecisions((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, decision]) => decision.phase === 'undo' || decision.phase === 'sending'),
        ),
      ),
    [],
  );

  const openPanel = useCallback(() => setIsPanelOpen(true), []);
  const closePanel = useCallback(() => {
    setIsPanelOpen(false);
    clearFinished();
  }, [clearFinished]);

  return useMemo(
    () => ({
      briefing: resource.data ?? null,
      isLoading: resource.isLoading,
      error: resource.error,
      scheduleReload,
      isPanelOpen,
      openPanel,
      closePanel,
      decisions,
      approve,
      undo,
      decline,
    }),
    [
      resource.data,
      resource.isLoading,
      resource.error,
      scheduleReload,
      isPanelOpen,
      openPanel,
      closePanel,
      decisions,
      approve,
      undo,
      decline,
    ],
  );
}

export function InsightsProvider({ value, children }) {
  return <InsightsContext.Provider value={value}>{children}</InsightsContext.Provider>;
}
