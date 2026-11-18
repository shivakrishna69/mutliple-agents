/**
 * The offer letter as one self-contained, print-ready A4 HTML document in the formal Indian
 * offer-cum-appointment format: a letterhead with the company's logo, a ruled header on every
 * section, the company's legal details in the footer of every page, the offer on page one and three
 * annexures. Inline styles, the logo embedded as a data address (or the inline brand mark), system
 * fonts, and a Content-Security-Policy that forbids every external resource and script. Every value
 * inserted into the markup is escaped: names, designations and clauses come from user-editable records.
 *
 * Four sections, each starting on a new page (a long section continues on the next):
 *
 *   Offer letter   letterhead, reference number and date, the addressee, the offer (designation,
 *                  department, CTC in figures and in words, work location, date of joining, how to
 *                  accept and by when), and the signature block: the authorised signatory on the
 *                  left, the candidate on the right
 *   Annexure A     details of compensation: the salary structure of services/ctcStructure.js in a
 *                  ruled monthly and annual table grouped into earnings, employer
 *                  contributions, cost to company and estimated deductions, with the net take-home
 *                  and statutory notes; the stock options with their note
 *   Annexure B     standard terms and conditions: place of work, background verification,
 *                  probation and confirmation, working hours, leave, notice period and separation,
 *                  confidentiality, intellectual property, non-solicitation, further terms and
 *                  company policies
 *   Annexure C     the documents to submit on joining (numbered), and the declaration and acceptance
 *                  with both signature blocks
 *
 * Every page's footer carries the legal name, registered office, CIN, GSTIN, website and email that
 * are configured (letterheadCompany in services/offerLetterGenerator.js), and "Page n of N".
 * Tables, clauses and signature blocks are kept whole across page breaks. A preview carries a
 * diagonal watermark (ONBOARDING_MESSAGES.PREVIEW_WATERMARK) on every page.
 */

import { GENDERS } from '../constants/validation.js';
import { escapeHtml } from '../utils/html.js';
import { rupeesInWords } from '../utils/rupeesInWords.js';
import { cssString, formatDate, formatMoney, plural } from './documentParts.js';
import { brandMarkSvg } from './payslipHtmlTemplate.js';

const countFormatter = new Intl.NumberFormat('en-IN');
const FONT_STACK = '"Calibri", "Segoe UI", "Helvetica Neue", Arial, sans-serif';

const EMPLOYMENT_TYPE_LABELS = Object.freeze({ full_time: 'full-time', contractor: 'contract', intern: 'internship' });
const SALUTATIONS = Object.freeze({ [GENDERS.MALE]: 'Mr.', [GENDERS.FEMALE]: 'Ms.' });

// =================================================================================================
// Pieces
// =================================================================================================

const logoOf = (company, className) =>
  company.logoDataUri
    ? `<img class="${className}" src="${escapeHtml(company.logoDataUri)}" alt="${escapeHtml(company.legalName ?? company.name)}">`
    : brandMarkSvg(company.brandColor);

/** The ruled header at the top of every section: the logo on the right, as on the letterhead. */
const sectionHeader = (company) => `<header class="section-header">${logoOf(company, 'header-logo')}</header>`;

/** The lines of the page footer: legal name, registered office, then the registration numbers and contacts (empty lines left out). */
function footerLines(company, companyName) {
  const registration = [
    company.cin ? `CIN: ${company.cin}` : null,
    company.gstin ? `GSTIN: ${company.gstin}` : null,
    company.website,
    company.email,
  ].filter(Boolean);
  return [
    companyName,
    company.registeredAddress ? `Reg. Office: ${company.registeredAddress}` : null,
    registration.join(' · '),
  ].filter(Boolean);
}

/** The footer lines as CSS strings joined by line breaks, then the page count, for the bottom margin box. */
const footerContent = (lines) =>
  `${lines.map(cssString).join(' "\\A" ')} "\\A" "Page " counter(page) " of " counter(pages)`;

