/**
 * The offer letter as one self-contained, print-ready A4 HTML document, laid out like the payslip
 * (services/payslipHtmlTemplate.js): inline styles, the inline SVG brand mark, system fonts, and a
 * Content-Security-Policy that forbids every external resource and script. Every value inserted
 * into the markup is escaped: names, designations and clauses come from user-editable records.
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ logo  Company legal name        OFFER LETTER  │  brand header
 *   │       Registered address        issued date   │
 *   ├───────────────────────────────────────────────┤
 *   │ Dear <name>, we are pleased to offer you ...  │  the offer
 *   │ Position details (designation, department,    │
 *   │ manager, joining date, work location, status) │
 *   ├───────────────────────────────────────────────┤
 *   │ Compensation (monthly | annual): earnings,    │  services/ctcStructure.js, as computed
 *   │ employer contributions, CTC, deductions,      │
 *   │ estimated take-home                           │
 *   ├───────────────────────────────────────────────┤
 *   │ Terms: probation, notice, hours, clauses      │  OnboardingSettings.offerTerms
 *   │ Acceptance by <date>, signatory               │
 *   └───────────────────────────────────────────────┘
 *
 * A preview carries a diagonal watermark (ONBOARDING_MESSAGES.PREVIEW_WATERMARK) on every page.
 */

import { escapeHtml } from '../utils/html.js';
import { splitAnnual } from './ctcStructure.js';
import { brandMarkSvg } from './payslipHtmlTemplate.js';

const moneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const formatMoney = (amount) => moneyFormatter.format(amount);
const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'UTC' });
const formatDate = (date) => dateFormatter.format(date);

function detail(label, value) {
  return `<div class="detail"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value)}</span></div>`;
}

function moneyRow(label, split, { emphasis = false } = {}) {
  return `<tr class="${emphasis ? 'emphasis' : ''}"><td>${escapeHtml(label)}</td><td class="amount">${escapeHtml(
    formatMoney(split.monthly),
  )}</td><td class="amount">${escapeHtml(formatMoney(split.annual))}</td></tr>`;
}

function sectionRow(label) {
  return `<tr class="section"><td colspan="3">${escapeHtml(label)}</td></tr>`;
}

function compensationTable(structure) {
  const { earnings, employerContributions: employer, employeeDeductions: employee, takeHome } = structure;
  const ctcSplit = splitAnnual(structure.annualCtc);
  const optionalRow = (label, split) => (split.annual > 0 ? moneyRow(label, split) : '');
  return `<table class="money">
    <thead><tr><th>Component</th><th class="amount">Monthly</th><th class="amount">Annual</th></tr></thead>
    <tbody>
      ${sectionRow('Earnings')}
      ${moneyRow('Basic salary', earnings.basic)}
      ${moneyRow('House rent allowance', earnings.hra)}
      ${moneyRow('Special allowance', earnings.specialAllowance)}
      ${moneyRow('Gross salary', earnings.gross, { emphasis: true })}
      ${sectionRow('Employer contributions')}
      ${moneyRow('Provident fund (employer)', employer.providentFund)}
      ${optionalRow('ESI (employer)', employer.esi)}
      ${optionalRow('Gratuity', employer.gratuity)}
      ${moneyRow('Cost to company (CTC)', ctcSplit, { emphasis: true })}
      ${sectionRow('Deductions (estimated)')}
      ${moneyRow('Provident fund (employee)', employee.providentFund)}
      ${optionalRow('ESI (employee)', employee.esi)}
      ${optionalRow('Professional tax', employee.professionalTax)}
      ${optionalRow(`Income tax (${structure.taxRegime} regime, ${structure.taxYear})`, employee.incomeTax)}
      ${moneyRow('Estimated take-home', takeHome, { emphasis: true })}
    </tbody>
  </table>`;
}

/**
 * @param {{ company: { name: string, legalName: string|null, registeredAddress: string|null, brandColor: string },
 *   candidate: { name: string },
 *   position: { designation: string, departmentName: string, managerName: string|null, dateOfJoining: Date,
 *     workLocationType: string, employmentStatus: string },
 *   structure: object, terms: object, issuedOn: Date, validUntil: Date, watermark: string|null }} letter
 * @returns {string} complete HTML document
 */
