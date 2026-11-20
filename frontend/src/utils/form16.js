/**
 * Form 16 form helpers: the computation summary as the upload sends it.
 */

const AMOUNT_FIELDS = Object.freeze([
  'grossSalary',
  'totalDeductions',
  'taxableIncome',
  'totalTaxPayable',
  'tdsDeducted',
]);

/**
 * The computation summary to send from the form's text values: filled amounts as numbers (anything
 * that is not a number is sent as typed, so the backend names the field), the regime and remarks
 * when given; empty fields are left out.
 * @param {Record<string, string>} form
 */
export function summaryRequestFrom(form) {
  const summary = {};
  for (const field of AMOUNT_FIELDS) {
    const text = String(form[field] ?? '').trim();
    if (text === '') continue;
    const amount = Number(text);
    summary[field] = Number.isFinite(amount) ? amount : text;
  }
  if (form.taxRegime) summary.taxRegime = form.taxRegime;
  const remarks = String(form.caRemarks ?? '').trim();
  if (remarks) summary.caRemarks = remarks;
  return summary;
}