function moneyRow(label, split, { emphasis = false, monthly = true } = {}) {
  return `<tr class="${emphasis ? 'emphasis' : ''}"><td>${escapeHtml(label)}</td><td class="amount">${
    monthly ? escapeHtml(formatMoney(split.monthly)) : '—'
  }</td><td class="amount">${escapeHtml(formatMoney(split.annual))}</td></tr>`;
}

/** A group of rows with its name written vertically down the first column, as in a formal CTC annexure. */
function rowGroup(name, rows) {
  const present = rows.filter(Boolean);
  if (present.length === 0) return '';
  const [first, ...rest] = present;
  const label = `<th class="group" rowspan="${present.length}" scope="rowgroup"><span>${escapeHtml(name)}</span></th>`;
  return [first.replace('<tr class="', `<tr class="group-start `).replace('><td>', `>${label}<td>`), ...rest].join('');
}

function salaryTable(structure) {
  const { earnings, employerContributions: employer, employeeDeductions: employee, takeHome } = structure;
  const optionalRow = (label, split) => (split.annual > 0 ? moneyRow(label, split) : null);
  const hasVariable = structure.variablePay.annual > 0;
  const totalDeductions = {
    monthly:
      employee.providentFund.monthly +
      employee.esi.monthly +
      employee.professionalTax.monthly +
      employee.incomeTax.monthly,
    annual:
      employee.providentFund.annual + employee.esi.annual + employee.professionalTax.annual + employee.incomeTax.annual,
  };
  return `<table class="ctc">
    <caption>CTC – salary breakup (monthly and annual)</caption>
    <thead><tr><th class="group-head"></th><th>Breakup of the salary</th><th class="amount">Monthly amount</th><th class="amount">Annual amount</th></tr></thead>
    <tbody>
      ${rowGroup('Earnings', [
        moneyRow('Basic salary', earnings.basic),
        moneyRow('House rent allowance (HRA)', earnings.hra),
        moneyRow('Special allowance', earnings.specialAllowance),
        moneyRow('Gross salary (cash earnings)', earnings.gross, { emphasis: true }),
      ])}
      ${rowGroup('Employer', [
        moneyRow('Provident fund (employer)', employer.providentFund),
        optionalRow('ESI (employer)', employer.esi),
        optionalRow('Gratuity', employer.gratuity),
        moneyRow('Fixed cost to company', structure.fixedCtc, { emphasis: true }),
      ])}
      ${rowGroup('CTC', [
        hasVariable ? moneyRow('Performance pay (annual target)', structure.variablePay, { monthly: false }) : null,
        moneyRow(
          'Total cost to company (CTC)',
          { monthly: 0, annual: structure.annualCtc },
          { emphasis: true, monthly: false },
        ),
      ])}
      ${rowGroup('Deductions', [
        moneyRow('Provident fund (employee)', employee.providentFund),
        optionalRow('ESI (employee)', employee.esi),
        optionalRow('Professional tax', employee.professionalTax),
        optionalRow(`Income tax (${structure.taxRegime} regime, ${structure.taxYear})`, employee.incomeTax),
        moneyRow('Total deductions', totalDeductions, { emphasis: true }),
      ])}
      <tr class="net"><td></td><td>Net salary (estimated take-home)</td><td class="amount">${escapeHtml(
        formatMoney(takeHome.monthly),
      )}</td><td class="amount">${escapeHtml(formatMoney(takeHome.annual))}</td></tr>
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
  return `<table class="grid compact"><thead><tr><th>Leave</th><th class="amount">Entitlement</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="note">Leave is credited as the leave policy sets out (monthly or at the start of the year) and may be prorated for your first year.</p>`;
}

/** One numbered term of Annexure B, kept whole on a page. */
const term = (title, body) => `<li class="term"><h3>${escapeHtml(title)}</h3>${body}</li>`;

/** The two signature blocks: the authorised signatory on the left, the candidate on the right. */
function signatureBlocks({ companyName, terms, candidateName, withDate }) {
  return `<div class="signatures">
  <div class="signatory">
    <div class="sign-line"></div>
    <strong>Authorised Signatory</strong>
    <div>Name: ${escapeHtml(terms.signatoryName ?? '')}</div>
    <div>Designation: ${escapeHtml(terms.signatoryTitle ?? '')}</div>
    <div>For ${escapeHtml(companyName)}</div>
  </div>
  <div class="candidate">
    <div class="sign-line"></div>
    <strong>Candidate Signature</strong>
    <div>Name: ${escapeHtml(candidateName)}</div>
    ${withDate ? '<div>Date:</div>' : ''}
  </div>
</div>`;
}

/** "Your total annual cost to company (CTC) will be ₹25,00,000 (Rupees Twenty-Five Lakh only)…" */
function compensationSentence(structure) {
  const ctc = `<strong>${escapeHtml(formatMoney(structure.annualCtc))} (${escapeHtml(rupeesInWords(structure.annualCtc))})</strong>`;
  const split =
    structure.variablePay.annual > 0
      ? `, of which ${escapeHtml(formatMoney(structure.fixedCtc.annual))} is fixed and ${escapeHtml(
          formatMoney(structure.variablePay.annual),
        )} is performance pay (annual target)`
      : '';
  return `Your total annual cost to company (CTC) will be ${ctc}${split}. The details of your compensation are in
<strong>Annexure A</strong>. Salary is paid monthly, and income tax is deducted at source as applicable.`;
}

// =================================================================================================
// The letter
// =================================================================================================

/**
 * @param {{ company: { name: string, legalName: string|null, registeredAddress: string|null, cin?: string|null,
 *     gstin?: string|null, website?: string|null, email?: string|null, logoDataUri?: string|null, brandColor: string },
 *   reference?: string|null,
 *   candidate: { name: string, personalEmail?: string|null, gender?: string|null },
 *   position: { designation: string, departmentName: string, managerName: string|null, dateOfJoining: Date,
 *     workLocationType: string, workCity?: string|null, employmentStatus: string, employmentType?: string },
 *   structure: object, stockOptions: { units: number, note: string|null },
 *   terms: object, leavePolicy: { name: string, annualDays: number }[],
 *   issuedOn: Date, validUntil: Date, watermark: string|null }} letter
 * @returns {string} complete HTML document
 */
export function compileOfferLetterHtml({
  company,
  reference = null,
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
  const salutation = SALUTATIONS[candidate.gender] ?? null;
  const brand = escapeHtml(company.brandColor);
  const hasStockOptions = stockOptions.units > 0;
  const joiningDate = formatDate(position.dateOfJoining);
  const employmentType = EMPLOYMENT_TYPE_LABELS[position.employmentType] ?? null;
  const clauses = terms.additionalClauses.map((clause) => `<li>${escapeHtml(clause)}</li>`).join('');
  const checklistRows = terms.joiningChecklist
    .map((item, index) => `<tr><td class="number">${index + 1}</td><td>${escapeHtml(item)}</td></tr>`)
    .join('');
  const footer = footerContent(footerLines(company, companyName));
  const backgroundVerification = terms.backgroundVerificationClause ?? null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(`Offer letter – ${candidate.name}`)}</title>
<style>
  @page {
    size: A4;
    margin: 14mm 18mm 26mm;
    @bottom-center {
      width: 100%;
      content: ${footer};
      white-space: pre;
      border-top: 1.5pt solid ${brand};
      padding-top: 5pt;
      font-family: ${FONT_STACK};
      font-size: 7.5pt;
      line-height: 1.35;
      color: #1e293b;
      text-align: center;
      vertical-align: top;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ${FONT_STACK}; font-size: 10pt; color: #111827; line-height: 1.5; }
  section.page { break-before: page; }
  section.page:first-of-type { break-before: auto; }
  .section-header { display: flex; justify-content: flex-end; align-items: flex-end; border-bottom: 2.5pt solid ${brand}; padding-bottom: 6pt; margin-bottom: 12pt; min-height: 36pt; }
  .header-logo { max-height: 34pt; max-width: 150pt; object-fit: contain; }
  .section-header .brand-mark { width: 30pt; height: 30pt; }
  .letterhead { display: flex; justify-content: space-between; align-items: flex-end; gap: 16pt; border-bottom: 2.5pt solid ${brand}; padding-bottom: 8pt; }
  .letterhead .company-name { font-size: 13pt; font-weight: 700; color: #0f172a; }
  .letterhead .company-address { font-size: 8.5pt; color: #475569; max-width: 280pt; }
  .letterhead-logo { max-height: 46pt; max-width: 190pt; object-fit: contain; }
  .letterhead .brand-mark { width: 40pt; height: 40pt; }
  .reference { display: flex; justify-content: space-between; margin: 10pt 0 14pt; font-size: 9.5pt; }
  .reference strong { font-weight: 700; }
  .addressee { margin-bottom: 12pt; }
  .addressee .name { font-weight: 700; }
  p { margin: 0 0 9pt; text-align: justify; }
  .annexure-title { text-align: center; margin: 0 0 2pt; font-size: 11pt; font-weight: 700; text-decoration: underline; }
  .annexure-subtitle { text-align: center; margin: 0 0 12pt; font-size: 10.5pt; font-weight: 700; text-decoration: underline; }
  .particulars { margin: 0 0 10pt; border-collapse: collapse; }
  .particulars th { text-align: left; padding: 1pt 14pt 1pt 0; font-weight: 700; }
  .particulars td { padding: 1pt 0; }
  table.ctc, table.grid { width: 100%; border-collapse: collapse; break-inside: avoid; }
  table.ctc caption { caption-side: top; border: 0.8pt solid #111827; border-bottom: 0; padding: 4pt; font-weight: 700; text-transform: uppercase; font-size: 9.5pt; }
  table.ctc th, table.ctc td, table.grid th, table.grid td { border: 0.8pt solid #111827; padding: 3pt 6pt; vertical-align: middle; }
  table.ctc tbody td { border-top: 0; border-bottom: 0; }
  table.ctc tr.group-start td, table.ctc tr.net td { border-top: 0.8pt solid #111827; }
  table.ctc tbody tr:last-child td { border-bottom: 0.8pt solid #111827; }
  table.ctc thead th, table.grid thead th { font-weight: 700; text-align: center; background: #f8fafc; }
  table.ctc th.group { width: 22pt; padding: 2pt; background: #ffffff; }
  table.ctc th.group span { display: block; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-size: 8pt; font-weight: 700; margin: 0 auto; }
  table.ctc th.group-head { width: 22pt; }
  table.ctc tr { break-inside: avoid; }
  tr.emphasis td, tr.net td { font-weight: 700; }
  tr.net td { background: #f8fafc; }
  .amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.grid td.number { width: 44pt; text-align: center; }
  table.compact { width: 70%; }
  .note { color: #475569; font-size: 8.5pt; text-align: left; }
  ol.terms { margin: 0; padding-left: 0; list-style: none; counter-reset: term; }
  li.term { counter-increment: term; break-inside: avoid; margin-bottom: 9pt; }
  li.term h3 { margin: 0 0 3pt; font-size: 10pt; font-weight: 700; break-after: avoid; }
  li.term h3::before { content: counter(term) ". "; }
  li.term p { padding-left: 14pt; }
  ul.further { margin: 0 0 6pt; padding-left: 30pt; }
  ul.further li { margin: 2pt 0; text-align: justify; }
  .stock { margin-top: 12pt; break-inside: avoid; }
  .declaration { break-inside: avoid; margin-top: 16pt; }
  .declaration h3 { text-align: center; text-decoration: underline; font-size: 10.5pt; margin: 0 0 8pt; }
  .signatures { display: flex; justify-content: space-between; gap: 40pt; margin-top: 30pt; break-inside: avoid; }
  .signatures > div { width: 45%; font-size: 9.5pt; line-height: 1.45; }
  .sign-line { height: 40pt; border-bottom: 0.8pt solid #111827; margin-bottom: 4pt; }
  .callout { border-left: 3pt solid ${brand}; background: #f8fafc; padding: 6pt 10pt; margin: 4pt 0 10pt; }
  .callout p { margin: 0; }
  .watermark { position: fixed; top: 42%; left: 0; right: 0; text-align: center; transform: rotate(-30deg); font-size: 46pt; font-weight: 800; color: rgba(220, 38, 38, 0.13); letter-spacing: 0.06em; z-index: 10; }
</style>
</head>
<body>
${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ''}

<section class="page" aria-label="Offer letter">
<header class="letterhead">
  <div>
    <div class="company-name">${escapeHtml(companyName)}</div>
    ${company.registeredAddress ? `<div class="company-address">${escapeHtml(company.registeredAddress)}</div>` : ''}
  </div>
  ${logoOf(company, 'letterhead-logo')}
</header>

<div class="reference">
  <span>${reference ? `Ref. No.: <strong>${escapeHtml(reference)}</strong>` : ''}</span>
  <strong>${escapeHtml(formatDate(issuedOn))}</strong>
</div>

<div class="addressee">
  <div class="name">${escapeHtml(salutation ? `${salutation} ${candidate.name}` : candidate.name)}</div>
  ${candidate.personalEmail ? `<div>Personal email: ${escapeHtml(candidate.personalEmail)}</div>` : ''}
</div>

<p>Dear <strong>${escapeHtml(firstName)}</strong>,</p>
<p>Further to our discussions, we are pleased to offer you employment with <strong>${escapeHtml(companyName)}</strong>.
Please accept our warm congratulations, and welcome to <strong>${escapeHtml(company.name)}</strong>!</p>
<p>Your designation will be <strong>“${escapeHtml(position.designation)}”</strong> in the
${escapeHtml(position.departmentName)} department${
    position.managerName ? `, reporting to ${escapeHtml(position.managerName)}` : ''
  }${employmentType ? `, on a ${escapeHtml(employmentType)} basis` : ''}. ${compensationSentence(structure)}${
    hasStockOptions
      ? ` You will also be granted <strong>${escapeHtml(countFormatter.format(stockOptions.units))} stock options</strong>, as set out in Annexure A.`
      : ''
  }</p>
<p>The details of this offer are confidential: please do not discuss or share them with anyone outside the company.</p>
<p>You will be based at <strong>${escapeHtml(position.workCity ?? position.workLocationType)}</strong>${
    position.workCity ? ` (${escapeHtml(position.workLocationType)})` : ''
  }, or at any other location the company assigns from time to time.</p>
<p>Your date of joining will be <strong>${escapeHtml(joiningDate)}</strong>, and your employment status on joining will
be <strong>${escapeHtml(position.employmentStatus)}</strong>. Please report to the Human Resources team on that day.</p>
<p>Your employment will be governed by the terms and conditions in <strong>Annexure B</strong> and by the company’s
policies as they apply from time to time. Please submit the documents listed in <strong>Annexure C</strong> when you join.</p>
<div class="callout"><p>This offer is open until <strong>${escapeHtml(formatDate(validUntil))}</strong>. You accept it by
activating your account from the link in the email that came with this letter, and by signing Annexure C.</p></div>
<p>We are confident that you will make a valuable contribution to ${escapeHtml(company.name)}, and we look forward to
welcoming you on board.</p>
${signatureBlocks({ companyName, terms, candidateName: candidate.name, withDate: false })}
</section>

<section class="page" aria-label="Annexure A">
${sectionHeader(company)}
<h2 class="annexure-title">Annexure A</h2>
<p class="annexure-subtitle">Details of Compensation</p>
<table class="particulars">
  <tr><th>Name:</th><td>${escapeHtml(candidate.name)}</td></tr>
  <tr><th>Designation:</th><td>${escapeHtml(position.designation)}</td></tr>
  <tr><th>Date of joining:</th><td>${escapeHtml(joiningDate)}</td></tr>
</table>
${salaryTable(structure)}
<p class="note" style="margin-top: 8pt">Deductions and take-home are estimates under the ${escapeHtml(structure.taxYear)}
income-tax rules and the statutory rates in force on the date of joining; actual figures depend on your tax declarations.
Monthly figures are rounded down to the rupee; the annual amounts are what is paid over the year.${
    structure.variablePay.annual > 0
      ? ' Performance pay is a target: what is paid depends on the company’s performance pay policy, and it is taxed when paid, so it is not in the take-home above.'
      : ''
  }</p>
${
  hasStockOptions
    ? `<div class="stock"><table class="particulars"><tr><th>Stock options granted:</th><td>${escapeHtml(
        `${countFormatter.format(stockOptions.units)} units`,
      )}</td></tr></table>${stockOptions.note ? `<p class="note">${escapeHtml(stockOptions.note)}</p>` : ''}</div>`
    : ''
}
</section>

<section class="page" aria-label="Annexure B">
${sectionHeader(company)}
<h2 class="annexure-title">Annexure B</h2>
<p class="annexure-subtitle">Standard Terms and Conditions</p>
<ol class="terms">
  ${term(
    'Place of work',
    `<p>You will be based at ${escapeHtml(position.workCity ?? position.workLocationType)}. During your employment the
company may post or transfer you to any of its offices, departments or client locations, in India or abroad, on the
same terms.</p>`,
  )}
  ${backgroundVerification ? term('Background verification', `<p>${escapeHtml(backgroundVerification)}</p>`) : ''}
  ${term(
    'Probation and confirmation',
    `<p>${
      terms.probationMonths > 0
        ? `You will be on probation for ${escapeHtml(plural(terms.probationMonths, 'month'))} from your date of joining. On confirmation, your employment continues on these terms.`
        : 'Your employment is confirmed from your date of joining, without a probation period.'
    }</p>`,
  )}
  ${term(
    'Working hours',
    `<p>${escapeHtml(plural(terms.weeklyWorkingHours, 'hour'))} a week${
      terms.shiftTimings ? `: ${escapeHtml(terms.shiftTimings)}` : ''
    }. The company may change or stagger working hours as the business requires. Attendance is recorded in the
company’s HR portal.</p>`,
  )}
  ${term('Leave', leaveTable(leavePolicy))}
  ${term(
    'Notice period and separation',
    `<p>${
      terms.noticePeriodDays > 0
        ? `Either you or the company may end your employment by giving ${escapeHtml(plural(terms.noticePeriodDays, 'day'))}’ written notice, or pay in place of notice.`
        : 'No notice period applies.'
    } On separation you will hand over all company property and complete the handover your manager asks for.</p>`,
  )}
  ${term('Confidentiality', `<p>${escapeHtml(terms.confidentialityClause)}</p>`)}
  ${term('Intellectual property', `<p>${escapeHtml(terms.ipAssignmentClause)}</p>`)}
  ${term(
    'Non-solicitation',
    `<p>${escapeHtml(terms.nonSolicitationClause)} ${
      terms.nonSolicitationMonths > 0
        ? `This applies for ${escapeHtml(plural(terms.nonSolicitationMonths, 'month'))} after your employment ends.`
        : 'This applies while you are employed.'
    }</p>`,
  )}
  ${clauses ? term('Further terms', `<ul class="further">${clauses}</ul>`) : ''}
  ${term(
    'Company policies',
    '<p>You will follow the company’s policies and practices as they apply from time to time. This letter is governed by the laws of India.</p>',
  )}
</ol>
</section>

<section class="page" aria-label="Annexure C">
${sectionHeader(company)}
<h2 class="annexure-title">Annexure C</h2>
<p class="annexure-subtitle">Documents to Submit on Joining</p>
<p>Please submit copies of the following documents on your date of joining (${escapeHtml(joiningDate)}):</p>
<table class="grid"><thead><tr><th>S. No.</th><th>Document</th></tr></thead><tbody>${checklistRows}</tbody></table>

<div class="declaration">
<h3>Declaration and Acceptance</h3>
<p>I have carefully read and understood this offer, including its annexures and terms and conditions, and I accept it.
I agree to be bound by the company’s rules and policies as they apply from time to time, and I will join as
${escapeHtml(position.designation)} on ${escapeHtml(joiningDate)}.</p>
${signatureBlocks({ companyName, terms, candidateName: candidate.name, withDate: true })}
</div>
</section>
</body>
</html>`;
}
