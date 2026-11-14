/**
 * The offboarding PDFs as self-contained, print-ready A4 HTML (rendered by
 * services/pdfGenerationService.js), laid out like the offer letter: the company letterhead with its
 * brand mark, inline styles, system fonts, and a Content-Security-Policy that forbids every external
 * resource and script. Every value inserted is escaped.
 *
 *   compileRelievingLetterHtml     the relieving and experience letter, dated the last working day:
 *                                  the person's role and tenure, how the employment ended, and the
 *                                  authorised signatory's block
 *   compileSettlementStatementHtml the full and final settlement statement: the person and their
 *                                  service, the 2-working-day settlement banner, earnings, deductions,
 *                                  the net payable (or recoverable), how each figure was worked out,
 *                                  and signatures for HR, the signatory and the employee
 */

import { escapeHtml } from '../../../utils/html.js';
import { SEPARATION_KINDS } from '../../../models/OffboardingCase.js';
import { TDS_SOURCES } from '../../../utils/payroll/finalSettlement.js';
import { cssString, detail, formatDate, formatMoney, plural } from '../../documentParts.js';
import { brandMarkSvg } from '../../payslipHtmlTemplate.js';

const SEPARATION_LABELS = Object.freeze({
  [SEPARATION_KINDS.RESIGNATION]: 'Resignation',
  [SEPARATION_KINDS.TERMINATION]: 'Separation by the company',
  [SEPARATION_KINDS.CONTRACT_END]: 'End of contract',
  [SEPARATION_KINDS.RETIREMENT]: 'Retirement',
});

/** How the letter says the employment ended. */
function separationSentence(separation) {
  const noticeDate = formatDate(separation.noticeDate);
  switch (separation.kind) {
    case SEPARATION_KINDS.RESIGNATION:
      return `following the resignation submitted on ${noticeDate}, which the company accepted`;
    case SEPARATION_KINDS.CONTRACT_END:
      return 'on completion of the contract term';
    case SEPARATION_KINDS.RETIREMENT:
      return 'on retirement';
    default:
      return `following the separation notified on ${noticeDate}`;
  }
}

function serviceText(service) {
  const parts = [plural(service.years, 'year'), plural(service.months, 'month')];
  if (service.days > 0) parts.push(plural(service.days, 'day'));
  return parts.join(', ');
}

const companyNameOf = (company) => company.legalName ?? company.name;

function styles(brand, footerLeft) {
  return `<style>
  @page {
    size: A4;
    margin: 16mm 18mm 20mm;
    @bottom-left { content: ${cssString(footerLeft)}; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 7.5pt; color: #64748b; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 7.5pt; color: #64748b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 10pt; color: #0f172a; line-height: 1.5; }
  .letterhead { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid ${brand}; padding-bottom: 10px; }
  .brand-mark { width: 40px; height: 40px; flex: none; }
  .company { flex: 1; }
  .company-name { font-size: 14pt; font-weight: 700; }
  .company-address { color: #475569; font-size: 8.5pt; }
  .doc-title { text-align: right; }
  .doc-title strong { display: block; font-size: 11.5pt; letter-spacing: 0.08em; color: ${brand}; }
  .doc-title span { color: #475569; font-size: 9pt; }
  h2 { font-size: 10.5pt; margin: 16px 0 6px; color: ${brand}; break-after: avoid; }
  p { margin: 8px 0; }
  .meta { display: flex; justify-content: space-between; margin-top: 14px; color: #475569; font-size: 9pt; }
  .subject { margin-top: 14px; font-weight: 700; text-align: center; letter-spacing: 0.06em; }
  .details { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; margin-top: 4px; }
  .detail { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #e2e8f0; padding: 3px 0; font-size: 9pt; }
  .detail-label { color: #475569; }
  .detail-value { font-weight: 600; text-align: right; }
  table.money { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 9.5pt; }
  table.money th { text-align: left; font-size: 8.5pt; color: #475569; border-bottom: 1px solid #cbd5e1; padding: 4px 6px; }
  table.money th.amount { text-align: right; }
  table.money td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; }
  table.money tr { break-inside: avoid; }
  .amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.emphasis td { font-weight: 700; background: #f8fafc; }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .net { margin-top: 14px; display: flex; justify-content: space-between; align-items: center; border: 2px solid ${brand}; border-radius: 6px; padding: 10px 14px; }
  .net span { color: #475569; }
  .net strong { font-size: 14pt; font-variant-numeric: tabular-nums; }
  .callout { margin-top: 12px; border-left: 3px solid ${brand}; background: #f8fafc; padding: 8px 12px; font-size: 9pt; }
  ul.notes { margin: 6px 0; padding-left: 18px; font-size: 8.5pt; color: #475569; }
  ul.notes li { margin: 3px 0; }
  .signatures { margin-top: 40px; display: grid; gap: 30px; break-inside: avoid; }
  .signatures.two { grid-template-columns: 1fr 1fr; }
  .signatures.three { grid-template-columns: 1fr 1fr 1fr; }
  .signatures > div { font-size: 9pt; }
  .sign-here { height: 46px; border-bottom: 1px solid #94a3b8; margin-bottom: 6px; }
  .label { color: #475569; font-size: 8pt; }
</style>`;
}

