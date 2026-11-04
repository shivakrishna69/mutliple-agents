/**
 * Department endpoints (routes/departmentRoutes.js): HR and administrators list, add, change,
 * deactivate and remove departments. Every change is audited with ids and outcomes.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { DEPARTMENT_MESSAGES } from '../constants/messages.js';
import {
  createDepartment,
  deleteDepartment,
  getDepartment,
  listDepartments,
  updateDepartment,
} from '../services/departmentService.js';
import { validateDepartmentChanges, validateDepartmentCreation } from '../validators/departmentValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const departmentHandler = createWorkforceHandlerFactory({
  auditCategory: 'departments',
  restrictedMessage: DEPARTMENT_MESSAGES.RESTRICTED,
  inputInvalidMessage: DEPARTMENT_MESSAGES.INPUT_INVALID,
});

const ADMIN_READ = Object.freeze({ requiresWorkforceAdmin: true, isWrite: false });
const ADMIN_WRITE = Object.freeze({ requiresWorkforceAdmin: true, isWrite: true });

/** GET /api/departments?includeInactive=true */
export const getDepartments = departmentHandler('list_departments', ADMIN_READ, async (req) => ({
  message: DEPARTMENT_MESSAGES.DEPARTMENTS_RETRIEVED,
  data: { departments: await listDepartments({ includeInactive: req.query.includeInactive === 'true' }) },
}));

/** GET /api/departments/:departmentId */
export const getDepartmentById = departmentHandler('view_department', ADMIN_READ, async (req) => {
  const invalidParams = idParamErrors(req.params, 'departmentId');
  if (invalidParams) return { validationErrors: invalidParams };
  return {
    message: DEPARTMENT_MESSAGES.DEPARTMENT_RETRIEVED,
    data: { department: await getDepartment(req.params.departmentId) },
  };
});

/** POST /api/departments */
export const postDepartment = departmentHandler('create_department', ADMIN_WRITE, async (req) => {
  const validation = validateDepartmentCreation(req.body);
  if (!validation.isValid) return validation;
  const department = await createDepartment(validation.sanitizedInput);
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: DEPARTMENT_MESSAGES.DEPARTMENT_CREATED,
    data: { department },
    auditDetails: { departmentId: department.id },
  };
});

/** PATCH /api/departments/:departmentId (including isActive to deactivate or reactivate) */
export const patchDepartment = departmentHandler('update_department', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'departmentId');
  if (invalidParams) return { validationErrors: invalidParams };
  const validation = validateDepartmentChanges(req.body);
  if (!validation.isValid) return validation;
  const department = await updateDepartment({ departmentId: req.params.departmentId, ...validation.sanitizedInput });
  return {
    message: DEPARTMENT_MESSAGES.DEPARTMENT_UPDATED,
    data: { department },
    auditDetails: { departmentId: department.id, changedFields: Object.keys(validation.sanitizedInput.changes) },
  };
});

/** DELETE /api/departments/:departmentId */
export const removeDepartment = departmentHandler('delete_department', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'departmentId');
  if (invalidParams) return { validationErrors: invalidParams };
  const department = await deleteDepartment(req.params.departmentId);
  return {
    message: DEPARTMENT_MESSAGES.DEPARTMENT_DELETED,
    data: { department },
    auditDetails: { departmentId: department.id },
  };
});
