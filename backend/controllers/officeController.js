/**
 * Office endpoints (routes/officeRoutes.js and routes/employeeRoutes.js): HR and admins manage
 * offices, including their weekly offs, and assign employees their base office. Every change is
 * audited with ids and outcomes.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { OFFICE_MESSAGES } from '../constants/messages.js';
import {
  assignEmployeeOffice,
  createOffice,
  deleteOffice,
  getOffice,
  listOffices,
  updateOffice,
} from '../services/officeService.js';
import {
  validateOfficeAssignment,
  validateOfficeChanges,
  validateOfficeCreation,
} from '../validators/officeValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const officeHandler = createWorkforceHandlerFactory({
  auditCategory: 'offices',
  restrictedMessage: OFFICE_MESSAGES.RESTRICTED,
  inputInvalidMessage: OFFICE_MESSAGES.INPUT_INVALID,
});

const ADMIN_READ = Object.freeze({ requiresWorkforceAdmin: true, isWrite: false });
const ADMIN_WRITE = Object.freeze({ requiresWorkforceAdmin: true, isWrite: true });

/** GET /api/offices */
export const getOffices = officeHandler('list_offices', ADMIN_READ, async () => ({
  message: OFFICE_MESSAGES.OFFICES_RETRIEVED,
  data: { offices: await listOffices() },
}));

/** GET /api/offices/:officeLocationId */
export const getOfficeById = officeHandler('view_office', ADMIN_READ, async (req) => {
  const invalidParams = idParamErrors(req.params, 'officeLocationId');
  if (invalidParams) return { validationErrors: invalidParams };
  return { message: OFFICE_MESSAGES.OFFICE_RETRIEVED, data: { office: await getOffice(req.params.officeLocationId) } };
});

/** POST /api/offices */
export const postOffice = officeHandler('create_office', ADMIN_WRITE, async (req) => {
  const validation = validateOfficeCreation(req.body);
  if (!validation.isValid) return validation;
  const office = await createOffice(validation.sanitizedInput);
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: OFFICE_MESSAGES.OFFICE_CREATED,
    data: { office },
    auditDetails: { officeLocationId: office.id },
  };
});

/** PATCH /api/offices/:officeLocationId (including workday.weeklyOffRules) */
export const patchOffice = officeHandler('update_office', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'officeLocationId');
  if (invalidParams) return { validationErrors: invalidParams };
  const validation = validateOfficeChanges(req.body);
  if (!validation.isValid) return validation;
  const office = await updateOffice({ officeLocationId: req.params.officeLocationId, ...validation.sanitizedInput });
  return {
    message: OFFICE_MESSAGES.OFFICE_UPDATED,
    data: { office },
    auditDetails: { officeLocationId: office.id, changedFields: Object.keys(validation.sanitizedInput.changes) },
  };
});

/** DELETE /api/offices/:officeLocationId */
export const removeOffice = officeHandler('delete_office', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'officeLocationId');
  if (invalidParams) return { validationErrors: invalidParams };
  const office = await deleteOffice(req.params.officeLocationId);
  return { message: OFFICE_MESSAGES.OFFICE_DELETED, data: { office }, auditDetails: { officeLocationId: office.id } };
});

/** PUT /api/employees/:employeeId/office */
export const putEmployeeOffice = officeHandler('assign_employee_office', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'employeeId');
  if (invalidParams) return { validationErrors: invalidParams };
  const validation = validateOfficeAssignment(req.body);
  if (!validation.isValid) return validation;
  const assignment = await assignEmployeeOffice({
    employeeId: req.params.employeeId,
    officeLocationId: validation.sanitizedInput.officeLocationId,
  });
  return { message: OFFICE_MESSAGES.EMPLOYEE_OFFICE_ASSIGNED, data: { assignment }, auditDetails: assignment };
});