function documentHead(title, brand, footerLeft) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
${styles(brand, footerLeft)}
</head>`;
}

function letterhead(company, title, dateText) {
  return `<div class="letterhead">
  ${brandMarkSvg(company.brandColor)}
  <div class="company">
    <div class="company-name">${escapeHtml(companyNameOf(company))}</div>
    ${company.registeredAddress ? `<div class="company-address">${escapeHtml(company.registeredAddress)}</div>` : ''}
  </div>
  <div class="doc-title"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(dateText)}</span></div>
</div>`;
}

function signatoryBlock(company, signatory) {
  return `<div><span class="label">For ${escapeHtml(companyNameOf(company))}</span><div class="sign-here"></div>${escapeHtml(
    signatory.name ?? '',
  )}<br><span class="label">${escapeHtml(signatory.title ?? 'Authorised signatory')}</span></div>`;
}

/**
 * @param {{ company: { name: string, legalName: string|null, registeredAddress: string|null, brandColor: string },
 *   signatory: { name: string|null, title: string|null },
 *   employee: { name: string, employeeCode: string, designation: string, departmentName: string|null, dateOfJoining: string },
 *   separation: { kind: string, noticeDate: string, lastWorkingDay: string },
 *   service: { years: number, months: number, days: number }, reference: string }} letter
 * @returns {string} complete HTML document
 */
export function compileRelievingLetterHtml({ company, signatory, employee, separation, service, reference }) {
  const companyName = companyNameOf(company);
  const brand = escapeHtml(company.brandColor);
  const lastDay = formatDate(separation.lastWorkingDay);
  const department = employee.departmentName ? ` in the ${escapeHtml(employee.departmentName)} department` : '';
  return `${documentHead(`Relieving and experience letter – ${employee.name}`, brand, `${companyName} · Relieving and experience letter for ${employee.name}`)}
<body>
${letterhead(company, 'RELIEVING AND EXPERIENCE LETTER', lastDay)}
<div class="meta"><span>Ref: ${escapeHtml(reference)}</span><span>Date: ${escapeHtml(lastDay)}</span></div>
<p style="margin-top: 16px">${escapeHtml(employee.name)}<br>Employee ID ${escapeHtml(employee.employeeCode)}</p>
<p class="subject">TO WHOM IT MAY CONCERN</p>
<p>This is to certify that <strong>${escapeHtml(employee.name)}</strong> (Employee ID ${escapeHtml(employee.employeeCode)})
was employed with ${escapeHtml(companyName)} as <strong>${escapeHtml(employee.designation)}</strong>${department} from
<strong>${escapeHtml(formatDate(employee.dateOfJoining))}</strong> to <strong>${escapeHtml(lastDay)}</strong>, a service of
${escapeHtml(serviceText(service))}.</p>
<p>${escapeHtml(employee.name)} is relieved of all duties with effect from the close of business on ${escapeHtml(lastDay)},
${escapeHtml(separationSentence(separation))}.</p>
<p>The full and final settlement is processed separately, as the company's policy and the law require.
Obligations of confidentiality and the protection of the company's intellectual property continue after the
employment ends, as agreed in the terms of employment.</p>
<p>We thank ${escapeHtml(employee.name)} for the contribution made to ${escapeHtml(companyName)} and wish every success in
the years ahead.</p>
<div class="signatures two">
  ${signatoryBlock(company, signatory)}
  <div></div>
</div>
</body>
</html>`;
}

function moneyRows(lines) {
  return lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.label)}</td><td class="amount">${escapeHtml(formatMoney(line.amount))}</td></tr>`,
    )
    .join('');
}

