/**
 * Payslip generation pipeline: orchestrates the three separated stages and persists the result.
 *
 *   ┌──────────────────────┐   ┌────────────────────────┐   ┌──────────────────────┐   ┌───────────────┐
 *   │ 1. DATA CALCULATION  │ → │ 2. HTML COMPILATION    │ → │ 3. RENDER + STORAGE  │ → │ 4. METADATA   │
 *   │ payslipDataBuilder   │   │ payslipHtmlTemplate    │   │ pdfGenerationService │   │ Payslip model │
 *   │ (payrollCalculator)  │   │ + payslipVerification  │   │ → payslipStorage (S3)│   │ (MongoDB)     │
 *   └──────────────────────┘   └────────────────────────┘   └──────────────────────┘   └───────────────┘
 *        figures (pure)            HTML string (pure)          PDF stream → S3 object      record
 *
 *   1. The employee record is loaded and the month's figures computed (no I/O after the load).
 *   2. The payslip id, issue time and HMAC verification ID are fixed, then the figures are compiled
 *      into a self-contained HTML document that prints the verification ID.
 *   3. Headless Chromium renders the HTML to a PDF stream, which is piped through a SHA-256
 *      digest into S3 at company-payslips/YYYY/MM/<employeeId>_<payslipId>.pdf.
 *   4. The Payslip document (figures, snapshot, verification, storage metadata) is saved.
 *
 * Consistency between S3 and MongoDB (no distributed transaction exists across them):
 *   - The object is uploaded before the record is written, so a record always points at a file.
 *   - If writing the record fails, the uploaded object is deleted (compensating action) and, for a
 *     reissue, the previous payslip is restored to Issued. A failure of that cleanup is logged with
 *     the key for manual removal; an orphan file is invisible to users because nothing references it.
 *   - Two simultaneous generations for the same employee and month cannot both succeed: the partial
 *     unique index allows one Issued payslip per month, and a reissue supersedes the previous one with
 *     a conditional update; the loser deletes its object and receives 409.
 *
 * Reissue: { reissue: true } creates revision n+1 and marks revision n Superseded (never deleted).
 */

import mongoose from 'mongoose';
import Department from '../models/Department.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import Payslip, { PAYSLIP_STATUSES } from '../models/Payslip.js';
import User from '../models/User.js';
import { logger } from '../utils/logger.js';
import { buildPayslipFigures } from './payslipDataBuilder.js';
import { compilePayslipHtml } from './payslipHtmlTemplate.js';
import { buildVerificationId, computePayslipContentHmac, isPayslipContentAuthentic } from './payslipVerification.js';
import { PdfRenderError, closePdfRenderer, initPdfRenderer, isPdfRendererConfigured, renderHtmlToPdfStream } from './pdfGenerationService.js';
import {
  PayslipStorageError,
  buildPayslipObjectKey,
  closePayslipStorage,
  createPayslipDownloadUrl,
  deletePayslipObjectQuietly,
  getPayslipServerSideEncryption,
  initPayslipStorage,
  isPayslipStorageConfigured,
  uploadPayslipPdf,
} from './payslipStorage.js';

const DUPLICATE_KEY_ERROR_CODE = 11000;

export const PAYSLIP_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'PAYSLIPS_NOT_CONFIGURED',
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',
  PAYSLIP_EXISTS: 'PAYSLIP_EXISTS',
  CONCURRENT_UPDATE: 'PAYSLIP_CONCURRENT_UPDATE',
  RENDERER_UNAVAILABLE: 'PDF_RENDERER_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'PAYSLIP_STORAGE_UNAVAILABLE',
});

/** An expected failure with the HTTP status and stable code the controller returns. */
export class PayslipGenerationError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'PayslipGenerationError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/** @type {{ signingSecret: string, verificationBaseUrl: string|null, company: object } | null} */
let payslipSettings = null;

