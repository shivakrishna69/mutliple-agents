/**
 * Leave maintenance (HR and admins). Both jobs also run on their own every hour; these buttons are
 * for when HR wants the result now. Both are safe to run any number of times.
 *
 *   POST /api/leave/jobs/accrual { asOfDate? }   post accruals and year ends that are due
 *   POST /api/leave/jobs/reconcile               finish interrupted request changes, then check
 *                                                every balance against the ledger
 */

import { useState } from 'react';
import { requestLeaveJobRun, requestLeaveReconciliation } from '../../api/leaveApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { localToday } from '../../utils/dates.js';
import { Button, Card, Notice, TextInput } from '../ui.jsx';

/** "accrualsPosted" -> "Accruals posted" for the summary list. */
function humanize(summaryKey) {
  const words = summaryKey.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function SummaryList({ summary }) {
  return (
    <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {Object.entries(summary).map(([summaryKey, count]) => (
        <div key={summaryKey} className="flex justify-between border-b border-slate-100 py-1">
          <dt className="text-slate-600">{humanize(summaryKey)}</dt>
          <dd className="font-medium tabular-nums text-slate-900">{count}</dd>
        </div>
      ))}
    </dl>
  );
}

function useJob(runJob) {
  const [state, setState] = useState({ isRunning: false, summary: null, error: null });
  async function run(...jobArguments) {
    setState({ isRunning: true, summary: null, error: null });
    try {
      const { summary } = await runJob(...jobArguments);
      setState({ isRunning: false, summary, error: null });
    } catch (jobError) {
      setState({ isRunning: false, summary: null, error: toDisplayError(jobError) });
    }
  }
  return [state, run];
}

export default function LeaveJobsPanel() {
  const { csrfToken } = useAuth();
  const [asOfDate, setAsOfDate] = useState('');
  const [accrualJob, runAccrualJob] = useJob((date) => requestLeaveJobRun(date || null, csrfToken));
  const [reconciliation, runReconciliation] = useJob(() => requestLeaveReconciliation(csrfToken));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card
        title="Accruals and year end"
        subtitle="Credits monthly and yearly leave that is due, and closes a leave year once the next one starts."
      >
        <div className="flex flex-wrap items-end gap-3">
          <TextInput
            label="As of (optional)"
            type="date"
            max={localToday()}
            value={asOfDate}
            onChange={(changeEvent) => setAsOfDate(changeEvent.target.value)}
            hint="Empty: each employee's today"
          />
          <Button onClick={() => runAccrualJob(asOfDate)} isBusy={accrualJob.isRunning}>
            Run now
          </Button>
        </div>
        {accrualJob.error && (
          <div className="mt-4">
            <Notice tone="error" title={accrualJob.error.message} />
          </div>
        )}
        {accrualJob.summary && <SummaryList summary={accrualJob.summary} />}
      </Card>

      <Card
        title="Check balances"
        subtitle="Finishes leave changes a server restart interrupted, then checks every balance against its history."
      >
        <Button onClick={() => runReconciliation()} isBusy={reconciliation.isRunning}>
          Check now
        </Button>
        {reconciliation.error && (
          <div className="mt-4">
            <Notice tone="error" title={reconciliation.error.message} />
          </div>
        )}
        {reconciliation.summary && (
          <>
            <p className="mt-4 text-xs font-semibold tracking-wide text-slate-500 uppercase">Leave requests</p>
            <SummaryList summary={reconciliation.summary.requests} />
            <p className="mt-4 text-xs font-semibold tracking-wide text-slate-500 uppercase">Balances</p>
            <SummaryList summary={reconciliation.summary.balances} />
          </>
        )}
      </Card>
    </div>
  );
}
