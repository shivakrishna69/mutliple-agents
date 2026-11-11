/**
 * The offer letter as one self-contained, print-ready A4 HTML document, laid out like the payslip
 * (services/payslipHtmlTemplate.js): inline styles, the inline SVG brand mark, system fonts, and a
 * Content-Security-Policy that forbids every external resource and script. Every value inserted
 * into the markup is escaped: names, designations and clauses come from user-editable records.
 *
 * Five sections, each starting on a new page (a long section continues on the next; the footer's
 * "Page n of N" counts the pages as printed):
 *
 *   1  Letter of appointment   letterhead, the offer, the role (designation, department, manager,
 *                              joining date, work location, employment type and status), the pay at
 *                              a glance (CTC, fixed, variable, stock options), the acceptance deadline
 *   2  Annexure A              the salary structure of services/ctcStructure.js, monthly and annual:
 *                              earnings, employer contributions, fixed CTC, variable pay, total CTC,
 *                              estimated deductions (PF, ESI, professional tax, income tax) and
 *                              take-home; the stock options with their note
 *   3  Terms of employment     probation, working hours and shift timings, notice period, the leave
 *                              policy (active leave types and their yearly days), further clauses
 *   4  Confidentiality, IP assignment and non-solicitation (with its months)
 *   5  Joining checklist and acceptance: what to bring, and the signature block for both sides
 *
 * A preview carries a diagonal watermark (ONBOARDING_MESSAGES.PREVIEW_WATERMARK) on every page.
 */

import { escapeHtml } from '../utils/html.js';
import { brandMarkSvg } from './payslipHtmlTemplate.js';

const moneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const countFormatter = new Intl.NumberFormat('en-IN');
const formatMoney = (amount) => moneyFormatter.format(amount);
const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'UTC' });
const formatDate = (date) => dateFormatter.format(date);
/**
 * A CSS string for the page footer. Every character but letters, digits and spaces is written as a
 * CSS escape, so no text can end the string or the style element (HTML escaping does not apply there).
 */
const cssString = (text) =>
  `"${[...text]
    .map((character) => (/[\p{L}\p{N} ]/u.test(character) ? character : `\\${character.codePointAt(0).toString(16)} `))
    .join('')}"`;
const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;

const EMPLOYMENT_TYPE_LABELS = Object.freeze({ full_time: 'Full-time', contractor: 'Contractor', intern: 'Intern' });

function detail(label, value) {
  return `<div class="detail"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value)}</span></div>`;
}

function moneyRow(label, split, { emphasis = false, monthly = true } = {}) {
  return `<tr class="${emphasis ? 'emphasis' : ''}"><td>${escapeHtml(label)}</td><td class="amount">${
    monthly ? escapeHtml(formatMoney(split.monthly)) : '—'
  }</td><td class="amount">${escapeHtml(formatMoney(split.annual))}</td></tr>`;
}

function sectionRow(label) {
  return `<tr class="section"><td colspan="3">${escapeHtml(label)}</td></tr>`;
}

function salaryTable(structure) {
  const { earnings, employerContributions: employer, employeeDeductions: employee, takeHome } = structure;
  const optionalRow = (label, split) => (split.annual > 0 ? moneyRow(label, split) : '');
  const hasVariable = structure.variablePay.annual > 0;
  return `<table class="money">
    <thead><tr><th>Component</th><th class="amount">Monthly</th><th class="amount">Annual</th></tr></thead>
    <tbody>
      ${sectionRow('Fixed pay')}
      ${moneyRow('Basic salary', earnings.basic)}
      ${moneyRow('House rent allowance', earnings.hra)}
      ${moneyRow('Special allowance', earnings.specialAllowance)}
      ${moneyRow('Gross salary', earnings.gross, { emphasis: true })}
      ${sectionRow('Employer contributions')}
      ${moneyRow('Provident fund (employer)', employer.providentFund)}
      ${optionalRow('ESI (employer)', employer.esi)}
      ${optionalRow('Gratuity', employer.gratuity)}
      ${moneyRow('Fixed cost to company', structure.fixedCtc, { emphasis: true })}
      ${hasVariable ? sectionRow('Variable pay') : ''}
      ${hasVariable ? moneyRow('Performance pay (annual target)', structure.variablePay, { monthly: false }) : ''}
      ${moneyRow('Total cost to company (CTC)', { monthly: 0, annual: structure.annualCtc }, { emphasis: true, monthly: false })}
      ${sectionRow('Deductions (estimated)')}
      ${moneyRow('Provident fund (employee)', employee.providentFund)}
      ${optionalRow('ESI (employee)', employee.esi)}
      ${optionalRow('Professional tax', employee.professionalTax)}
      ${optionalRow(`Income tax (${structure.taxRegime} regime, ${structure.taxYear})`, employee.incomeTax)}
      ${moneyRow('Estimated take-home', takeHome, { emphasis: true })}
    </tbody>
  </table>`;
}

