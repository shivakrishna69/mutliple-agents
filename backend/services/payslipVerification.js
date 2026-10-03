/**
 * Digital verification for payslips.
 *
 *   contentHmac     HMAC-SHA256 (key PAYSLIP_SIGNING_SECRET) over a canonical serialisation of the
 *                   payslip's identity and figures: payslip id, employee id, period, revision, every
 *                   line item, the totals and the issue time.
 *   verificationId  "PS-YYYYMM-XXXX-XXXX-XXXX-XXXX": the period plus the first 64 bits of the HMAC in
 *                   hex. Printed on the PDF and used as the public lookup key. Including the payslip
 *                   id in the HMAC input makes every ID unique, and without the secret nobody can
 *                   produce an ID that matches a given payslip's figures.
 *
 * Verification (payslipService.verifyPayslip) finds the record by its ID and recomputes the HMAC
 * from the stored figures. A match proves the record is the one issued; a mismatch means the
 * database row was altered after issue and is reported as invalid, never vouched for. The PDF's
 * SHA-256 (stored with the record) then lets a third party confirm the file they hold is unchanged.
 *
 * Canonical serialisation: a fixed field order and fixed-precision amounts (two decimals), so the
 * same payslip always produces the same bytes regardless of how it was loaded.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

function canonicalAmount(amount) {
  return Number(amount).toFixed(2);
}

function canonicalLines(lineItems) {
  return lineItems.map((lineItem) => [lineItem.code, canonicalAmount(lineItem.amount)]);
}

/** The exact bytes the HMAC covers. */
function canonicalPayslipContent(payslipFields) {
  return JSON.stringify([
    'payslip-v1',
    payslipFields.payslipId,
    payslipFields.employeeId,
    payslipFields.period.year,
    payslipFields.period.month,
    payslipFields.revision,
    canonicalLines(payslipFields.earnings),
    canonicalLines(payslipFields.deductions),
    canonicalAmount(payslipFields.grossEarnings),
    canonicalAmount(payslipFields.totalDeductions),
    canonicalAmount(payslipFields.netPay),
    new Date(payslipFields.issuedAt).toISOString(),
  ]);
}

/** @returns {string} 64 lowercase hex characters */
export function computePayslipContentHmac(payslipFields, signingSecret) {
  return createHmac('sha256', signingSecret).update(canonicalPayslipContent(payslipFields), 'utf8').digest('hex');
}

/** "PS-202610-1A2B-3C4D-5E6F-7A8B" */
export function buildVerificationId(contentHmac, period) {
  const groups = contentHmac.slice(0, 16).toUpperCase().match(/.{4}/g);
  return `PS-${period.year}${String(period.month).padStart(2, '0')}-${groups.join('-')}`;
}

/** Constant-time comparison of a stored HMAC with one recomputed from the stored figures. */
export function isPayslipContentAuthentic(payslipFields, storedHmac, signingSecret) {
  const recomputedHmac = Buffer.from(computePayslipContentHmac(payslipFields, signingSecret), 'hex');
  const storedHmacBytes = Buffer.from(storedHmac, 'hex');
  return storedHmacBytes.length === recomputedHmac.length && timingSafeEqual(storedHmacBytes, recomputedHmac);
}
