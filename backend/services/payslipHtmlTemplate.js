/**
 * Payslip HTML compilation: the second stage of the payslip pipeline (services/payslipService.js).
 *
 *   PayslipFigures (payslipDataBuilder.js) + company branding + verification ID
 *        ▼
 *   one self-contained, print-ready A4 HTML document (string)
 *
 * The template only lays out and formats; every number arrives already calculated.
 *
 * Self-contained by design: styles are inline, the logo is inline SVG, fonts come from the
 * renderer's system fonts, and a Content-Security-Policy meta tag forbids every external
 * resource and every script. The PDF renderer additionally disables JavaScript and blocks network
 * requests (pdfGenerationService.js), so the document renders the same everywhere and nothing in it
 * can make the server fetch a URL.
 *
 * Escaping: every value inserted into the markup goes through escapeHtml, including values that look
 * harmless (names, designations, company address), because they come from user-editable records.
 *
 * Layout (A4 portrait, 14 mm margins)
 *   ┌───────────────────────────────────────────────┐
 *   │ logo  Company legal name           PAYSLIP    │  brand header (accent colour bar)
 *   │       Registered address        October 2026  │
 *   ├───────────────────────────────────────────────┤
 *   │ Employee name / ID / designation / department │  employee details grid
 *   │ Office / date of joining / days / regime      │
 *   ├──────────────────────┬────────────────────────┤
 *   │ Earnings      amount │ Deductions      amount │  two-column statement; each deduction shows
 *   │ ...                  │ ... (rule applied)     │  the statutory rule applied
 *   │ Gross earnings       │ Total deductions       │
 *   ├──────────────────────┴────────────────────────┤
 *   │ NET PAY  ₹ 1,07,016.67   Rupees ... Only      │  net pay band
 *   ├───────────────────────────────────────────────┤
 *   │ Tax summary (regime, taxable income, tax)     │
 *   │ Verification ID · issued at · verify URL      │  footer
 *   └───────────────────────────────────────────────┘
 */

const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

const currencyFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatMoney = (amount) => currencyFormatter.format(amount);

const issueTimeFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const joiningDateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });

/** Inline brand mark (chat-bubble logo), tinted with the company accent colour. */
function brandMarkSvg(brandColor) {
  return `<svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="${escapeHtml(brandColor)}"/><path d="M14 33V19a5 5 0 0 1 5-5h10a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5h-8.5L14 37z" fill="#ffffff"/></svg>`;
}

function statementRows(lineItems, { withReference }) {
  return lineItems
    .map(
      (lineItem) => `<tr><td><span class="line-label">${escapeHtml(lineItem.label)}</span>${
        withReference && lineItem.reference ? `<span class="line-reference">${escapeHtml(lineItem.reference)}</span>` : ''
      }</td><td class="amount">${escapeHtml(formatMoney(lineItem.amount))}</td></tr>`,
    )
    .join('');
}

function detail(label, value) {
  return `<div class="detail"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value)}</span></div>`;
}

/**
 * @param {object} documentModel
 * @param {object} documentModel.figures         PayslipFigures
 * @param {{ legalName: string, registeredAddress: string, brandColor: string }} documentModel.company
 * @param {{ verificationId: string, verificationUrl: string|null }} documentModel.verification
 * @param {Date} documentModel.issuedAt
 * @param {number} documentModel.revision
 * @returns {string} complete HTML document
 */
