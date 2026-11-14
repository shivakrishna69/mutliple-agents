/**
 * An offer's salary structure as the backend worked it out (services/ctcStructure.js), monthly and
 * annual: fixed pay, employer contributions, fixed CTC, variable pay, total CTC, estimated deductions
 * and take-home. A component HR set is marked so, to tell it from the policy's.
 */

import { formatInr } from '../ui.jsx';

function Row({ label, split, strong = false, monthly = true, note = null }) {
  return (
    <tr className={strong ? 'bg-slate-50 font-semibold text-slate-900' : 'text-slate-700'}>
      <td className="px-3 py-1.5">
        {label}
        {note && <span className="ml-1.5 text-xs font-normal text-slate-500">({note})</span>}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{monthly ? formatInr(split.monthly) : '—'}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{formatInr(split.annual)}</td>
    </tr>
  );
}

const Section = ({ label }) => (
  <tr>
    <td colSpan={3} className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
      {label}
    </td>
  </tr>
);

export default function StructureTable({ structure }) {
  const { earnings, employerContributions: employer, employeeDeductions: deductions } = structure;
  const setBy = (part) => (structure.splitSetBy?.[part] === 'hr' ? 'set by HR' : null);
  const optional = (label, split) => (split.annual > 0 ? <Row label={label} split={split} /> : null);
  return (
    <table className="w-full text-sm" aria-label="Salary structure">
      <thead className="border-b border-slate-200 text-xs text-slate-500">
        <tr>
          <th className="px-3 py-1.5 text-left font-medium">Component</th>
          <th className="px-3 py-1.5 text-right font-medium">Monthly</th>
          <th className="px-3 py-1.5 text-right font-medium">Annual</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        <Section label="Fixed pay" />
        <Row label="Basic" split={earnings.basic} note={setBy('basic')} />
        <Row label="HRA" split={earnings.hra} note={setBy('hra')} />
        <Row label="Special allowance" split={earnings.specialAllowance} />
        <Row label="Gross" split={earnings.gross} strong />
        <Section label="Employer contributions" />
        <Row label="Provident fund" split={employer.providentFund} />
        {optional('ESI', employer.esi)}
        {optional('Gratuity', employer.gratuity)}
        <Row label="Fixed CTC" split={structure.fixedCtc} strong />
        {structure.variablePay.annual > 0 && (
          <Row label="Variable pay (target)" split={structure.variablePay} monthly={false} />
        )}
        <Row label="Total CTC" split={{ monthly: 0, annual: structure.annualCtc }} strong monthly={false} />
        <Section label="Deductions (estimated)" />
        <Row label="Provident fund" split={deductions.providentFund} />
        {optional('ESI', deductions.esi)}
        {optional('Professional tax', deductions.professionalTax)}
        {optional(`Income tax (${structure.taxRegime} regime)`, deductions.incomeTax)}
        <Row label="Estimated take-home" split={structure.takeHome} strong />
      </tbody>
    </table>
  );
}
