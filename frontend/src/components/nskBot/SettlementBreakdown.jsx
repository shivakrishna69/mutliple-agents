/**
 * A full and final settlement as the backend computed it (utils/payroll/finalSettlement.js), shared
 * by the offboarding panel in NSK and the read-only settlements view: the 2-working-day payment banner,
 * the backend's notes, earnings and deductions with their totals, the net payable or recoverable, and
 * the service, notice, gratuity and tax figures. Every amount and text is the backend's.
 */

import { OFFBOARDING_LABELS as L } from '../../constants/nskBot.js';
import { ClockIcon } from '../Icons.jsx';
import { formatInr } from '../ui.jsx';

function LineTable({ title, lines, totalLabel, total }) {
  return (
    <div>
      <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</h4>
      <table className="mt-1 w-full text-sm">
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.code}-${index}`} className="border-b border-slate-100">
              <td className="py-1 pr-2 text-slate-700">{line.label}</td>
              <td className="py-1 text-right tabular-nums">{formatInr(line.amount)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1 pr-2">{totalLabel}</td>
            <td className="py-1 text-right tabular-nums">{formatInr(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-1.5">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="text-xs font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

/** @param {{ offboardingCase: object }} props  a case summary from the offboarding API */
export default function SettlementBreakdown({ offboardingCase }) {
  const { settlement } = offboardingCase;
  const { totals, notice, gratuity, service, tax } = settlement;
  const owesCompany = totals.net < 0;
  return (
    <div className="space-y-3" data-testid="settlement-breakdown">
      <div
        role="status"
        className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200"
      >
        <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <span>{offboardingCase.complianceNote}</span>
      </div>
      {offboardingCase.notes?.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
          {offboardingCase.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <LineTable
          title={L.EARNINGS}
          lines={settlement.earnings}
          totalLabel={L.TOTAL_EARNINGS}
          total={totals.earnings}
        />
        <LineTable
          title={L.DEDUCTIONS}
          lines={settlement.deductions}
          totalLabel={L.TOTAL_DEDUCTIONS}
          total={totals.deductions}
        />
      </div>
      <div
        className={`flex items-center justify-between rounded-xl px-3 py-2.5 ring-2 ${owesCompany ? 'bg-rose-50 ring-rose-300' : 'bg-emerald-50 ring-emerald-300'}`}
      >
        <span className="text-sm text-slate-700">{owesCompany ? L.NET_RECOVERABLE : L.NET_PAYABLE}</span>
        <strong className="text-lg tabular-nums" data-testid="settlement-net">
          {formatInr(Math.abs(totals.net))}
        </strong>
      </div>
      <dl className="grid grid-cols-2 gap-1.5">
        <Fact label={L.SERVICE} value={`${service.years}y ${service.months}m ${service.days}d`} />
        <Fact
          label={L.NOTICE}
          value={L.NOTICE_SUMMARY(notice.periodDays, notice.servedDays, notice.shortfallDays, notice.waived)}
        />
        <Fact label={L.GRATUITY} value={L.GRATUITY_SUMMARY(gratuity.eligible, gratuity.completedYears)} />
        <Fact label={L.TAX} value={`${tax.regime} · ${tax.tds === null ? '—' : formatInr(tax.tds)}`} />
      </dl>
    </div>
  );
}