export function compilePayslipHtml({ figures, company, verification, issuedAt, revision }) {
  const brandColor = company.brandColor;
  const { employee, period, taxSummary } = figures;
  const joiningDate = joiningDateFormatter.format(new Date(`${employee.dateOfJoining}T00:00:00Z`));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Payslip ${escapeHtml(period.label)} – ${escapeHtml(employee.name)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 10pt; color: #0f172a; line-height: 1.4; }
  .accent-bar { height: 6px; background: ${escapeHtml(brandColor)}; border-radius: 3px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 0 12px; border-bottom: 1px solid #e2e8f0; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .brand-mark { width: 40px; height: 40px; flex: none; }
  .company-name { font-size: 15pt; font-weight: 700; letter-spacing: -0.01em; }
  .company-address { color: #64748b; font-size: 8.5pt; max-width: 360px; }
  .document-title { text-align: right; }
  .document-title .kind { font-size: 8pt; letter-spacing: 0.18em; color: ${escapeHtml(brandColor)}; font-weight: 700; }
  .document-title .period { font-size: 13pt; font-weight: 700; }
  .document-title .revision { color: #64748b; font-size: 8pt; }
  .details { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 16px; margin: 14px 0; padding: 12px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
  .detail-label { display: block; color: #64748b; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.06em; }
  .detail-value { font-weight: 600; word-break: break-word; }
  .statement { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #ffffff; background: ${escapeHtml(brandColor)}; padding: 7px 10px; }
  th.amount { text-align: right; }
  td { padding: 7px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  td.amount { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .line-label { display: block; }
  .line-reference { display: block; color: #64748b; font-size: 7.5pt; }
  tr.total td { font-weight: 700; background: #f1f5f9; border-bottom: none; }
  .net-pay { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; padding: 14px 16px; border-radius: 8px; background: #0f172a; color: #ffffff; }
  .net-pay .label { font-size: 8pt; letter-spacing: 0.14em; text-transform: uppercase; color: #cbd5e1; }
  .net-pay .value { font-size: 18pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .net-pay .words { max-width: 55%; text-align: right; font-size: 8.5pt; color: #e2e8f0; }
  .tax-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 16px; padding: 10px 14px; border: 1px dashed #cbd5e1; border-radius: 8px; }
  footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; gap: 16px; font-size: 8pt; color: #475569; }
  .verification-id { font-family: "Consolas", "Courier New", monospace; font-size: 9.5pt; font-weight: 700; color: #0f172a; letter-spacing: 0.04em; }
  .disclaimer { color: #94a3b8; font-size: 7.5pt; margin-top: 10px; }
</style>
</head>
<body>
  <div class="accent-bar"></div>
  <header>
    <div class="brand">
      ${brandMarkSvg(brandColor)}
      <div>
        <div class="company-name">${escapeHtml(company.legalName)}</div>
        <div class="company-address">${escapeHtml(company.registeredAddress)}</div>
      </div>
    </div>
    <div class="document-title">
      <div class="kind">PAYSLIP</div>
      <div class="period">${escapeHtml(period.label)}</div>
      <div class="revision">FY ${escapeHtml(figures.financialYear)}${revision > 1 ? ` · Revised (revision ${escapeHtml(revision)})` : ''}</div>
    </div>
  </header>

  <section class="details" aria-label="Employee details">
    ${detail('Employee name', employee.name)}
    ${detail('Employee ID', employee.employeeId)}
    ${detail('Designation', employee.designation)}
    ${detail('Department', employee.departmentName ?? '—')}
    ${detail('Office', employee.officeName ?? '—')}
    ${detail('Date of joining', joiningDate)}
    ${detail('Days in month', period.daysInMonth)}
    ${detail('Tax regime', taxSummary.regime === 'new' ? 'New regime' : 'Old regime')}
  </section>

  <section class="statement" aria-label="Earnings and deductions">
    <table>
      <thead><tr><th>Earnings</th><th class="amount">Amount</th></tr></thead>
      <tbody>
        ${statementRows(figures.earnings, { withReference: false })}
        <tr class="total"><td>Gross earnings</td><td class="amount">${escapeHtml(formatMoney(figures.grossEarnings))}</td></tr>
      </tbody>
    </table>
    <table>
      <thead><tr><th>Deductions</th><th class="amount">Amount</th></tr></thead>
      <tbody>
        ${statementRows(figures.deductions, { withReference: true })}
        <tr class="total"><td>Total deductions</td><td class="amount">${escapeHtml(formatMoney(figures.totalDeductions))}</td></tr>
      </tbody>
    </table>
  </section>

  <section class="net-pay" aria-label="Net pay">
    <div>
      <div class="label">Net pay for ${escapeHtml(period.label)}</div>
      <div class="value">${escapeHtml(formatMoney(figures.netPay))}</div>
    </div>
    <div class="words">${escapeHtml(figures.netPayInWords)}</div>
  </section>

  <section class="tax-summary" aria-label="Tax summary">
    ${detail('Regime', taxSummary.regime === 'new' ? 'New (default)' : 'Old (opted)')}
    ${detail('Projected taxable income', formatMoney(taxSummary.annualTaxableIncome))}
    ${detail('Projected annual tax', formatMoney(taxSummary.projectedAnnualTax))}
    ${detail('TDS this month', formatMoney(taxSummary.monthlyTds))}
  </section>

  <footer>
    <div>
      <div>Verification ID</div>
      <div class="verification-id">${escapeHtml(verification.verificationId)}</div>
      ${verification.verificationUrl ? `<div>Verify at ${escapeHtml(verification.verificationUrl)}</div>` : '<div>Verify with the employer’s HR department.</div>'}
    </div>
    <div style="text-align:right">
      <div>Issued ${escapeHtml(issueTimeFormatter.format(issuedAt))} IST</div>
      <div>Amounts in Indian Rupees</div>
    </div>
  </footer>
  <div class="disclaimer">This is a computer-generated payslip and does not require a signature. Income tax shown is deducted at source on a projection of annual income; the final liability is determined on filing.</div>
</body>
</html>`;
}
