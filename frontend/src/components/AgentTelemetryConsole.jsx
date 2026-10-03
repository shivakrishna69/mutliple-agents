/**
 * AgentTelemetryConsole: a live terminal view of what the AI agents are doing.
 *
 * Data comes from hooks/useAgentTelemetry.js (connection, subscription, buffering, cleanup; see the
 * WebSocket event handler architecture documented there). This component is presentation only:
 *
 *   header      connection state, pause/resume, clear, filters (event type, workflow, text)
 *   metrics     rolling figures over the buffered events: turns, average turn time, average model
 *               latency, generation speed (tokens/s), tool calls and failures, retrieval confidence
 *   log         one line per event, colour-coded by kind, newest at the bottom. Auto-scroll follows
 *               the tail unless the operator scrolls up to read; "Jump to latest" resumes following.
 *
 * Events carry identifiers and metrics only (never conversation text); see backend
 * services/agentTelemetry.js for the contract.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_BUFFERED_EVENTS, TELEMETRY_CONNECTION_STATUS, useAgentTelemetry } from '../hooks/useAgentTelemetry.js';

const CONNECTION_DISPLAY = Object.freeze({
  [TELEMETRY_CONNECTION_STATUS.CONNECTING]: { label: 'Connecting', dotClassName: 'bg-amber-400', pulse: true },
  [TELEMETRY_CONNECTION_STATUS.LIVE]: { label: 'Live', dotClassName: 'bg-emerald-400', pulse: true },
  [TELEMETRY_CONNECTION_STATUS.RECONNECTING]: { label: 'Reconnecting', dotClassName: 'bg-amber-400', pulse: true },
  [TELEMETRY_CONNECTION_STATUS.FORBIDDEN]: { label: 'Admins only', dotClassName: 'bg-rose-500', pulse: false },
  [TELEMETRY_CONNECTION_STATUS.ERROR]: { label: 'Subscription failed', dotClassName: 'bg-rose-500', pulse: false },
});

const EVENT_FILTERS = Object.freeze([
  { id: 'AGENT_THINKING_EVENT', label: 'Thinking' },
  { id: 'TOOL_EXECUTION_STARTED', label: 'Tool start' },
  { id: 'TOOL_EXECUTION_COMPLETED', label: 'Tool done' },
]);

const SCROLL_FOLLOW_THRESHOLD_PX = 48;

function formatClock(isoTimestamp) {
  const eventDate = new Date(isoTimestamp);
  return `${eventDate.toLocaleTimeString('en-GB', { hour12: false })}.${String(eventDate.getMilliseconds()).padStart(3, '0')}`;
}

const formatMs = (durationMs) => (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)}s` : `${Math.round(durationMs)}ms`);

/** The kind tag and colour for one event. */
function describeKind(telemetryEvent) {
  if (telemetryEvent.eventType === 'TOOL_EXECUTION_STARTED') return { tag: 'TOOL ▶', className: 'text-sky-300' };
  if (telemetryEvent.eventType === 'TOOL_EXECUTION_COMPLETED') return telemetryEvent.status === 'error' ? { tag: 'TOOL ✗', className: 'text-rose-400' } : { tag: 'TOOL ✓', className: 'text-emerald-300' };
  const phaseKinds = {
    turn_started: { tag: 'TURN ▶', className: 'text-violet-300' },
    turn_completed: { tag: 'TURN ✓', className: 'text-violet-300 font-semibold' },
    turn_failed: { tag: 'TURN ✗', className: 'text-rose-400 font-semibold' },
    node_started: { tag: 'NODE ▶', className: 'text-slate-400' },
    node_completed: { tag: 'NODE ■', className: 'text-slate-400' },
    model_call_completed: { tag: 'MODEL', className: 'text-amber-300' },
    model_call_failed: { tag: 'MODEL ✗', className: 'text-rose-400' },
    retrieval_completed: { tag: 'VECTOR', className: 'text-cyan-300' },
  };
  return phaseKinds[telemetryEvent.phase] ?? { tag: 'EVENT', className: 'text-slate-400' };
}

