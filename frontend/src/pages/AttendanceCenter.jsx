/**
 * Attendance Center: three tools for one workflow.
 *
 *   Punch in        reads the browser's GPS fix (high accuracy) and posts it with this device's
 *                   fingerprint to POST /api/attendance/punch-in. The backend checks the geofence,
 *                   the registered device and the shift; its error codes are explained in plain words.
 *   Regularize      a chat with the AI regularization agent (POST /api/attendance/regularize) for a
 *                   missed punch. The agent either records the entry, asks a follow-up question, or
 *                   routes the request to the reporting manager.
 *   Manager reviews requests the agent escalated (GET /api/attendance/regularization-reviews), with
 *                   approve/reject. Visible to everyone; the backend returns 403 for people who
 *                   manage no one, which the tab shows as "nothing to review".
 *
 * Device fingerprint: a random 32-byte token generated once and kept in localStorage. It identifies
 * this browser, not the person, and carries no personal data; HR registers it as the employee's device.
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/httpClient.js';
import { requestPunchIn, requestRegularization, requestRegularizationReviews, requestReviewDecision } from '../api/workforceApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { CheckBadgeIcon, ClockIcon, InboxIcon, MapPinIcon, SparklesIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, SelectInput, StatTile, Tabs, TextInput, formatDate, formatDateTime } from '../components/ui.jsx';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';

const DEVICE_FINGERPRINT_STORAGE_KEY = 'nova.attendance.deviceFingerprint';
const GEOLOCATION_TIMEOUT_MS = 20_000;

/** Plain-language explanations for the punch-in error codes (backend ATTENDANCE_ERROR_CODES). */
const PUNCH_IN_ERROR_HELP = Object.freeze({
  PROFILE_NOT_FOUND: 'Your account is not linked to an employee profile yet. Ask HR to set it up.',
  EMPLOYMENT_ENDED: 'Your employment record is no longer active, so punch-in is disabled.',
  OFFICE_NOT_CONFIGURED: 'No office is assigned to your profile. Ask HR to assign one.',
  GEOFENCE_NOT_CONFIGURED: 'Your office has no geofence configured yet. Ask an administrator.',
  DEVICE_NOT_RECOGNISED: 'This device is not registered for you. Share the device ID below with HR to register it.',
  LOCATION_TOO_IMPRECISE: 'Your location fix is too imprecise. Move near a window or enable precise location, then retry.',
  UNAUTHORIZED_SPATIAL_LOCATION: 'You appear to be outside the office geofence.',
  ALREADY_PUNCHED_IN: 'You have already punched in today.',
});

function readDeviceFingerprint() {
  try {
    const storedFingerprint = window.localStorage.getItem(DEVICE_FINGERPRINT_STORAGE_KEY);
    if (storedFingerprint && storedFingerprint.length >= 16) return storedFingerprint;
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const generatedFingerprint = `web-${Array.from(randomBytes, (byteValue) => byteValue.toString(16).padStart(2, '0')).join('')}`;
    window.localStorage.setItem(DEVICE_FINGERPRINT_STORAGE_KEY, generatedFingerprint);
    return generatedFingerprint;
  } catch {
    // Storage blocked (private mode): a per-session token still lets the request be judged.
    return `web-session-${crypto.randomUUID().replaceAll('-', '')}`;
  }
}

function readCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share your location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (positionError) => {
      const reasons = { 1: 'Location permission was denied. Allow location access for this site and retry.', 2: 'Your location is unavailable right now.', 3: 'Getting your location took too long. Retry.' };
      reject(new Error(reasons[positionError.code] ?? 'Your location could not be read.'));
    }, { enableHighAccuracy: true, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 0 });
  });
}

// =================================================================================================
// Punch in
// =================================================================================================