function leaveTable(leavePolicy) {
  if (leavePolicy.length === 0) {
    return '<p>Leave follows the company’s leave policy, which HR shares with you when you join.</p>';
  }
  const rows = leavePolicy
    .map(
      (leave) =>
        `<tr><td>${escapeHtml(leave.name)}</td><td class="amount">${escapeHtml(plural(leave.annualDays, 'day'))} a year</td></tr>`,
    )
    .join('');
  return `<table class="money compact"><thead><tr><th>Leave</th><th class="amount">Entitlement</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="note">Leave is credited as the leave policy sets out (monthly or at the start of the year) and may be prorated for your first year.</p>`;
}

const pageHeader = (company, title, subtitle) => `<div class="page-header">
  ${brandMarkSvg(company.brandColor)}
  <div class="page-title"><strong>${escapeHtml(title)}</strong>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}</div>
</div>`;

/**
 * @param {{ company: { name: string, legalName: string|null, registeredAddress: string|null, brandColor: string },
 *   candidate: { name: string },
 *   position: { designation: string, departmentName: string, managerName: string|null, dateOfJoining: Date,
 *     workLocationType: string, employmentStatus: string, employmentType?: string },
 *   structure: object, stockOptions: { units: number, note: string|null },
 *   terms: object, leavePolicy: { name: string, annualDays: number }[],
 *   issuedOn: Date, validUntil: Date, watermark: string|null }} letter
 * @returns {string} complete HTML document
 */