/** Wires the storage and renderer stages; null disables payslips (routes answer 503). */
export function initPayslipServices(payslipConfig) {
  initPayslipStorage(payslipConfig?.storage ?? null);
  initPdfRenderer(payslipConfig?.pdfBrowser ?? null);
  payslipSettings = payslipConfig ? { signingSecret: payslipConfig.signingSecret, verificationBaseUrl: payslipConfig.verificationBaseUrl, company: payslipConfig.company } : null;
  if (!payslipConfig) logger.info('Payslip generation disabled', { reason: 'PAYSLIP_S3_BUCKET is not set' });
}

export function isPayslipGenerationConfigured() {
  return payslipSettings !== null && isPayslipStorageConfigured() && isPdfRendererConfigured();
}

export async function closePayslipServices() {
  await closePdfRenderer();
  closePayslipStorage();
}

function requireConfigured() {
  if (!isPayslipGenerationConfigured()) {
    throw new PayslipGenerationError(503, PAYSLIP_ERROR_CODES.NOT_CONFIGURED, 'Payslip generation is not configured on this server');
  }
}

/** The employee details printed on the payslip, read from MongoDB. */
async function loadEmployeeForPayslip(employeeId) {
  const profile = await EmployeeProfile.findById(employeeId).select('userId organizationData').lean();
  if (!profile) return null;
  const { departmentId, officeLocationId, designation, dateOfJoining } = profile.organizationData;
  const [account, department, office] = await Promise.all([
    User.findById(profile.userId).select('name').lean(),
    departmentId ? Department.findById(departmentId).select('name').lean() : null,
    officeLocationId ? OfficeLocation.findById(officeLocationId).select('name').lean() : null,
  ]);
  return {
    employeeId: profile._id.toString(),
    name: account?.name ?? 'Employee',
    designation,
    departmentName: department?.name ?? null,
    officeName: office?.name ?? null,
    dateOfJoining: new Date(dateOfJoining).toISOString().slice(0, 10),
  };
}

/**
 * Runs the full pipeline for one employee and month.
 * @param {object} generationRequest
 * @param {string} generationRequest.employeeId
 * @param {{ year: number, month: number }} generationRequest.period
 * @param {object} generationRequest.salaryStructure
 * @param {object|null} generationRequest.investmentsDeclared
 * @param {'old'|'new'} generationRequest.taxRegimeChoice
 * @param {object} generationRequest.employmentDetails
 * @param {boolean} generationRequest.reissue
 * @param {string} generationRequest.generatedByUserId
 * @param {string} [generationRequest.requestId]
 * @returns {Promise<object>} the stored Payslip (lean, without storage key or HMAC)
 * @throws {PayslipGenerationError | import('../utils/payrollCalculator.js').PayrollInputError}
 */
