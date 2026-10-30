/**
 * Employee import endpoints (routes/employeeRoutes.js, /api/employees/bulk-upload): HR and
 * administrators upload a CSV, review it, start the import and follow it. Uploads, starts and the
 * results (which can hold activation links) are audited.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { EMPLOYEE_IMPORT_MESSAGES } from '../constants/messages.js';
import {
  confirmImportJob,
  createImportJob,
  getImportJob,
  getImportResults,
  listImportJobs,
} from '../services/employeeImportService.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const importHandler = createWorkforceHandlerFactory({
  auditCategory: 'employee_import',
  restrictedMessage: EMPLOYEE_IMPORT_MESSAGES.RESTRICTED,
  inputInvalidMessage: EMPLOYEE_IMPORT_MESSAGES.INPUT_INVALID,
});

const ADMIN_READ = Object.freeze({ requiresWorkforceAdmin: true, isWrite: false });
const ADMIN_WRITE = Object.freeze({ requiresWorkforceAdmin: true, isWrite: true });

/** POST /api/employees/bulk-upload (multipart, field "file"): checks the file; creates nobody yet. */
export const postEmployeeImport = importHandler('upload_employee_file', ADMIN_WRITE, async (req) => {
  if (!req.file) return { validationErrors: [{ field: 'file', message: EMPLOYEE_IMPORT_MESSAGES.FILE_REQUIRED }] };
  const job = await createImportJob({
    fileBuffer: req.file.buffer,
    fileName: req.file.originalname || 'employees.csv',
    importer: { id: req.user.id, name: req.user.name, role: req.user.role },
  });
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: EMPLOYEE_IMPORT_MESSAGES.FILE_CHECKED,
    data: { job },
    auditDetails: { importJobId: job.id, rowCount: job.counts.total, validRowCount: job.counts.valid },
  };
});

/** GET /api/employees/bulk-upload */
export const getEmployeeImports = importHandler('list_employee_imports', ADMIN_READ, async () => ({
  message: EMPLOYEE_IMPORT_MESSAGES.JOBS_RETRIEVED,
  data: { jobs: await listImportJobs() },
}));

/** GET /api/employees/bulk-upload/:jobId (poll this for progress) */
export const getEmployeeImport = importHandler('view_employee_import', ADMIN_READ, async (req) => {
  const invalidParams = idParamErrors(req.params, 'jobId');
  if (invalidParams) return { validationErrors: invalidParams };
  return { message: EMPLOYEE_IMPORT_MESSAGES.JOB_RETRIEVED, data: { job: await getImportJob(req.params.jobId) } };
});

/** POST /api/employees/bulk-upload/:jobId/confirm : starts the import in the background */
export const postConfirmEmployeeImport = importHandler('start_employee_import', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'jobId');
  if (invalidParams) return { validationErrors: invalidParams };
  const job = await confirmImportJob(req.params.jobId);
  return {
    httpStatus: HTTP_STATUS.ACCEPTED,
    message: EMPLOYEE_IMPORT_MESSAGES.JOB_STARTED,
    data: { job },
    auditDetails: { importJobId: job.id, validRowCount: job.counts.valid },
  };
});

/** GET /api/employees/bulk-upload/:jobId/results : audited, because it can hold activation links */
export const getEmployeeImportResults = importHandler('view_employee_import_results', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'jobId');
  if (invalidParams) return { validationErrors: invalidParams };
  const results = await getImportResults(req.params.jobId, { serverSecret: req.app.locals.config.jwtSecret });
  return {
    message: EMPLOYEE_IMPORT_MESSAGES.RESULTS_RETRIEVED,
    data: results,
    auditDetails: {
      importJobId: results.job.id,
      activationLinksShown: results.rows.filter((row) => row.activationLink).length,
    },
  };
});