/** Human-readable detail for one event, built only from its metrics and names. */
function describeDetail(telemetryEvent) {
  const metrics = telemetryEvent.metrics ?? {};
  const detailParts = [];
  if (telemetryEvent.toolName) detailParts.push(telemetryEvent.toolName);
  if (telemetryEvent.phase === 'turn_started') detailParts.push(`${telemetryEvent.workflow} turn · ${metrics.transcriptMessages ?? '?'} messages in context`);
  if (metrics.modelName) detailParts.push(metrics.modelName);
  if (metrics.durationMs !== undefined) detailParts.push(formatMs(metrics.durationMs));
  if (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined) detailParts.push(`${metrics.inputTokens ?? '?'}→${metrics.outputTokens ?? '?'} tok`);
  if (metrics.tokensPerSecond !== undefined) detailParts.push(`${metrics.tokensPerSecond} tok/s`);
  if (metrics.resultChars !== undefined) detailParts.push(`${metrics.resultChars} chars`);
  if (metrics.documentsReturned !== undefined) detailParts.push(`${metrics.documentsReturned} docs`);
  if (metrics.topRelevanceScore !== undefined) detailParts.push(`top conf ${(metrics.topRelevanceScore * 100).toFixed(1)}%`);
  if (metrics.meanRelevanceScore !== undefined) detailParts.push(`mean conf ${(metrics.meanRelevanceScore * 100).toFixed(1)}%`);
  if (metrics.routeDecision) detailParts.push(`→ ${metrics.routeDecision}`);
  if (metrics.modelCalls !== undefined) detailParts.push(`${metrics.modelCalls} model / ${metrics.toolCalls ?? 0} tool calls`);
  if (telemetryEvent.errorType) detailParts.push(`error ${telemetryEvent.errorType}`);
  return detailParts.join(' · ');
}

const average = (values) => (values.length ? values.reduce((runningTotal, value) => runningTotal + value, 0) / values.length : null);

function computeMetrics(events) {
  const modelCalls = events.filter((telemetryEvent) => telemetryEvent.phase === 'model_call_completed');
  const finishedTurns = events.filter((telemetryEvent) => telemetryEvent.phase === 'turn_completed' || telemetryEvent.phase === 'turn_failed');
  const completedTools = events.filter((telemetryEvent) => telemetryEvent.eventType === 'TOOL_EXECUTION_COMPLETED');
  const retrievals = events.filter((telemetryEvent) => telemetryEvent.phase === 'retrieval_completed' && telemetryEvent.metrics?.topRelevanceScore !== undefined);
  return {
    turns: finishedTurns.length,
    failedTurns: finishedTurns.filter((telemetryEvent) => telemetryEvent.phase === 'turn_failed').length,
    averageTurnMs: average(finishedTurns.map((telemetryEvent) => telemetryEvent.metrics?.durationMs).filter(Number.isFinite)),
    averageModelMs: average(modelCalls.map((telemetryEvent) => telemetryEvent.metrics?.durationMs).filter(Number.isFinite)),
    averageTokensPerSecond: average(modelCalls.map((telemetryEvent) => telemetryEvent.metrics?.tokensPerSecond).filter(Number.isFinite)),
    toolCalls: completedTools.length,
    failedTools: completedTools.filter((telemetryEvent) => telemetryEvent.status === 'error').length,
    averageRetrievalConfidence: average(retrievals.map((telemetryEvent) => telemetryEvent.metrics.topRelevanceScore)),
  };
}

