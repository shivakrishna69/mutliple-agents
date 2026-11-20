/**
 * Form 16 endpoints (routes/taxRoutes.js, mounted at /api/tax; services/tax/form16Service.js):
 *
 *   GET  /years                              the financial years offered, newest first
 *   GET  /ca/employees?fy=&search=&status=   (MANAGE_FORM16) counts and eligible employees
 *   GET  /ca/employees/:employeeId?fy=       (MANAGE_FORM16) one eligible employee; 404 otherwise
 *   POST /ca/employees/:employeeId/form16    (MANAGE_FORM16) multipart PDF upload; 404 if not eligible
 *   GET  /my-form16?fy=                      (VIEW_OWN_FORM16) { eligible, documents }
 *   GET  /form16/:documentId/download        the owner or MANAGE_FORM16; 404 for anyone else
 *
 * Uploads and downloads are audited (category "form16", actions FORM16_UPLOADED and
 * FORM16_DOWNLOADED) with ids and outcomes only: never figures, file contents or the signed link.
 */

import { CAPABILITIES, hasCapability } from '../constants/accessRoles.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { FORM16_MESSAGES } from '../constants/messages.js';
import { getCompanySettings } from '../services/companySettings.js';
import { ServiceError } from '../services/serviceError.js';
import {
  createForm16Download,
  getCaEmployee,
  getMyForm16,
  isPdfContent,
  listCaEmployees,
  uploadForm16,
} from '../services/tax/form16Service.js';
import { offeredFinancialYears } from '../services/tax/form16Eligibility.js';
import { sendCodedError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { validateCaListQuery, validateFinancialYearQuery, validateForm16Upload } from '../validators/taxValidators.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

const form16Handler = createWorkforceHandlerFactory({
  auditCategory: 'form16',
  restrictedMessage: FORM16_MESSAGES.NOT_ALLOWED,
  inputInvalidMessage: FORM16_MESSAGES.INPUT_INVALID,
});
const ownForm16Handler = createWorkforceHandlerFactory({
  auditCategory: 'form16',
  restrictedMessage: FORM16_MESSAGES.OWN_NOT_ALLOWED,
  inputInvalidMessage: FORM16_MESSAGES.INPUT_INVALID,
});

const CA_READ = Object.freeze({ capability: CAPABILITIES.MANAGE_FORM16, isWrite: false });
const CA_WRITE = Object.freeze({ capability: CAPABILITIES.MANAGE_FORM16, isWrite: true });
const OWN_READ = Object.freeze({ capability: CAPABILITIES.VIEW_OWN_FORM16, isWrite: false });

/** The financial years offered today, in the company's time zone. */
async function offeredYears() {
  const settings = await getCompanySettings();
  return offeredFinancialYears(settings.timeZone);
}

/** GET /api/tax/years : open to anyone who may use either side of the portal. */
export async function getForm16Years(req, res, next) {
  try {
    const mayUse =
      hasCapability(req.user.role, CAPABILITIES.MANAGE_FORM16) ||
      hasCapability(req.user.role, CAPABILITIES.VIEW_OWN_FORM16);
    if (!mayUse) {
      return sendCodedError(req, res, HTTP_STATUS.FORBIDDEN, {
        code: 'FORM16_NOT_ALLOWED',
        message: FORM16_MESSAGES.OWN_NOT_ALLOWED,
      });
    }
    return sendSuccess(res, HTTP_STATUS.OK, FORM16_MESSAGES.YEARS_RETRIEVED, { financialYears: await offeredYears() });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/tax/ca/employees */
export const getCaEmployees = form16Handler('list_form16_employees', CA_READ, async (req) => {
  const validation = validateCaListQuery(req.query, await offeredYears());
  if (!validation.isValid) return validation;
  return { message: FORM16_MESSAGES.EMPLOYEES_RETRIEVED, data: await listCaEmployees(validation.sanitizedInput) };
});

/** GET /api/tax/ca/employees/:employeeId */
export const getCaEmployeeDetail = form16Handler('view_form16_employee', CA_READ, async (req) => {
  const validation = validateFinancialYearQuery(req.query, await offeredYears());
  if (!validation.isValid) return validation;
  return {
    message: FORM16_MESSAGES.EMPLOYEE_RETRIEVED,
    data: await getCaEmployee({ employeeId: req.params.employeeId, ...validation.sanitizedInput }),
  };
});

/** POST /api/tax/ca/employees/:employeeId/form16 (multipart: file, financialYear, partType, computationSummary) */
export const postForm16 = form16Handler('FORM16_UPLOADED', CA_WRITE, async (req) => {
  const validation = validateForm16Upload(req.body, await offeredYears());
  if (!validation.isValid) return validation;
  if (!req.file) {
    throw new ServiceError(HTTP_STATUS.BAD_REQUEST, 'FORM16_FILE_REQUIRED', FORM16_MESSAGES.FILE_REQUIRED);
  }
  if (!isPdfContent(req.file.buffer)) {
    throw new ServiceError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'FORM16_NOT_PDF', FORM16_MESSAGES.FILE_NOT_PDF);
  }
  const { document, supersededId } = await uploadForm16({
    employeeId: req.params.employeeId,
    ...validation.sanitizedInput,
    file: req.file,
    actorUserId: req.user.id,
    requestId: req.id,
  });
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: FORM16_MESSAGES.UPLOADED,
    data: { document, supersededId },
    auditDetails: {
      employeeId: document.employeeId,
      documentId: document.id,
      financialYear: document.financialYear,
      partType: document.partType,
      version: document.version,
      supersededId,
    },
  };
});

/** GET /api/tax/my-form16 */
export const getOwnForm16 = ownForm16Handler('view_own_form16', OWN_READ, async (req) => {
  const validation = validateFinancialYearQuery(req.query, await offeredYears());
  if (!validation.isValid) return validation;
  return {
    message: FORM16_MESSAGES.MY_FORM16_RETRIEVED,
    data: await getMyForm16({ userId: req.user.id, ...validation.sanitizedInput }),
  };
});

/** GET /api/tax/form16/:documentId/download */
export async function downloadForm16(req, res, next) {
  const audit = (outcome, details) =>
    recordAuditEvent(req, {
      category: 'form16',
      action: 'FORM16_DOWNLOADED',
      outcome,
      documentId: req.params.documentId,
      ...details,
    });
  try {
    const mayManageForm16 = hasCapability(req.user.role, CAPABILITIES.MANAGE_FORM16);
    if (!mayManageForm16 && !hasCapability(req.user.role, CAPABILITIES.VIEW_OWN_FORM16)) {
      audit(AUDIT_OUTCOMES.DENIED, { reason: 'role' });
      return sendCodedError(req, res, HTTP_STATUS.FORBIDDEN, {
        code: 'FORM16_NOT_ALLOWED',
        message: FORM16_MESSAGES.OWN_NOT_ALLOWED,
      });
    }
    let result;
    try {
      result = await createForm16Download({ documentId: req.params.documentId, userId: req.user.id, mayManageForm16 });
    } catch (downloadError) {
      if (!(downloadError instanceof ServiceError)) throw downloadError;
      const outcome =
        downloadError.httpStatus === HTTP_STATUS.SERVICE_UNAVAILABLE ? AUDIT_OUTCOMES.FAILED : AUDIT_OUTCOMES.REJECTED;
      audit(outcome, { reason: downloadError.code });
      return sendCodedError(req, res, downloadError.httpStatus, {
        code: downloadError.code,
        message: downloadError.message,
      });
    }
    audit(AUDIT_OUTCOMES.ALLOWED, {
      employeeId: result.document.employeeId,
      financialYear: result.document.financialYear,
      grantBasis: result.grantBasis,
    });
    return sendSuccess(res, HTTP_STATUS.OK, FORM16_MESSAGES.DOWNLOAD_ISSUED, {
      download: result.download,
      document: result.document,
    });
  } catch (error) {
    return next(error);
  }
}
