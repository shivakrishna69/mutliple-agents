/**
 * Form 16 routes, mounted at /api/tax (controllers/taxController.js). Every route needs a signed-in
 * session (and the CSRF token on the upload); responses are never cached.
 *
 *   GET  /years
 *   GET  /ca/employees?fy=&search=&status=
 *   GET  /ca/employees/:employeeId?fy=
 *   POST /ca/employees/:employeeId/form16     multipart: file (PDF, at most 10 MB), financialYear,
 *                                             partType, computationSummary (JSON)
 *   GET  /my-form16?fy=
 *   GET  /form16/:documentId/download
 */

import { Router } from 'express';
import {
  downloadForm16,
  getCaEmployeeDetail,
  getCaEmployees,
  getForm16Years,
  getOwnForm16,
  postForm16,
} from '../controllers/taxController.js';
import { CAPABILITIES } from '../constants/accessRoles.js';
import { FORM16_MESSAGES } from '../constants/messages.js';
import { FORM16_SETTINGS } from '../constants/validation.js';
import { protect } from '../middleware/authMiddleware.js';
import { form16DownloadRateLimitByUser, form16UploadRateLimitByUser } from '../middleware/rateLimiter.js';
import { requireCapability } from '../middleware/requireRole.js';
import { createSingleFileUpload } from '../middleware/singleFileUpload.js';

const receiveForm16File = createSingleFileUpload({
  maxFileBytes: FORM16_SETTINGS.MAX_FILE_BYTES,
  maxFieldBytes: FORM16_SETTINGS.MULTIPART_FIELD_MAX_BYTES,
  logLabel: 'Form 16',
  messages: {
    fileTooLarge: FORM16_MESSAGES.FILE_TOO_LARGE,
    fileRequired: FORM16_MESSAGES.FILE_REQUIRED,
    malformedUpload: FORM16_MESSAGES.MALFORMED_UPLOAD,
    multipartRequired: FORM16_MESSAGES.MULTIPART_REQUIRED,
  },
});

const taxRouter = Router();

taxRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
taxRouter.get('/years', getForm16Years);
taxRouter.get('/ca/employees', getCaEmployees);
taxRouter.get('/ca/employees/:employeeId', getCaEmployeeDetail);
// The capability is checked before the file is read, so nobody else can make the server buffer 10 MB.
taxRouter.post(
  '/ca/employees/:employeeId/form16',
  requireCapability(CAPABILITIES.MANAGE_FORM16, FORM16_MESSAGES.NOT_ALLOWED),
  form16UploadRateLimitByUser,
  receiveForm16File,
  postForm16,
);
taxRouter.get('/my-form16', getOwnForm16);
taxRouter.get('/form16/:documentId/download', form16DownloadRateLimitByUser, downloadForm16);

export default taxRouter;
