/**
 * Payroll tax endpoints (routes/payrollRoutes.js, mounted at /api/payroll). The calculation itself
 * lives in utils/payrollCalculator.js; these handlers expose it over HTTP.
 *
 *   GET  /rules          the options a client needs to build the input form: supported financial
 *                        year, regimes, age categories, professional-tax states, 50% HRA cities
 *   POST /tax-estimate   both tax regimes, EPF / ESI / professional tax, and the recommended regime
 *
 *   POST /payslips                         generate (HR/admin): data -> HTML -> PDF -> S3 -> Payslip
 *   GET  /payslips                         list: own payslips, or any employee's for HR/admin
 *   GET  /payslips/:payslipId/download     60-second pre-signed download link
 *   GET  /payslips/verify/:verificationId  public authenticity check by the ID printed on the PDF
 *   (pipeline: services/payslipService.js)
 *
 * Privacy: salary and investment figures are personal financial data. Tax estimates are never
 * stored. Issued payslips are stored (the Payslip record and the encrypted PDF), readable only by
 * the employee, HR and admins. Salary figures are never logged; logs and audit events record only
 * ids, periods and outcomes. Responses carry Cache-Control: no-store (set by the router).
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { PAYROLL_MESSAGES } from '../constants/messages.js';
import {
  AGE_CATEGORIES,
  HRA_FIFTY_PERCENT_CITIES,
  PROFESSIONAL_TAX_STATES,
  PayrollInputError,
  SUPPORTED_FINANCIAL_YEAR,
  TAX_REGIMES,
  computeTaxLiability,
} from '../utils/payrollCalculator.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import Payslip from '../models/Payslip.js';
import { ROLES } from '../models/User.js';
import { PayslipGenerationError, createPayslipDownload, generatePayslip, verifyPayslip } from '../services/payslipService.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { logger } from '../utils/logger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

function isPlainObject(candidateValue) {
  return typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
}

/** GET /api/payroll/rules */
export function getPayrollRules(req, res) {
  return sendSuccess(res, HTTP_STATUS.OK, PAYROLL_MESSAGES.RULES_RETRIEVED, {
    financialYear: SUPPORTED_FINANCIAL_YEAR,
    taxRegimes: Object.values(TAX_REGIMES),
    ageCategories: Object.values(AGE_CATEGORIES),
    professionalTaxStates: Object.values(PROFESSIONAL_TAX_STATES),
    hraFiftyPercentCities: [...HRA_FIFTY_PERCENT_CITIES],
  });
}

/**
 * POST /api/payroll/tax-estimate
 * Body: { salaryStructure, investmentsDeclared?, taxRegimeChoice, employmentDetails }
 *   (field meanings: utils/payrollCalculator.js computeTaxLiability)
 *
 * Responses:
 *   200 { message, data: { estimate } }   the full analysis payload
 *   400 invalid body, or calculator input errors with one `details` entry per invalid field
 *   401 / 403 from protect (session, CSRF)
 */
export function createTaxEstimate(req, res, next) {
  try {
    if (!isPlainObject(req.body)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.BODY_MUST_BE_OBJECT, [{ field: 'body', message: PAYROLL_MESSAGES.BODY_MUST_BE_OBJECT }]);
    }
    const { salaryStructure, investmentsDeclared = null, taxRegimeChoice, employmentDetails } = req.body;

    let estimate;
    try {
      estimate = computeTaxLiability(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails);
    } catch (calculationError) {
      if (!(calculationError instanceof PayrollInputError)) throw calculationError;
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.INPUT_INVALID, calculationError.fieldErrors);
    }

    logger.info('Tax estimate computed', {
      requestId: req.id,
      userId: req.user.id,
      chosenRegime: estimate.chosenRegime.regime,
      recommendedRegime: estimate.recommendation.recommendedRegime,
    });
    return sendSuccess(res, HTTP_STATUS.OK, PAYROLL_MESSAGES.ESTIMATE_COMPUTED, { estimate });
  } catch (error) {
    return next(error);
  }
}


// =================================================================================================
// Payslips
// =================================================================================================