function MetricCell({ label, value, hint, accentClassName = 'text-white' }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/10">
      <p className="text-[0.65rem] font-semibold tracking-wider text-slate-500 uppercase">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold ${accentClassName}`}>{value}</p>
      {hint && <p className="font-mono text-[0.65rem] text-slate-500">{hint}</p>}
    </div>
  );
}

export default function AgentTelemetryConsole() {
  const { connectionStatus, events, isPaused, setPaused, heldBackCount, clearEvents } = useAgentTelemetry();
  const [enabledEventTypes, setEnabledEventTypes] = useState(() => new Set(EVENT_FILTERS.map((eventFilter) => eventFilter.id)));
  const [workflowFilter, setWorkflowFilter] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [isFollowingTail, setIsFollowingTail] = useState(true);
  const logContainerRef = useRef(null);

  const visibleEvents = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    return events.filter((telemetryEvent) => {
      if (!enabledEventTypes.has(telemetryEvent.eventType)) return false;
      if (workflowFilter !== 'all' && telemetryEvent.workflow !== workflowFilter) return false;
      if (!normalizedSearch) return true;
      return `${telemetryEvent.node ?? ''} ${telemetryEvent.toolName ?? ''} ${telemetryEvent.phase ?? ''} ${telemetryEvent.turnId} ${telemetryEvent.conversationId ?? ''} ${telemetryEvent.metrics?.modelName ?? ''}`.toLowerCase().includes(normalizedSearch);
    });
  }, [events, enabledEventTypes, workflowFilter, searchText]);

  const metrics = useMemo(() => computeMetrics(events), [events]);

  useEffect(() => {
    if (isFollowingTail && logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
  }, [visibleEvents, isFollowingTail]);

  function handleLogScroll() {
    const logContainer = logContainerRef.current;
    if (!logContainer) return;
    const distanceFromBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight;
    setIsFollowingTail(distanceFromBottom < SCROLL_FOLLOW_THRESHOLD_PX);
  }

  function toggleEventType(eventTypeId) {
    setEnabledEventTypes((previousTypes) => {
      const nextTypes = new Set(previousTypes);
      if (nextTypes.has(eventTypeId)) nextTypes.delete(eventTypeId);
      else nextTypes.add(eventTypeId);
      return nextTypes;
    });
  }

  const connectionDisplay = CONNECTION_DISPLAY[connectionStatus];

  return (
    <section className="overflow-hidden rounded-2xl bg-[#0b0f19] text-slate-200 shadow-2xl shadow-slate-900/30 ring-1 ring-white/10" aria-label="Agent telemetry console">
      {/* Title bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.02] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="h-3 w-3 rounded-full bg-rose-500/80" />
            <span className="h-3 w-3 rounded-full bg-amber-400/80" />
            <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
          </div>
          <p className="font-mono text-sm font-semibold text-slate-300">agent-telemetry</p>
          <span className="flex items-center gap-2 rounded-full bg-white/5 px-2.5 py-1 font-mono text-xs" role="status">
            <span className="relative flex h-2 w-2">
              {connectionDisplay.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${connectionDisplay.dotClassName}`} />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${connectionDisplay.dotClassName}`} />
            </span>
            {connectionDisplay.label}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {EVENT_FILTERS.map((eventFilter) => (
            <button
              key={eventFilter.id}
              type="button"
              aria-pressed={enabledEventTypes.has(eventFilter.id)}
              onClick={() => toggleEventType(eventFilter.id)}
              className={`rounded-lg px-2.5 py-1 font-mono text-xs transition ${enabledEventTypes.has(eventFilter.id) ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/40' : 'text-slate-500 ring-1 ring-white/10 hover:text-slate-300'}`}
            >
              {eventFilter.label}
            </button>
          ))}
          <select
            value={workflowFilter}
            onChange={(changeEvent) => setWorkflowFilter(changeEvent.target.value)}
            aria-label="Workflow"
            className="rounded-lg border-0 bg-white/5 px-2 py-1 font-mono text-xs text-slate-300 ring-1 ring-white/10 focus:ring-indigo-400"
          >
            <option value="all">all workflows</option>
            <option value="support">support</option>
            <option value="regularization">regularization</option>
          </select>
          <input
            value={searchText}
            onChange={(changeEvent) => setSearchText(changeEvent.target.value)}
            placeholder="grep node, tool, turn…"
            aria-label="Filter events"
            className="w-44 rounded-lg border-0 bg-white/5 px-2.5 py-1 font-mono text-xs text-slate-200 ring-1 ring-white/10 placeholder:text-slate-600 focus:ring-indigo-400"
          />
          <button type="button" onClick={() => setPaused(!isPaused)} className="rounded-lg bg-white/5 px-2.5 py-1 font-mono text-xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10">
            {isPaused ? `▶ resume${heldBackCount ? ` (+${heldBackCount})` : ''}` : '❚❚ pause'}
          </button>
          <button type="button" onClick={clearEvents} className="rounded-lg bg-white/5 px-2.5 py-1 font-mono text-xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10">
            clear
          </button>
        </div>
      </div>

      {/* Rolling metrics */}
      <div className="grid grid-cols-2 gap-3 border-b border-white/10 p-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCell label="Turns" value={metrics.turns} hint={metrics.failedTurns ? `${metrics.failedTurns} failed` : 'all succeeded'} accentClassName={metrics.failedTurns ? 'text-rose-300' : 'text-white'} />
        <MetricCell label="Avg turn" value={metrics.averageTurnMs === null ? '—' : formatMs(metrics.averageTurnMs)} hint="message processing" />
        <MetricCell label="Avg model latency" value={metrics.averageModelMs === null ? '—' : formatMs(metrics.averageModelMs)} accentClassName="text-amber-300" />
        <MetricCell label="Generation speed" value={metrics.averageTokensPerSecond === null ? '—' : `${Math.round(metrics.averageTokensPerSecond)}`} hint="tokens / second" accentClassName="text-amber-300" />
        <MetricCell label="Tool calls" value={metrics.toolCalls} hint={metrics.failedTools ? `${metrics.failedTools} failed` : 'no failures'} accentClassName={metrics.failedTools ? 'text-rose-300' : 'text-emerald-300'} />
        <MetricCell label="Vector confidence" value={metrics.averageRetrievalConfidence === null ? '—' : `${(metrics.averageRetrievalConfidence * 100).toFixed(1)}%`} hint="avg top match" accentClassName="text-cyan-300" />
      </div>

      {/* Log */}
      <div className="relative">
        <div ref={logContainerRef} onScroll={handleLogScroll} className="h-[28rem] overflow-y-auto px-4 py-3 font-mono text-[0.78rem] leading-6 [scrollbar-color:rgb(51_65_85)_transparent] [scrollbar-width:thin]" role="log" aria-live="off">
          {connectionStatus === TELEMETRY_CONNECTION_STATUS.FORBIDDEN && <p className="text-rose-400">$ subscription refused: agent telemetry is available to administrators only.</p>}
          {visibleEvents.length === 0 && connectionStatus !== TELEMETRY_CONNECTION_STATUS.FORBIDDEN && (
            <p className="text-slate-500">
              $ waiting for agent activity…<span className="ml-1 inline-block h-4 w-2 animate-pulse bg-slate-500 align-middle" />
            </p>
          )}
          {visibleEvents.map((telemetryEvent) => {
            const kind = describeKind(telemetryEvent);
            const isTurnBoundary = telemetryEvent.phase === 'turn_started';
            return (
              <div key={telemetryEvent.eventId} className={`flex gap-3 whitespace-pre-wrap hover:bg-white/[0.03] ${isTurnBoundary ? 'mt-2 border-t border-white/5 pt-2' : ''}`}>
                <span className="shrink-0 text-slate-600">{formatClock(telemetryEvent.occurredAt)}</span>
                <span className="w-16 shrink-0 text-slate-600" title={`turn ${telemetryEvent.turnId}`}>
                  {telemetryEvent.turnId.slice(0, 6)}#{String(telemetryEvent.sequence).padStart(2, '0')}
                </span>
                <span className={`w-16 shrink-0 ${kind.className}`}>{kind.tag}</span>
                <span className="w-32 shrink-0 truncate text-indigo-300">{telemetryEvent.node ?? (telemetryEvent.workflow === 'support' ? 'gateway' : telemetryEvent.workflow)}</span>
                <span className="min-w-0 flex-1 text-slate-300">{describeDetail(telemetryEvent)}</span>
              </div>
            );
          })}
        </div>
        {!isFollowingTail && (
          <button
            type="button"
            onClick={() => setIsFollowingTail(true)}
            className="absolute right-6 bottom-4 rounded-full bg-indigo-600 px-3 py-1.5 font-mono text-xs text-white shadow-lg shadow-indigo-900/50 hover:bg-indigo-500"
          >
            ↓ jump to latest
          </button>
        )}
      </div>
      <div className="flex justify-between border-t border-white/10 px-4 py-2 font-mono text-[0.65rem] text-slate-600">
        <span>
          {visibleEvents.length} shown · {events.length}/{MAX_BUFFERED_EVENTS} buffered
        </span>
        <span>metrics only · no conversation content</span>
      </div>
    </section>
  );
}