export function compileOfferLetterHtml({
  company,
  candidate,
  position,
  structure,
  stockOptions = { units: 0, note: null },
  terms,
  leavePolicy = [],
  issuedOn,
  validUntil,
  watermark,
}) {
  const companyName = company.legalName ?? company.name;
  const firstName = candidate.name.split(/\s+/)[0];
  const brand = escapeHtml(company.brandColor);
  const hasStockOptions = stockOptions.units > 0;
  const clauses = terms.additionalClauses.map((clause) => `<li>${escapeHtml(clause)}</li>`).join('');
  const checklist = terms.joiningChecklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const footerLeft = `${companyName} · Offer letter for ${candidate.name}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(`Offer letter – ${candidate.name}`)}</title>
<style>
  @page {
    size: A4;
    margin: 14mm 16mm 18mm;
    @bottom-left { content: ${cssString(footerLeft)}; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 7.5pt; color: #64748b; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 7.5pt; color: #64748b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 9.5pt; color: #0f172a; line-height: 1.45; }
  section.page { break-before: page; }
  section.page:first-of-type { break-before: auto; }
  .letterhead { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid ${brand}; padding-bottom: 10px; }
  .brand-mark { width: 40px; height: 40px; flex: none; }
  .company { flex: 1; }
  .company-name { font-size: 14pt; font-weight: 700; }
  .company-address { color: #475569; font-size: 8.5pt; }
  .doc-title { text-align: right; }
  .doc-title strong { display: block; font-size: 12pt; letter-spacing: 0.08em; color: ${brand}; }
  .doc-title span { color: #475569; font-size: 9pt; }
  .page-header { display: flex; align-items: center; gap: 10px; border-bottom: 2px solid ${brand}; padding-bottom: 8px; margin-bottom: 4px; }
  .page-header .brand-mark { width: 28px; height: 28px; }
  .page-title strong { display: block; font-size: 12pt; color: ${brand}; }
  .page-title span { color: #475569; font-size: 8.5pt; }
  h2 { font-size: 10.5pt; margin: 16px 0 6px; color: ${brand}; break-after: avoid; }
  p { margin: 6px 0; }
  .details { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; margin-top: 4px; }
  .detail { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #e2e8f0; padding: 3px 0; }
  .detail-label { color: #475569; }
  .detail-value { font-weight: 600; text-align: right; }
  .glance { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 8px; }
  .glance div { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; }
  .glance span { display: block; color: #475569; font-size: 8pt; }
  .glance strong { display: block; font-size: 11pt; margin-top: 2px; font-variant-numeric: tabular-nums; }
  table.money { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.money th { text-align: left; font-size: 8.5pt; color: #475569; border-bottom: 1px solid #cbd5e1; padding: 4px 6px; }
  table.money th.amount { text-align: right; }
  table.money td { padding: 3px 6px; border-bottom: 1px solid #f1f5f9; }
  table.money tr { break-inside: avoid; }
  table.compact { width: 70%; }
  .amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.section td { padding-top: 8px; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #64748b; }
  tr.emphasis td { font-weight: 700; background: #f8fafc; }
  .note { color: #64748b; font-size: 8pt; }
  .callout { margin-top: 12px; border-left: 3px solid ${brand}; background: #f8fafc; padding: 8px 12px; }
  ol.clauses, ul.terms { margin: 6px 0; padding-left: 18px; }
  ol.clauses li, ul.terms li { margin: 4px 0; }
  .clause { break-inside: avoid; }
  ul.checklist { list-style: none; margin: 6px 0; padding: 0; }
  ul.checklist li { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0; border-bottom: 1px solid #f1f5f9; }
  ul.checklist li::before { content: ""; flex: none; width: 11px; height: 11px; margin-top: 2px; border: 1.2px solid #64748b; border-radius: 2px; }
  .acceptance { break-inside: avoid; margin-top: 18px; }
  .signatures { margin-top: 34px; display: grid; grid-template-columns: 1fr 1fr; gap: 36px; }
  .signatures > div { font-size: 9pt; }
  .sign-here { height: 46px; border-bottom: 1px solid #94a3b8; margin-bottom: 6px; }
  .signatures .label { color: #475569; font-size: 8pt; }
  .watermark { position: fixed; top: 42%; left: 0; right: 0; text-align: center; transform: rotate(-30deg); font-size: 46pt; font-weight: 800; color: rgba(220, 38, 38, 0.13); letter-spacing: 0.06em; z-index: 10; }
</style>
</head>
<body>
${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ''}

<section class="page" aria-label="Letter of appointment">
<div class="letterhead">
  ${brandMarkSvg(company.brandColor)}
  <div class="company">
    <div class="company-name">${escapeHtml(companyName)}</div>
    ${company.registeredAddress ? `<div class="company-address">${escapeHtml(company.registeredAddress)}</div>` : ''}
  </div>
  <div class="doc-title"><strong>LETTER OF APPOINTMENT</strong><span>${escapeHtml(formatDate(issuedOn))}</span></div>
</div>

<p style="margin-top: 14px">Dear ${escapeHtml(firstName)},</p>
<p>We are delighted to offer you the position of <strong>${escapeHtml(position.designation)}</strong> at
${escapeHtml(companyName)}, starting on <strong>${escapeHtml(formatDate(position.dateOfJoining))}</strong>. This letter
sets out your role, your pay (Annexure A), the terms of your employment, the obligations that protect the company
and its people, and what to bring on your first day. All five pages form part of this offer.</p>

<h2>Your role</h2>
<div class="details">
  ${detail('Name', candidate.name)}
  ${detail('Designation', position.designation)}
  ${detail('Department', position.departmentName)}
  ${detail('Reporting to', position.managerName ?? '—')}
  ${detail('Date of joining', formatDate(position.dateOfJoining))}
  ${detail('Work location', position.workLocationType)}
  ${detail('Employment type', EMPLOYMENT_TYPE_LABELS[position.employmentType] ?? position.employmentType ?? '—')}
  ${detail('Employment status on joining', position.employmentStatus)}
</div>

<h2>Your pay at a glance</h2>
<div class="glance">
  <div><span>Total CTC a year</span><strong>${escapeHtml(formatMoney(structure.annualCtc))}</strong></div>
  <div><span>Fixed pay a year</span><strong>${escapeHtml(formatMoney(structure.fixedCtc.annual))}</strong></div>
  <div><span>Variable pay (target)</span><strong>${escapeHtml(structure.variablePay.annual > 0 ? formatMoney(structure.variablePay.annual) : '—')}</strong></div>
  <div><span>Stock options</span><strong>${escapeHtml(hasStockOptions ? `${countFormatter.format(stockOptions.units)} units` : '—')}</strong></div>
</div>
<p class="note">The full breakdown, with estimated deductions and take-home, is in Annexure A on the next page.</p>

<div class="callout">
  <p>This offer is open until <strong>${escapeHtml(formatDate(validUntil))}</strong>. You accept it by activating your
  account from the link in the email that came with this letter; please also sign page 5 and bring this letter on your
  first day.</p>
</div>

<p style="margin-top: 16px">We look forward to welcoming you to the team.</p>
<p>Warm regards,<br><strong>${escapeHtml(terms.signatoryName ?? '')}</strong><br>${escapeHtml(terms.signatoryTitle ?? '')}<br>${escapeHtml(companyName)}</p>
</section>

<section class="page" aria-label="Annexure A">
${pageHeader(company, 'Annexure A: Compensation', `${candidate.name} · ${position.designation}`)}
<h2>Salary structure</h2>
${salaryTable(structure)}
<p class="note">Deductions and take-home are estimates under the ${escapeHtml(structure.taxYear)} income-tax rules and the
statutory rates in force on the joining date; actual figures depend on your tax declarations. Monthly figures are
rounded down to the rupee; the annual amounts are what you receive over the year.${
    structure.variablePay.annual > 0
      ? ' Performance pay is a target: what is paid depends on the company’s performance pay policy, and it is taxed when paid, so it is not in the take-home above.'
      : ''
  }</p>
${
  hasStockOptions
    ? `<h2>Stock options</h2>
<div class="details">${detail('Options granted', `${countFormatter.format(stockOptions.units)} units`)}</div>
${stockOptions.note ? `<p class="note">${escapeHtml(stockOptions.note)}</p>` : ''}`
    : ''
}
</section>

<section class="page" aria-label="Terms of employment">
${pageHeader(company, 'Terms of employment', candidate.name)}
<h2>Probation</h2>
<p>${
    terms.probationMonths > 0
      ? `Your first ${escapeHtml(plural(terms.probationMonths, 'month'))} from your date of joining are a probation period. On confirmation, your employment continues on these terms.`
      : 'Your employment is confirmed from your date of joining, without a probation period.'
  }</p>
<h2>Working hours</h2>
<p>${escapeHtml(plural(terms.weeklyWorkingHours, 'hour'))} a week${
    terms.shiftTimings ? `: ${escapeHtml(terms.shiftTimings)}` : ''
  }. Attendance is recorded in the company’s HR portal.</p>
<h2>Notice period</h2>
<p>${
    terms.noticePeriodDays > 0
      ? `Either you or the company may end your employment with ${escapeHtml(plural(terms.noticePeriodDays, 'day'))}’ written notice, or pay in place of notice.`
      : 'No notice period applies.'
  }</p>
<h2>Leave</h2>
${leaveTable(leavePolicy)}
${
  clauses
    ? `<h2>Further terms</h2>
<ul class="terms">${clauses}</ul>`
    : ''
}
</section>

<section class="page" aria-label="Confidentiality, IP and non-solicitation">
${pageHeader(company, 'Confidentiality, intellectual property and non-solicitation', candidate.name)}
<ol class="clauses">
  <li class="clause"><h2>Confidentiality</h2><p>${escapeHtml(terms.confidentialityClause)}</p></li>
  <li class="clause"><h2>Intellectual property</h2><p>${escapeHtml(terms.ipAssignmentClause)}</p></li>
  <li class="clause"><h2>Non-solicitation</h2><p>${escapeHtml(terms.nonSolicitationClause)}</p>
  <p>${
    terms.nonSolicitationMonths > 0
      ? `This applies for ${escapeHtml(plural(terms.nonSolicitationMonths, 'month'))} after your employment ends.`
      : 'This applies while you are employed.'
  }</p></li>
</ol>
</section>

<section class="page" aria-label="Joining checklist and acceptance">
${pageHeader(company, 'Joining checklist and acceptance', candidate.name)}
<h2>Please bring on your first day (${escapeHtml(formatDate(position.dateOfJoining))})</h2>
<ul class="checklist">${checklist}</ul>

<div class="acceptance">
<h2>Acceptance</h2>
<p>I have read the five pages of this letter and accept the offer of employment as ${escapeHtml(position.designation)}
on these terms. I will join on ${escapeHtml(formatDate(position.dateOfJoining))}.</p>
<div class="signatures">
  <div><span class="label">Signature of the candidate</span><div class="sign-here"></div>${escapeHtml(candidate.name)}<br><span class="label">Date:</span></div>
  <div><span class="label">For ${escapeHtml(companyName)}</span><div class="sign-here"></div>${escapeHtml(terms.signatoryName ?? '')}<br>${escapeHtml(terms.signatoryTitle ?? '')}</div>
</div>
</div>
</section>
</body>
</html>`;
}
