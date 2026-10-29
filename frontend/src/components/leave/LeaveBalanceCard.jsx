/**
 * One leave balance: what is available now, what is held for pending requests, and where the
 * year's days came from and went. Used on the employee's own page and in HR's balances view.
 */

import { BALANCE_MOVEMENTS, formatDays, formatSignedDays } from '../../constants/leave.js';
import { Badge } from '../ui.jsx';

export default function LeaveBalanceCard({ balance }) {
  const movements = BALANCE_MOVEMENTS.filter(({ key }) => balance.movements[key] !== 0);
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{balance.leaveType.code}</p>
          <p className="text-sm font-medium text-slate-800">{balance.leaveType.name}</p>
        </div>
        {balance.heldDays > 0 && <Badge tone="amber">{formatDays(balance.heldDays)} held</Badge>}
      </div>
      <p className="mt-3 text-2xl font-bold tracking-tight text-slate-900">{formatDays(balance.availableDays)}</p>
      <p className="text-xs text-slate-500">available of {formatDays(balance.balanceDays)}</p>
      {movements.length > 0 && (
        <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs">
          {movements.map(({ key, label }) => (
            <div key={key} className="flex justify-between text-slate-600">
              <dt>{label}</dt>
              <dd className="font-medium tabular-nums">{formatSignedDays(balance.movements[key])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
