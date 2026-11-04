/**
 * Employee record routes, mounted at /api/employees. HR and admins only; all require a signed-in
 * session and the CSRF token on changes. `:employeeId` is an EmployeeProfile id.
 *
 *   GET  /                      current employees (not terminated, invited included) with their office and manager
 *   PUT  /:employeeId/office    set the employee's base office ({ officeLocationId }, null clears it)
 *   PUT  /:employeeId/geofence-radius  their own punch-in radius ({ geofenceRadiusMeters }, null: the office's)
 *
 * Bulk import (controllers/employeeImportController.js):
 *   POST /bulk-upload                 a CSV in the multipart field "file": checked, nothing created yet
 *   GET  /bulk-upload                 the latest imports
 *   GET  /bulk-upload/:jobId          one import: status, counts, departments it adds, first issues (poll it)
 *   POST /bulk-upload/:jobId/confirm  start it; it runs in the background (202)
 *   GET  /bulk-upload/:jobId/results  every row's outcome, with activation links that could not be emailed
 */

import { Router } from 'express';
import {
  getEmployeeImport,
  getEmployeeImportResults,
  getEmployeeImports,
  postConfirmEmployeeImport,
  postEmployeeImport,
} from '../controllers/employeeImportController.js';
import { getEmployees, putEmployeeGeofenceRadius, putEmployeeOffice } from '../controllers/officeController.js';
import { EMPLOYEE_IMPORT_MESSAGES } from '../constants/messages.js';
import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import { protect } from '../middleware/authMiddleware.js';
import { employeeImportUploadRateLimitByUser, workplaceSetupWriteRateLimitByUser } from '../middleware/rateLimiter.js';
import { createSingleFileUpload } from '../middleware/singleFileUpload.js';

const receiveEmployeeFile = createSingleFileUpload({
  maxFileBytes: EMPLOYEE_IMPORT_LIMITS.MAX_FILE_BYTES,
  logLabel: 'Employee import',
  messages: {
    fileTooLarge: EMPLOYEE_IMPORT_MESSAGES.FILE_TOO_LARGE,
    fileRequired: EMPLOYEE_IMPORT_MESSAGES.FILE_REQUIRED,
    malformedUpload: EMPLOYEE_IMPORT_MESSAGES.MALFORMED_UPLOAD,
    multipartRequired: EMPLOYEE_IMPORT_MESSAGES.MULTIPART_REQUIRED,
  },
});

const employeeRouter = Router();

employeeRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
employeeRouter.get('/', getEmployees);
employeeRouter.put('/:employeeId/office', workplaceSetupWriteRateLimitByUser, putEmployeeOffice);
employeeRouter.put('/:employeeId/geofence-radius', workplaceSetupWriteRateLimitByUser, putEmployeeGeofenceRadius);
employeeRouter.post('/bulk-upload', employeeImportUploadRateLimitByUser, receiveEmployeeFile, postEmployeeImport);
employeeRouter.get('/bulk-upload', getEmployeeImports);
employeeRouter.get('/bulk-upload/:jobId', getEmployeeImport);
employeeRouter.post('/bulk-upload/:jobId/confirm', workplaceSetupWriteRateLimitByUser, postConfirmEmployeeImport);
employeeRouter.get('/bulk-upload/:jobId/results', getEmployeeImportResults);

export default employeeRouter;