function PunchInPanel() {
  const { csrfToken } = useAuth();
  const [deviceFingerprint] = useState(readDeviceFingerprint);
  const [phase, setPhase] = useState('idle'); // idle | locating | submitting
  const [attendance, setAttendance] = useState(null);
  const [failure, setFailure] = useState(null);
  const [lastFix, setLastFix] = useState(null);

  async function handlePunchIn() {
    setFailure(null);
    setPhase('locating');
    try {
      const position = await readCurrentPosition();
      const fix = { lat: position.coords.latitude, lng: position.coords.longitude, accuracyMeters: Math.max(1, Math.round(position.coords.accuracy * 10) / 10) };
      setLastFix(fix);
      setPhase('submitting');
      const { attendance: recordedAttendance } = await requestPunchIn({ ...fix, deviceFingerprint }, csrfToken);
      setAttendance(recordedAttendance);
    } catch (punchError) {
      if (punchError instanceof ApiError) {
        setFailure({ title: punchError.message, help: PUNCH_IN_ERROR_HELP[punchError.code] ?? null, context: punchError.context, requestId: punchError.status >= 500 ? punchError.requestId : null });
      } else {
        setFailure({ title: punchError.message, help: null, context: null });
      }
    } finally {
      setPhase('idle');
    }
  }

  const statusTone = { Normal: 'emerald', Late: 'amber' }[attendance?.calculationStatus] ?? 'rose';

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3" bodyClassName="p-0">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-violet-950 px-6 py-10 text-white sm:px-10">
          <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-indigo-500/30 blur-3xl" aria-hidden="true" />
          <div className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-violet-500/20 blur-3xl" aria-hidden="true" />
          <p className="text-sm font-medium text-indigo-200">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight">{attendance ? 'You are checked in' : 'Ready to start your day?'}</h2>
          <p className="mt-2 max-w-md text-sm text-slate-300">
            Your position is checked against your office geofence. Location is read once, only when you press the button.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={handlePunchIn}
              disabled={phase !== 'idle' || Boolean(attendance)}
              className="group relative inline-flex h-16 items-center gap-3 rounded-2xl bg-white px-7 text-base font-semibold text-indigo-700 shadow-xl shadow-indigo-950/40 transition hover:scale-[1.02] focus-visible:ring-4 focus-visible:ring-indigo-300 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:scale-100"
            >
              <span className="relative flex h-3 w-3">
                {phase === 'idle' && !attendance && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />}
                <span className={`relative inline-flex h-3 w-3 rounded-full ${attendance ? 'bg-emerald-500' : 'bg-emerald-400'}`} />
              </span>
              {phase === 'locating' ? 'Getting your location…' : phase === 'submitting' ? 'Verifying…' : attendance ? 'Punched in' : 'Punch in now'}
            </button>
            {lastFix && <span className="text-xs text-slate-400">GPS accuracy ±{lastFix.accuracyMeters} m</span>}
          </div>
        </div>
      </Card>

      <div className="space-y-4 lg:col-span-2">
        {attendance && (
          <Card title="Today's entry" subtitle={formatDate(attendance.date)}>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Checked in</dt>
                <dd className="mt-1 font-semibold text-slate-900">{formatDateTime(attendance.checkInTime)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Status</dt>
                <dd className="mt-1">
                  <Badge tone={statusTone}>{attendance.calculationStatus.replaceAll('_', ' ')}</Badge>
                  {attendance.lateByMinutes > 0 && <span className="ml-2 text-xs text-amber-700">{attendance.lateByMinutes} min late</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Distance from office</dt>
                <dd className="mt-1 font-semibold text-slate-900">{attendance.geofence.distanceMeters ?? '—'} m</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Allowed radius</dt>
                <dd className="mt-1 font-semibold text-slate-900">{attendance.geofence.allowedRadiusMeters ?? '—'} m</dd>
              </div>
            </dl>
          </Card>
        )}
        {failure && (
          <Notice tone="error" title={failure.title} onDismiss={() => setFailure(null)}>
            {failure.help && <p>{failure.help}</p>}
            {failure.context?.distanceMeters !== undefined && (
              <p className="mt-1">
                Distance {failure.context.distanceMeters} m · allowed {failure.context.allowedRadiusMeters} m
              </p>
            )}
            {failure.requestId && <p className="mt-1 font-mono text-xs">Reference: {failure.requestId}</p>}
          </Notice>
        )}
        <Card title="This device" subtitle="Registered devices only can punch in">
          <p className="text-xs text-slate-500">Device ID</p>
          <p className="mt-1 font-mono text-xs break-all text-slate-700 select-all">{deviceFingerprint}</p>
        </Card>
      </div>
    </div>
  );
}

// =================================================================================================
// Regularization chat
// =================================================================================================

const OUTCOME_DISPLAY = Object.freeze({
  approved: { label: 'Recorded', tone: 'emerald' },
  awaiting_employee_input: { label: 'Needs your answer', tone: 'amber' },
  routed_to_manager: { label: 'Sent to your manager', tone: 'sky' },
  out_of_scope: { label: 'Outside attendance', tone: 'slate' },
});

function RegularizationChat() {
  const { csrfToken } = useAuth();
  const [chatMessages, setChatMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [startNext, setStartNext] = useState(true);
  const scrollAnchorRef = useRef(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatMessages, isSending]);

  async function handleSend(submitEvent) {
    submitEvent.preventDefault();
    const message = draft.trim();
    if (!message || isSending) return;
    setDraft('');
    setSendError(null);
    setChatMessages((previousMessages) => [...previousMessages, { id: crypto.randomUUID(), author: 'me', text: message }]);
    setIsSending(true);
    try {
      const { regularization } = await requestRegularization({ message, startNew: startNext }, csrfToken);
      setChatMessages((previousMessages) => [...previousMessages, { id: crypto.randomUUID(), author: 'agent', text: regularization.reply, regularization }]);
      // The next message continues this request only while the agent is waiting for an answer.
      setStartNext(!regularization.awaitingInput);
    } catch (regularizationError) {
      setSendError(toDisplayError(regularizationError));
      setDraft(message);
      setChatMessages((previousMessages) => previousMessages.slice(0, -1));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <Card
      title="Attendance assistant"
      subtitle="Describe a missed punch, e.g. “I forgot to punch in yesterday, I arrived at 9:40”"
      actions={
        chatMessages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => { setChatMessages([]); setStartNext(true); }}>
            New request
          </Button>
        )
      }
      bodyClassName="flex h-[32rem] flex-col"
    >
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 scroll-thin" aria-live="polite">
        {chatMessages.length === 0 && (
          <EmptyState Icon={SparklesIcon} title="No requests yet" description="The assistant checks your activity evidence, records the entry when it is clear, or asks your manager when it is not." />
        )}
        {chatMessages.map((chatMessage) => (
          <div key={chatMessage.id} className={`flex ${chatMessage.author === 'me' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${chatMessage.author === 'me' ? 'rounded-br-md bg-gradient-to-br from-indigo-600 to-violet-600 text-white' : 'rounded-bl-md bg-slate-100 text-slate-800'}`}>
              <p className="whitespace-pre-wrap">{chatMessage.text}</p>
              {chatMessage.regularization && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone={OUTCOME_DISPLAY[chatMessage.regularization.outcome]?.tone ?? 'slate'}>
                    {OUTCOME_DISPLAY[chatMessage.regularization.outcome]?.label ?? chatMessage.regularization.outcome}
                  </Badge>
                  {chatMessage.regularization.approval && (
                    <span className="text-xs text-slate-500">
                      {chatMessage.regularization.approval.date} at {chatMessage.regularization.approval.punchInTime}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {isSending && (
          <div className="flex justify-start">
            <div className="flex gap-1 rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3" aria-label="Assistant is typing">
              {[0, 150, 300].map((delayMs) => (
                <span key={delayMs} className="h-2 w-2 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${delayMs}ms` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={scrollAnchorRef} />
      </div>
      {sendError && (
        <div className="px-5 pb-2">
          <Notice tone="error" title={sendError.message} onDismiss={() => setSendError(null)} />
        </div>
      )}
      <form onSubmit={handleSend} className="flex gap-3 border-t border-slate-100 p-4">
        <input
          value={draft}
          onChange={(changeEvent) => setDraft(changeEvent.target.value)}
          maxLength={2000}
          placeholder={startNext ? 'Describe the missed punch…' : 'Answer the assistant…'}
          aria-label="Message to the attendance assistant"
          className="flex-1 rounded-xl border-0 bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200 ring-inset focus:ring-2 focus:ring-indigo-500 focus:outline-none"
        />
        <Button type="submit" isBusy={isSending} disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </Card>
  );
}

// =================================================================================================
// Manager reviews
// =================================================================================================

const REVIEW_STATUS_OPTIONS = [
  { value: 'Pending', label: 'Pending' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Rejected', label: 'Rejected' },
];

function ReviewCard({ review, onDecided }) {
  const { csrfToken } = useAuth();
  const [punchInTime, setPunchInTime] = useState(review.claimedPunchInTime ?? '09:30');
  const [note, setNote] = useState('');
  const [busyDecision, setBusyDecision] = useState(null);
  const [decisionError, setDecisionError] = useState(null);

  async function decide(decision) {
    setBusyDecision(decision);
    setDecisionError(null);
    try {
      await requestReviewDecision(review.id, { decision, ...(decision === 'approve' && { punchInTime }), ...(note.trim() && { note: note.trim() }) }, csrfToken);
      onDecided();
    } catch (reviewError) {
      setDecisionError(toDisplayError(reviewError));
    } finally {
      setBusyDecision(null);
    }
  }

  const isPending = review.status === 'Pending';
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-slate-900">{review.employee?.name ?? 'Employee'}</p>
          <p className="text-xs text-slate-500">{review.employee?.designation}</p>
        </div>
        <Badge tone={{ Pending: 'amber', Approved: 'emerald', Rejected: 'rose' }[review.status] ?? 'slate'}>{review.status}</Badge>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-slate-500">Date</dt>
          <dd className="font-medium text-slate-800">{review.date}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Claimed punch-in</dt>
          <dd className="font-medium text-slate-800">{review.claimedPunchInTime ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Evidence events</dt>
          <dd className="font-medium text-slate-800">{review.qualifyingEventCount ?? 0}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Why escalated</dt>
          <dd className="font-medium text-slate-800">{String(review.routingReason ?? '—').replaceAll('_', ' ')}</dd>
        </div>
      </dl>
      {review.reason && <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">“{review.reason}”</p>}
      {isPending ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
          <TextInput label="Approve at" type="time" value={punchInTime} onChange={(changeEvent) => setPunchInTime(changeEvent.target.value)} />
          <TextInput label="Note (optional)" value={note} maxLength={300} onChange={(changeEvent) => setNote(changeEvent.target.value)} />
          <div className="flex gap-2">
            <Button variant="success" isBusy={busyDecision === 'approve'} disabled={Boolean(busyDecision)} onClick={() => decide('approve')}>
              Approve
            </Button>
            <Button variant="secondary" isBusy={busyDecision === 'reject'} disabled={Boolean(busyDecision)} onClick={() => decide('reject')}>
              Reject
            </Button>
          </div>
        </div>
      ) : (
        review.decision && (
          <p className="mt-3 text-xs text-slate-500">
            Decided {formatDateTime(review.decision.decidedAt)}
            {review.decision.approvedPunchInTime && ` · punch-in ${review.decision.approvedPunchInTime}`}
            {review.decision.note && ` · “${review.decision.note}”`}
          </p>
        )
      )}
      {decisionError && (
        <div className="mt-3">
          <Notice tone="error" title={decisionError.message} onDismiss={() => setDecisionError(null)} />
        </div>
      )}
    </div>
  );
}

function ManagerReviews() {
  const [statusFilter, setStatusFilter] = useState('Pending');
  const { data, error, isLoading, reload } = useApiResource((signal) => requestRegularizationReviews(statusFilter, signal), [statusFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SelectInput label="Status" options={REVIEW_STATUS_OPTIONS} value={statusFilter} onChange={(changeEvent) => setStatusFilter(changeEvent.target.value)} className="w-48" />
        {data?.meta && <p className="text-xs text-slate-500">Scope: {data.meta.scope === 'organisation' ? 'whole organisation' : 'your direct reports'}</p>}
      </div>
      {isLoading && !data && <LoadingBlock label="Loading reviews…" />}
      {error &&
        (error.status === 403 ? (
          <EmptyState Icon={InboxIcon} title="Nothing to review" description="Reviews appear here when someone who reports to you asks for an attendance correction." />
        ) : (
          <Notice tone="error" title={error.message} />
        ))}
      {data && data.reviews.length === 0 && <EmptyState Icon={CheckBadgeIcon} title="All caught up" description={`No ${statusFilter.toLowerCase()} reviews.`} />}
      <div className="grid gap-4 xl:grid-cols-2">
        {data?.reviews.map((review) => (
          <ReviewCard key={review.id} review={review} onDecided={reload} />
        ))}
      </div>
    </div>
  );
}

// =================================================================================================
// Page
// =================================================================================================

const TABS = [
  { id: 'punch', label: 'Punch in', Icon: MapPinIcon },
  { id: 'regularize', label: 'Regularize', Icon: SparklesIcon },
  { id: 'reviews', label: 'Manager reviews', Icon: InboxIcon },
];

export default function AttendanceCenter() {
  const [activeTabId, setActiveTabId] = useState('punch');
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title="Attendance" description="Geofenced punch-in, AI-assisted corrections and manager approvals." />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Check-in" value="Geofenced" hint="GPS verified against your office" Icon={MapPinIcon} accent="indigo" />
        <StatTile label="Corrections" value="AI assisted" hint="Evidence-checked, manager fallback" Icon={SparklesIcon} accent="emerald" />
        <StatTile label="Approvals" value="One click" hint="For managers and HR" Icon={ClockIcon} accent="amber" />
      </div>
      <Tabs tabs={TABS} activeTabId={activeTabId} onChange={setActiveTabId} label="Attendance tools" />
      {activeTabId === 'punch' && <PunchInPanel />}
      {activeTabId === 'regularize' && <RegularizationChat />}
      {activeTabId === 'reviews' && <ManagerReviews />}
    </div>
  );
}