/** Roles that issue payslips and may read anyone's. */
const PAYROLL_MANAGER_ROLES = Object.freeze([ROLES.ADMIN, ROLES.HR]);
const VERIFICATION_ID_PATTERN = /^PS-\d{6}-[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;
const PAYSLIP_LIST_LIMIT = 60;

function auditPayslip(req, action, outcome, details) {
  recordAuditEvent(req, { category: 'payroll', action, outcome, ...details });
}

function sendPayslipError(req, res, payslipError) {
  return sendCodedError(req, res, payslipError.httpStatus, { code: payslipError.code, message: payslipError.message });
}

/** The fields of a payslip a client sees (no storage key, no HMAC). */
function toPayslipSummary(payslip) {
  return {
    id: payslip._id.toString(),
    employeeId: payslip.employeeId.toString(),
    financialYear: payslip.financialYear,
    period: { year: payslip.period.year, month: payslip.period.month },
    revision: payslip.revision,
    status: payslip.status,
    employee: payslip.employeeSnapshot,
    earnings: payslip.earnings,
    deductions: payslip.deductions,
    grossEarnings: payslip.grossEarnings,
    totalDeductions: payslip.totalDeductions,
    netPay: payslip.netPay,
    netPayInWords: payslip.netPayInWords,
    taxSummary: payslip.taxSummary,
    verificationId: payslip.verification.verificationId,
    document: { sizeBytes: payslip.storage.sizeBytes, sha256: payslip.storage.sha256, contentType: payslip.storage.contentType },
    issuedAt: new Date(payslip.issuedAt).toISOString(),
    supersededAt: payslip.supersededAt ? new Date(payslip.supersededAt).toISOString() : null,
  };
}

async function findOwnEmployeeProfileId(userId) {
  const ownProfile = await EmployeeProfile.findOne({ userId }).select('_id').lean();
  return ownProfile ? ownProfile._id.toString() : null;
}

/**
 * POST /api/payroll/payslips   (admin, hr)
 * Body: { employeeId, year, month, salaryStructure, investmentsDeclared?, taxRegimeChoice,
 *         employmentDetails, reissue? }
 * Responses: 201 { payslip } | 400 invalid input | 403 not HR/admin | 404 employee |
 *            409 already issued (send reissue: true) or concurrent change | 503 not configured,
 *            renderer or storage unavailable
 */
export async function createPayslip(req, res, next) {
  try {
    if (!PAYROLL_MANAGER_ROLES.includes(req.user.role)) {
      auditPayslip(req, 'generate_payslip', AUDIT_OUTCOMES.DENIED, { reason: 'role_not_allowed' });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, PAYROLL_MESSAGES.PAYSLIP_MANAGERS_ONLY);
    }
    if (!isPlainObject(req.body)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.BODY_MUST_BE_OBJECT, [{ field: 'body', message: PAYROLL_MESSAGES.BODY_MUST_BE_OBJECT }]);
    }
    const { employeeId, year, month, reissue = false, salaryStructure, investmentsDeclared = null, taxRegimeChoice, employmentDetails } = req.body;
    const fieldErrors = [];
    if (!isValidObjectIdString(employeeId)) fieldErrors.push({ field: 'employeeId', message: 'must be an employee id' });
    if (!Number.isInteger(year)) fieldErrors.push({ field: 'year', message: 'must be a whole number' });
    if (!Number.isInteger(month) || month < 1 || month > 12) fieldErrors.push({ field: 'month', message: 'must be 1-12' });
    if (typeof reissue !== 'boolean') fieldErrors.push({ field: 'reissue', message: 'must be true or false' });
    if (fieldErrors.length > 0) return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.INPUT_INVALID, fieldErrors);

    let payslip;
    try {
      payslip = await generatePayslip({
        employeeId: employeeId.toLowerCase(),
        period: { year, month },
        salaryStructure,
        investmentsDeclared,
        taxRegimeChoice,
        employmentDetails,
        reissue,
        generatedByUserId: req.user.id,
        requestId: req.id,
      });
    } catch (generationError) {
      if (generationError instanceof PayrollInputError) {
        return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.INPUT_INVALID, generationError.fieldErrors);
      }
      if (generationError instanceof PayslipGenerationError) {
        auditPayslip(req, 'generate_payslip', generationError.httpStatus >= 500 ? AUDIT_OUTCOMES.FAILED : AUDIT_OUTCOMES.REJECTED, { employeeId, year, month, reason: generationError.code });
        return sendPayslipError(req, res, generationError);
      }
      throw generationError;
    }

    auditPayslip(req, 'generate_payslip', AUDIT_OUTCOMES.ALLOWED, { payslipId: payslip._id.toString(), employeeId, year, month, revision: payslip.revision });
    return sendSuccess(res, HTTP_STATUS.CREATED, PAYROLL_MESSAGES.PAYSLIP_ISSUED, { payslip: toPayslipSummary(payslip) });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/payroll/payslips?employeeId=&year=&month=&includeSuperseded=true
 * Employees see their own payslips (employeeId defaults to their profile); HR and admins may list
 * any employee's. Newest first, at most 60.
 */