function computationNotes(settlement) {
  const { encashment, gratuity, notice, tax, finalMonth, salary } = settlement;
  const notes = [
    `Final month: ${finalMonth.salaryDays} of ${finalMonth.calendarDays} days at a monthly gross of ${formatMoney(salary.monthlyGross)}${
      finalMonth.alreadyPaid && !finalMonth.salaryDaysEdited ? ' (the month’s payslip was already issued)' : ''
    }.`,
    `Leave encashment: ${encashment.days} days at Basic ${formatMoney(salary.monthlyBasic)} ÷ 26 a day.`,
    gratuity.eligible
      ? `Gratuity: 15 ÷ 26 × Basic × ${plural(gratuity.completedYears, 'completed year')}${gratuity.capped ? ', limited to the statutory ceiling of ₹20,00,000' : ''}.`
      : `Gratuity: not payable before ${plural(gratuity.minimumYears, 'completed year')} of service (${plural(gratuity.completedYears, 'year')} completed).`,
    notice.waived
      ? `Notice: ${notice.periodDays} days required, ${notice.servedDays} served; the recovery of the shortfall was waived.`
      : `Notice: ${notice.periodDays} days required, ${notice.servedDays} served; ${plural(notice.shortfallDays, 'day')} recovered at gross ÷ 30 a day.`,
  ];
  if (tax.source === TDS_SOURCES.COMPUTED) {
    notes.push(
      `Income tax: ${tax.regime} regime, ${tax.financialYear}; projected tax for the year ${formatMoney(tax.projectedAnnualTax)}, less ${formatMoney(tax.paidThisYear.tdsDeducted)} already deducted. Gratuity (up to ₹20,00,000) and leave encashment (up to ₹25,00,000) are exempt.`,
    );
  } else if (tax.source === TDS_SOURCES.OVERRIDE) {
    notes.push('Income tax: as determined by HR.');
  }
  return notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
}

/**
 * @param {{ company: object, signatory: { name: string|null, title: string|null },
 *   employee: object, separation: object, settlement: object, settlementDueDate: string,
 *   complianceNote: string, issuedOn: string, reference: string }} statement
 * @returns {string} complete HTML document
 */
export function compileSettlementStatementHtml({
  company,
  signatory,
  employee,
  separation,
  settlement,
  complianceNote,
  issuedOn,
  reference,
}) {
  const companyName = companyNameOf(company);
  const brand = escapeHtml(company.brandColor);
  const { totals, notice } = settlement;
  const owesCompany = totals.net < 0;
  return `${documentHead(`Full and final settlement – ${employee.name}`, brand, `${companyName} · Full and final settlement for ${employee.name}`)}
<body>
${letterhead(company, 'FULL AND FINAL SETTLEMENT', formatDate(issuedOn))}
<div class="meta"><span>Ref: ${escapeHtml(reference)}</span><span>Prepared on ${escapeHtml(formatDate(issuedOn))}</span></div>
<h2>Employee</h2>
<div class="details">
  ${detail('Name', employee.name)}
  ${detail('Employee ID', employee.employeeCode)}
  ${detail('Designation', employee.designation)}
  ${detail('Department', employee.departmentName ?? '—')}
  ${detail('Date of joining', formatDate(employee.dateOfJoining))}
  ${detail('Separation', SEPARATION_LABELS[separation.kind] ?? separation.kind)}
  ${detail('Notice given on', formatDate(separation.noticeDate))}
  ${detail('Last working day', formatDate(separation.lastWorkingDay))}
  ${detail('Length of service', serviceText(settlement.service))}
  ${detail('Notice period', `${plural(notice.periodDays, 'day')} (${notice.servedDays} served)`)}
</div>
<div class="callout">${escapeHtml(complianceNote)}</div>
<div class="columns">
  <div>
    <h2>Earnings</h2>
    <table class="money"><thead><tr><th>Item</th><th class="amount">Amount</th></tr></thead>
    <tbody>${moneyRows(settlement.earnings)}<tr class="emphasis"><td>Total earnings</td><td class="amount">${escapeHtml(formatMoney(totals.earnings))}</td></tr></tbody></table>
  </div>
  <div>
    <h2>Deductions and recoveries</h2>
    <table class="money"><thead><tr><th>Item</th><th class="amount">Amount</th></tr></thead>
    <tbody>${moneyRows(settlement.deductions)}<tr class="emphasis"><td>Total deductions</td><td class="amount">${escapeHtml(formatMoney(totals.deductions))}</td></tr></tbody></table>
  </div>
</div>
<div class="net"><span>${owesCompany ? 'Net amount recoverable from the employee' : 'Net amount payable to the employee'}</span><strong>${escapeHtml(
    formatMoney(Math.abs(totals.net)),
  )}</strong></div>
<h2>How the figures were worked out</h2>
<ul class="notes">${computationNotes(settlement)}</ul>
<div class="signatures three">
  <div><span class="label">Prepared by (HR)</span><div class="sign-here"></div><span class="label">Name and date</span></div>
  ${signatoryBlock(company, signatory)}
  <div><span class="label">Received and accepted by the employee</span><div class="sign-here"></div>${escapeHtml(employee.name)}<br><span class="label">Date:</span></div>
</div>
</body>
</html>`;
}
