/**
 * Form16Record model: one Form 16 PDF a chartered accountant uploaded for one employee and financial
 * year (services/tax/form16Service.js). The PDF lives in S3
 * (company-tax-docs/form16/<financialYear>/<employeeId>/<recordId>.pdf); this document records which
 * file it is, the CA's computation summary, and its version.
 *
 * Relationship vectors
 * --------------------
 *   Form16Record.employeeId     ──► EmployeeProfile._id  (whose Form 16; immutable)
 *   Form16Record.uploadedBy     ──► User._id             (the CA or administrator who uploaded it)
 *   Form16Record.supersededBy   ──► Form16Record._id     (the upload that replaced this one)
 *
 * Versions
 * --------
 *   One ACTIVE record per (employee, financial year, part) (partial unique index). Uploading again
 *   marks the active one SUPERSEDED and creates version n+1 in the same transaction; nothing is
 *   deleted, so every file an employee was given stays traceable.
 *
 * Parts: CONSOLIDATED (Part A and Part B in one file), or PART_A (TDS certificate from TRACES) and
 * PART_B (salary and tax computation) as separate files.
 *
 * All fields but the status ones are immutable once written. `s3Key` is select:false and stripped
 * from JSON: the key never leaves the server.
 */

import mongoose from 'mongoose';
import { FORM16_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const FORM16_PART_TYPES = Object.freeze({
  CONSOLIDATED: 'CONSOLIDATED',
  PART_A: 'PART_A',
  PART_B: 'PART_B',
});

export const FORM16_STATUSES = Object.freeze({ ACTIVE: 'ACTIVE', SUPERSEDED: 'SUPERSEDED' });

export const FORM16_TAX_REGIMES = Object.freeze({ OLD: 'old', NEW: 'new' });

export const FINANCIAL_YEAR_PATTERN = /^\d{4}-\d{2}$/;
export const FORM16_KEY_PATTERN = /^company-tax-docs\/form16\/\d{4}-\d{2}\/[0-9a-f]{24}\/[0-9a-f]{24}\.pdf$/;

const amountField = { type: Number, min: 0, max: FORM16_SETTINGS.AMOUNT_MAX, default: null, immutable: true };

const computationSummarySchema = new mongoose.Schema(
  {
    grossSalary: amountField,
    totalDeductions: amountField,
    taxableIncome: amountField,
    totalTaxPayable: amountField,
    tdsDeducted: amountField,
    taxRegime: {
      type: String,
      enum: [...Object.values(FORM16_TAX_REGIMES), null],
      default: null,
      immutable: true,
    },
    caRemarks: {
      type: String,
      trim: true,
      maxlength: FORM16_SETTINGS.REMARKS_MAX_LENGTH,
      default: null,
      immutable: true,
    },
  },
  { _id: false },
);

const form16RecordSchema = new mongoose.Schema(
  {
    // ──► EmployeeProfile._id
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    financialYear: { type: String, required: true, match: FINANCIAL_YEAR_PATTERN, immutable: true },
    assessmentYear: { type: String, required: true, match: FINANCIAL_YEAR_PATTERN, immutable: true },
    partType: { type: String, enum: Object.values(FORM16_PART_TYPES), required: true, immutable: true },
    computationSummary: { type: computationSummarySchema, default: () => ({}) },

    s3Key: { type: String, required: true, match: FORM16_KEY_PATTERN, select: false, immutable: true },
    fileName: { type: String, required: true, trim: true, maxlength: 200, immutable: true },
    fileSizeBytes: { type: Number, required: true, min: 1, max: FORM16_SETTINGS.MAX_FILE_BYTES, immutable: true },
    sha256Checksum: { type: String, required: true, match: /^[0-9a-f]{64}$/, immutable: true },
    serverSideEncryption: { type: String, enum: ['aws:kms', 'AES256'], required: true, immutable: true },

    status: {
      type: String,
      enum: Object.values(FORM16_STATUSES),
      default: FORM16_STATUSES.ACTIVE,
      required: true,
    },
    version: { type: Number, required: true, min: 1, immutable: true },

    // ──► User._id
    uploadedBy: { type: ObjectId, ref: 'User', required: true, immutable: true },
    uploadedAt: { type: Date, required: true, immutable: true },
    supersededAt: { type: Date, default: null },
    // ──► Form16Record._id
    supersededBy: { type: ObjectId, ref: 'Form16Record', default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.s3Key;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One active Form 16 per employee, year and part; superseded versions are kept alongside it.
form16RecordSchema.index(
  { employeeId: 1, financialYear: 1, partType: 1 },
  { unique: true, partialFilterExpression: { status: FORM16_STATUSES.ACTIVE }, name: 'one_active_form16_per_part' },
);
// An employee's history for a year, newest first, and the CA's "uploaded" counts per year.
form16RecordSchema.index({ financialYear: 1, status: 1, employeeId: 1 });
form16RecordSchema.index({ employeeId: 1, financialYear: 1, version: -1 });

export default mongoose.model('Form16Record', form16RecordSchema);