export async function generatePayslip({ employeeId, period, salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails, reissue, generatedByUserId, requestId }) {
  requireConfigured();

  // ---- Stage 1: data calculation ---------------------------------------------------------------
  const employee = await loadEmployeeForPayslip(employeeId);
  if (!employee) throw new PayslipGenerationError(404, PAYSLIP_ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Employee not found');

  const periodFilter = { employeeId, 'period.year': period.year, 'period.month': period.month };
  const issuedPayslip = await Payslip.findOne({ ...periodFilter, status: PAYSLIP_STATUSES.ISSUED }).select('_id revision').lean();
  if (issuedPayslip && !reissue) {
    throw new PayslipGenerationError(409, PAYSLIP_ERROR_CODES.PAYSLIP_EXISTS, `A payslip for this month already exists (${issuedPayslip._id}); send reissue: true to replace it`);
  }
  const latestRevision = await Payslip.findOne(periodFilter).sort({ revision: -1 }).select('revision').lean();
  const revision = (latestRevision?.revision ?? 0) + 1;

  const figures = buildPayslipFigures({ employee, period, salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails });

  // ---- Stage 2: identity, verification and HTML compilation ------------------------------------
  const payslipId = new mongoose.Types.ObjectId();
  const issuedAt = new Date();
  const contentHmac = computePayslipContentHmac(
    { payslipId: payslipId.toString(), employeeId, period, revision, earnings: figures.earnings, deductions: figures.deductions, grossEarnings: figures.grossEarnings, totalDeductions: figures.totalDeductions, netPay: figures.netPay, issuedAt },
    payslipSettings.signingSecret,
  );
  const verificationId = buildVerificationId(contentHmac, period);
  const html = compilePayslipHtml({
    figures,
    company: payslipSettings.company,
    verification: { verificationId, verificationUrl: payslipSettings.verificationBaseUrl ? `${payslipSettings.verificationBaseUrl}/${verificationId}` : null },
    issuedAt,
    revision,
  });

  // ---- Stage 3: render and upload --------------------------------------------------------------
  const objectKey = buildPayslipObjectKey({ year: period.year, month: period.month, employeeId, payslipId: payslipId.toString() });
  let storedObject;
  try {
    const pdfStream = await renderHtmlToPdfStream(html);
    storedObject = await uploadPayslipPdf(pdfStream, objectKey);
  } catch (pipelineError) {
    if (pipelineError instanceof PdfRenderError) {
      logger.error('Payslip PDF rendering failed', { requestId, employeeId, error: pipelineError.message });
      throw new PayslipGenerationError(503, PAYSLIP_ERROR_CODES.RENDERER_UNAVAILABLE, 'The PDF renderer is unavailable. Please try again shortly');
    }
    if (pipelineError instanceof PayslipStorageError) {
      logger.error('Payslip upload failed', { requestId, employeeId, error: pipelineError.message });
      await deletePayslipObjectQuietly(objectKey, requestId);
      throw new PayslipGenerationError(503, PAYSLIP_ERROR_CODES.STORAGE_UNAVAILABLE, 'Payslip storage is temporarily unavailable. Please try again shortly');
    }
    throw pipelineError;
  }

  // ---- Stage 4: metadata -----------------------------------------------------------------------
  if (issuedPayslip) {
    const supersededPayslip = await Payslip.findOneAndUpdate(
      { _id: issuedPayslip._id, status: PAYSLIP_STATUSES.ISSUED },
      { $set: { status: PAYSLIP_STATUSES.SUPERSEDED, supersededAt: issuedAt, supersededByPayslipId: payslipId } },
    );
    if (!supersededPayslip) {
      await deletePayslipObjectQuietly(objectKey, requestId);
      throw new PayslipGenerationError(409, PAYSLIP_ERROR_CODES.CONCURRENT_UPDATE, 'This payslip was changed by another request. Reload and try again');
    }
  }

  try {
    const storedPayslip = await Payslip.create({
      _id: payslipId,
      employeeId,
      financialYear: figures.financialYear,
      period: { year: period.year, month: period.month },
      revision,
      status: PAYSLIP_STATUSES.ISSUED,
      employeeSnapshot: {
        name: employee.name,
        designation: employee.designation,
        departmentName: employee.departmentName,
        officeName: employee.officeName,
        dateOfJoining: employee.dateOfJoining,
      },
      earnings: figures.earnings,
      deductions: figures.deductions,
      grossEarnings: figures.grossEarnings,
      totalDeductions: figures.totalDeductions,
      netPay: figures.netPay,
      netPayInWords: figures.netPayInWords,
      taxSummary: {
        regime: figures.taxSummary.regime,
        annualTaxableIncome: figures.taxSummary.annualTaxableIncome,
        projectedAnnualTax: figures.taxSummary.projectedAnnualTax,
        monthlyTds: figures.taxSummary.monthlyTds,
      },
      verification: { verificationId, contentHmac },
      storage: { s3Key: objectKey, sizeBytes: storedObject.sizeBytes, sha256: storedObject.sha256, contentType: 'application/pdf', serverSideEncryption: getPayslipServerSideEncryption() },
      generatedByUserId,
      issuedAt,
    });
    logger.info('Payslip issued', { requestId, payslipId: payslipId.toString(), employeeId, period: `${period.year}-${period.month}`, revision, sizeBytes: storedObject.sizeBytes });
    return storedPayslip.toJSON();
  } catch (writeError) {
    if (issuedPayslip) {
      await Payslip.updateOne({ _id: issuedPayslip._id }, { $set: { status: PAYSLIP_STATUSES.ISSUED, supersededAt: null, supersededByPayslipId: null } }).catch((restoreError) =>
        logger.error('Could not restore the previous payslip after a failed reissue', { requestId, payslipId: issuedPayslip._id.toString(), error: restoreError.message }),
      );
    }
    await deletePayslipObjectQuietly(objectKey, requestId);
    if (writeError?.code === DUPLICATE_KEY_ERROR_CODE) {
      throw new PayslipGenerationError(409, PAYSLIP_ERROR_CODES.PAYSLIP_EXISTS, 'A payslip for this month was issued by another request at the same time');
    }
    throw writeError;
  }
}

/**
 * A 60-second download link for a payslip the caller may read (authorisation is the controller's).
 * @returns {Promise<{ payslip: object, download: { url, expiresAt, expiresInSeconds, fileName } } | null>}
 */
export async function createPayslipDownload(payslipId) {
  requireConfigured();
  const payslip = await Payslip.findById(payslipId).select('+storage.s3Key').lean();
  if (!payslip) return null;
  const fileName = `Payslip-${payslip.period.year}-${String(payslip.period.month).padStart(2, '0')}-${payslip.employeeSnapshot.name.replace(/[^A-Za-z0-9]+/g, '_')}${payslip.revision > 1 ? `-r${payslip.revision}` : ''}.pdf`;
  try {
    const { downloadUrl, expiresAt } = await createPayslipDownloadUrl(payslip.storage.s3Key, fileName);
    return { payslip, download: { url: downloadUrl, expiresAt, expiresInSeconds: 60, fileName } };
  } catch (signingError) {
    throw new PayslipGenerationError(503, PAYSLIP_ERROR_CODES.STORAGE_UNAVAILABLE, `Payslip storage is temporarily unavailable (${signingError.message})`);
  }
}

/** "Asha Rao" -> "Asha R." (verification shows who, without exposing a full name publicly). */
function maskName(fullName) {
  const nameParts = fullName.trim().split(/\s+/);
  return nameParts.length > 1 ? `${nameParts[0]} ${nameParts[nameParts.length - 1][0]}.` : nameParts[0];
}

/**
 * Public verification by ID. Recomputes the HMAC from the stored figures, so an altered record is
 * reported as not authentic. Returns only what a third party needs to match a document they hold.
 * @returns {Promise<{ found: false } | { found: true, authentic: boolean, details: object }>}
 */
export async function verifyPayslip(verificationId) {
  requireConfigured();
  const payslip = await Payslip.findOne({ 'verification.verificationId': verificationId }).select('+verification.contentHmac').lean();
  if (!payslip) return { found: false };
  const authentic = isPayslipContentAuthentic(
    {
      payslipId: payslip._id.toString(),
      employeeId: payslip.employeeId.toString(),
      period: payslip.period,
      revision: payslip.revision,
      earnings: payslip.earnings,
      deductions: payslip.deductions,
      grossEarnings: payslip.grossEarnings,
      totalDeductions: payslip.totalDeductions,
      netPay: payslip.netPay,
      issuedAt: payslip.issuedAt,
    },
    payslip.verification.contentHmac,
    payslipSettings.signingSecret,
  );
  if (!authentic) logger.error('Payslip verification failed: stored figures do not match their HMAC', { payslipId: payslip._id.toString() });
  return {
    found: true,
    authentic,
    details: {
      verificationId,
      issuer: payslipSettings.company.legalName,
      employeeName: maskName(payslip.employeeSnapshot.name),
      period: `${payslip.period.year}-${String(payslip.period.month).padStart(2, '0')}`,
      revision: payslip.revision,
      status: payslip.status,
      issuedAt: new Date(payslip.issuedAt).toISOString(),
      netPay: payslip.netPay,
      documentSha256: payslip.storage.sha256,
    },
  };
}
