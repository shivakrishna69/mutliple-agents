/**
 * Payslip model: the metadata of one issued payslip PDF. The PDF itself lives in S3
 * (company-payslips/YYYY/MM/<employeeId>_<payslipId>.pdf); this document records what was printed,
 * where the file is, and how to verify it.
 *
 * Relationship vectors
 * --------------------
 *   Payslip.employeeId         ──► EmployeeProfile._id  (whose payslip; immutable)
 *   Payslip.generatedByUserId  ──► User._id             (the HR user or admin who issued it)
 *   Payslip.supersededByPayslipId ──► Payslip._id       (the reissue that replaced this one)
 *
 * One payslip per employee per month
 * ----------------------------------
 *   At most one payslip per (employee, year, month) has status "Issued" (partial unique index).
 *   Reissuing (e.g. after a salary correction) creates revision n+1 and marks the previous one
 *   "Superseded"; nothing is ever deleted, so every PDF an employee received stays traceable.
 *
 * What is stored
 * --------------
 *   employeeSnapshot   the employee details exactly as printed (name, designation, department,
 *                      office, joining date), so the record still matches the PDF after a transfer
 *   earnings / deductions  the line items as printed, in rupees with paise; with grossEarnings,
 *                      totalDeductions and netPay they form the metadata array of the payslip
 *   taxSummary         the regime and projected annual figures the TDS line was derived from
 *   verification       verificationId (printed on the PDF; public lookup key) and contentHmac, an
 *                      HMAC-SHA256 over the payslip's figures with PAYSLIP_SIGNING_SECRET. A database
 *                      edit that changes the figures no longer matches the HMAC, so verification
 *                      reports it instead of vouching for altered data. contentHmac is select:false.
 *   storage            the S3 key (select:false: never sent to clients), size, SHA-256 of the PDF
 *                      bytes (lets anyone holding the file prove it is the issued one), encryption
 *
 * All figures are immutable once issued; only the status fields change (on supersession).
 */

import mongoose from 'mongoose';
import { CALENDAR_DATE_PATTERN } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const PAYSLIP_STATUSES = Object.freeze({ ISSUED: 'Issued', SUPERSEDED: 'Superseded' });

const moneyField = { type: Number, required: true, min: 0, immutable: true };

const lineItemSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, match: /^[A-Z][A-Z0-9_]{1,39}$/ },
    label: { type: String, required: true, maxlength: 80 },
    amount: { type: Number, required: true, min: 0 },
    // Deductions: the rule applied, e.g. "12% of ₹25,000 (statutory ceiling)".
    reference: { type: String, maxlength: 200, default: null },
  },
  { _id: false },
);

const payslipSchema = new mongoose.Schema(
  {
    // ──► EmployeeProfile._id
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    financialYear: { type: String, required: true, match: /^\d{4}-\d{2}$/, immutable: true },
    period: {
      year: { type: Number, required: true, min: 2000, max: 2100, immutable: true },
      month: { type: Number, required: true, min: 1, max: 12, immutable: true },
    },
    revision: { type: Number, required: true, min: 1, immutable: true },
    status: { type: String, enum: Object.values(PAYSLIP_STATUSES), default: PAYSLIP_STATUSES.ISSUED, required: true },

    employeeSnapshot: {
      name: { type: String, required: true, maxlength: 100, immutable: true },
      designation: { type: String, required: true, maxlength: 120, immutable: true },
      departmentName: { type: String, default: null, maxlength: 120, immutable: true },
      officeName: { type: String, default: null, maxlength: 120, immutable: true },
      dateOfJoining: { type: String, required: true, match: CALENDAR_DATE_PATTERN, immutable: true },
    },

    earnings: { type: [lineItemSchema], immutable: true, validate: { validator: (lineItems) => lineItems.length > 0, message: 'A payslip needs at least one earning' } },
    deductions: { type: [lineItemSchema], immutable: true },
    grossEarnings: moneyField,
    totalDeductions: moneyField,
    netPay: moneyField,
    netPayInWords: { type: String, required: true, maxlength: 300, immutable: true },

    taxSummary: {
      regime: { type: String, enum: ['old', 'new'], required: true, immutable: true },
      annualTaxableIncome: moneyField,
      projectedAnnualTax: moneyField,
      monthlyTds: moneyField,
    },

    verification: {
      verificationId: { type: String, required: true, match: /^PS-\d{6}-[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/, immutable: true },
      contentHmac: { type: String, required: true, match: /^[0-9a-f]{64}$/, select: false, immutable: true },
    },

    storage: {
      s3Key: { type: String, required: true, select: false, immutable: true, match: /^company-payslips\/\d{4}\/\d{2}\/[0-9a-f]{24}_[0-9a-f]{24}\.pdf$/ },
      sizeBytes: { type: Number, required: true, min: 1, immutable: true },
      sha256: { type: String, required: true, match: /^[0-9a-f]{64}$/, immutable: true },
      contentType: { type: String, enum: ['application/pdf'], required: true, immutable: true },
      serverSideEncryption: { type: String, enum: ['aws:kms', 'AES256'], required: true, immutable: true },
    },

    // ──► User._id
    generatedByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    issuedAt: { type: Date, required: true, immutable: true },
    supersededAt: { type: Date, default: null },
    // ──► Payslip._id
    supersededByPayslipId: { type: ObjectId, ref: 'Payslip', default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        if (ret.storage) delete ret.storage.s3Key;
        if (ret.verification) delete ret.verification.contentHmac;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One Issued payslip per employee per month; superseded revisions are kept alongside it.
payslipSchema.index(
  { employeeId: 1, 'period.year': 1, 'period.month': 1 },
  { unique: true, partialFilterExpression: { status: PAYSLIP_STATUSES.ISSUED }, name: 'one_issued_payslip_per_month' },
);
// Every revision number is used once per employee and month.
payslipSchema.index({ employeeId: 1, 'period.year': 1, 'period.month': 1, revision: 1 }, { unique: true });
// Public verification lookup.
payslipSchema.index({ 'verification.verificationId': 1 }, { unique: true });
// HR listing of a month across the company.
payslipSchema.index({ 'period.year': 1, 'period.month': 1, status: 1 });

payslipSchema.pre('validate', function enforcePayslipArithmetic() {
  const sumOf = (lineItems) => Math.round(lineItems.reduce((runningTotal, lineItem) => runningTotal + lineItem.amount, 0) * 100) / 100;
  if (Math.abs(sumOf(this.earnings) - this.grossEarnings) > 0.005) this.invalidate('grossEarnings', 'grossEarnings must equal the sum of the earnings');
  if (Math.abs(sumOf(this.deductions) - this.totalDeductions) > 0.005) this.invalidate('totalDeductions', 'totalDeductions must equal the sum of the deductions');
  if (Math.abs(this.grossEarnings - this.totalDeductions - this.netPay) > 0.005) this.invalidate('netPay', 'netPay must equal grossEarnings minus totalDeductions');
});

const Payslip = mongoose.model('Payslip', payslipSchema);

export default Payslip;