export async function listPayslips(req, res, next) {
  try {
    const isPayrollManager = PAYROLL_MANAGER_ROLES.includes(req.user.role);
    const ownProfileId = await findOwnEmployeeProfileId(req.user.id);
    const requestedEmployeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId.toLowerCase() : ownProfileId;
    if (!requestedEmployeeId) return sendError(req, res, HTTP_STATUS.NOT_FOUND, PAYROLL_MESSAGES.NO_EMPLOYEE_PROFILE);
    if (!isValidObjectIdString(requestedEmployeeId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.INPUT_INVALID, [{ field: 'employeeId', message: 'must be an employee id' }]);
    }
    if (!isPayrollManager && requestedEmployeeId !== ownProfileId) {
      auditPayslip(req, 'list_payslips', AUDIT_OUTCOMES.DENIED, { employeeId: requestedEmployeeId, reason: 'not_owner' });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, PAYROLL_MESSAGES.PAYSLIP_ACCESS_DENIED);
    }

    const listFilter = { employeeId: requestedEmployeeId };
    if (req.query.includeSuperseded !== 'true') listFilter.status = 'Issued';
    for (const [queryKey, fieldPath] of [['year', 'period.year'], ['month', 'period.month']]) {
      if (req.query[queryKey] === undefined) continue;
      const parsedValue = Number(req.query[queryKey]);
      if (!Number.isInteger(parsedValue)) {
        return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.INPUT_INVALID, [{ field: queryKey, message: 'must be a whole number' }]);
      }
      listFilter[fieldPath] = parsedValue;
    }
    const payslips = await Payslip.find(listFilter).sort({ 'period.year': -1, 'period.month': -1, revision: -1 }).limit(PAYSLIP_LIST_LIMIT).lean();
    return sendSuccess(res, HTTP_STATUS.OK, PAYROLL_MESSAGES.PAYSLIPS_RETRIEVED, { payslips: payslips.map(toPayslipSummary), meta: { count: payslips.length, limit: PAYSLIP_LIST_LIMIT } });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/payroll/payslips/:payslipId/download   (owner, hr, admin) */
export async function downloadPayslip(req, res, next) {
  try {
    const { payslipId } = req.params;
    if (!isValidObjectIdString(payslipId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.INPUT_INVALID, [{ field: 'payslipId', message: 'must be a payslip id' }]);
    }
    const payslipOwner = await Payslip.findById(payslipId).select('employeeId').lean();
    if (!payslipOwner) return sendError(req, res, HTTP_STATUS.NOT_FOUND, PAYROLL_MESSAGES.PAYSLIP_NOT_FOUND);
    const isOwner = (await findOwnEmployeeProfileId(req.user.id)) === payslipOwner.employeeId.toString();
    if (!isOwner && !PAYROLL_MANAGER_ROLES.includes(req.user.role)) {
      auditPayslip(req, 'download_payslip', AUDIT_OUTCOMES.DENIED, { payslipId, reason: 'not_owner' });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, PAYROLL_MESSAGES.PAYSLIP_ACCESS_DENIED);
    }

    let downloadResult;
    try {
      downloadResult = await createPayslipDownload(payslipId);
    } catch (downloadError) {
      if (downloadError instanceof PayslipGenerationError) return sendPayslipError(req, res, downloadError);
      throw downloadError;
    }
    auditPayslip(req, 'download_payslip', AUDIT_OUTCOMES.ALLOWED, { payslipId, grantBasis: isOwner ? 'owner' : 'role' });
    return sendSuccess(res, HTTP_STATUS.OK, PAYROLL_MESSAGES.DOWNLOAD_ISSUED, { download: downloadResult.download });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/payroll/payslips/verify/:verificationId   (public, rate-limited)
 * 200 { verification: { authentic, issuer, employeeName (masked), period, revision, status, issuedAt,
 *       netPay, documentSha256 } } | 404 unknown ID. A verifier compares documentSha256 with the
 * SHA-256 of the PDF they were given.
 */
export async function verifyPayslipById(req, res, next) {
  try {
    const { verificationId } = req.params;
    if (!VERIFICATION_ID_PATTERN.test(verificationId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PAYROLL_MESSAGES.VERIFICATION_ID_INVALID);
    }
    let verificationResult;
    try {
      verificationResult = await verifyPayslip(verificationId);
    } catch (verificationError) {
      if (verificationError instanceof PayslipGenerationError) return sendPayslipError(req, res, verificationError);
      throw verificationError;
    }
    if (!verificationResult.found) return sendError(req, res, HTTP_STATUS.NOT_FOUND, PAYROLL_MESSAGES.VERIFICATION_NOT_FOUND);
    return sendSuccess(res, HTTP_STATUS.OK, PAYROLL_MESSAGES.VERIFICATION_COMPLETED, { verification: { authentic: verificationResult.authentic, ...verificationResult.details } });
  } catch (error) {
    return next(error);
  }
}