export function compileOfferLetterHtml({
  company,
  candidate,
  position,
  structure,
  terms,
  issuedOn,
  validUntil,
  watermark,
}) {
  const companyName = company.legalName ?? company.name;
  const firstName = candidate.name.split(/\s+/)[0];
  const clauses = terms.additionalClauses.map((clause) => `<li>${escapeHtml(clause)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(`Offer letter – ${candidate.name}`)}</title>
<style>
  @page { size: A4; margin: 14mm 15mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 9.5pt; color: #0f172a; line-height: 1.42; }
  .header { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid ${escapeHtml(company.brandColor)}; padding-bottom: 10px; }
  .brand-mark { width: 40px; height: 40px; flex: none; }
  .company { flex: 1; }
  .company-name { font-size: 14pt; font-weight: 700; }
  .company-address { color: #475569; font-size: 8.5pt; }
  .doc-title { text-align: right; }
  .doc-title strong { display: block; font-size: 13pt; letter-spacing: 0.08em; color: ${escapeHtml(company.brandColor)}; }
  .doc-title span { color: #475569; font-size: 9pt; }
  h2 { font-size: 10.5pt; margin: 14px 0 6px; color: ${escapeHtml(company.brandColor)}; }
  p { margin: 6px 0; }
  .details { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; margin-top: 4px; }
  .detail { display: flex; justify-content: space-between; border-bottom: 1px solid #e2e8f0; padding: 2px 0; }
  .detail-label { color: #475569; }
  .detail-value { font-weight: 600; text-align: right; }
  table.money { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.money th { text-align: left; font-size: 8.5pt; color: #475569; border-bottom: 1px solid #cbd5e1; padding: 4px 6px; }
  table.money td { padding: 2.5px 6px; border-bottom: 1px solid #f1f5f9; }
  .amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.section td { padding-top: 7px; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #64748b; }
  tr.emphasis td { font-weight: 700; background: #f8fafc; }
  .note { color: #64748b; font-size: 8pt; }
  ul.terms { margin: 6px 0; padding-left: 18px; }
  .closing { break-inside: avoid; }
  .signature { margin-top: 22px; display: flex; justify-content: space-between; gap: 24px; }
  .signature div { flex: 1; border-top: 1px solid #94a3b8; padding-top: 6px; font-size: 9pt; }
  .watermark { position: fixed; top: 42%; left: 0; right: 0; text-align: center; transform: rotate(-30deg); font-size: 46pt; font-weight: 800; color: rgba(220, 38, 38, 0.13); letter-spacing: 0.06em; z-index: 10; }
</style>
</head>
<body>
${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ''}
<div class="header">
  ${brandMarkSvg(company.brandColor)}
  <div class="company">
    <div class="company-name">${escapeHtml(companyName)}</div>
    ${company.registeredAddress ? `<div class="company-address">${escapeHtml(company.registeredAddress)}</div>` : ''}
  </div>
  <div class="doc-title"><strong>OFFER LETTER</strong><span>${escapeHtml(formatDate(issuedOn))}</span></div>
</div>

<p>Dear ${escapeHtml(firstName)},</p>
<p>We are pleased to offer you the position of <strong>${escapeHtml(position.designation)}</strong> at
${escapeHtml(companyName)}, on the terms below. We look forward to welcoming you on
<strong>${escapeHtml(formatDate(position.dateOfJoining))}</strong>.</p>

<h2>Position</h2>
<div class="details">
  ${detail('Name', candidate.name)}
  ${detail('Designation', position.designation)}
  ${detail('Department', position.departmentName)}
  ${detail('Reporting to', position.managerName ?? '—')}
  ${detail('Date of joining', formatDate(position.dateOfJoining))}
  ${detail('Work location', position.workLocationType)}
  ${detail('Employment status', position.employmentStatus)}
  ${detail('Annual CTC', formatMoney(structure.annualCtc))}
</div>

<h2>Compensation</h2>
${compensationTable(structure)}
<p class="note">Deductions and take-home are estimates under the ${escapeHtml(structure.taxYear)} income-tax rules and
the statutory rates in force on the joining date; actual figures depend on your declarations. Monthly figures are
rounded down to the rupee; the annual amounts are what you receive over the year.</p>

<div class="closing">
<h2>Terms</h2>
<ul class="terms">
  <li>Probation: ${escapeHtml(String(terms.probationMonths))} months from your date of joining.</li>
  <li>Notice period: ${escapeHtml(String(terms.noticePeriodDays))} days, on either side.</li>
  <li>Working hours: ${escapeHtml(String(terms.weeklyWorkingHours))} hours a week.</li>
  ${clauses}
</ul>
<p>This offer is open until <strong>${escapeHtml(formatDate(validUntil))}</strong>. Please confirm your acceptance by
activating your account from the link in the email that came with this letter.</p>

<div class="signature">
  <div>${escapeHtml(terms.signatoryName ?? '')}<br>${escapeHtml(terms.signatoryTitle ?? '')}<br>${escapeHtml(companyName)}</div>
  <div>Accepted by ${escapeHtml(candidate.name)}<br>Date:</div>
</div>
</div>
</body>
</html>`;
}
