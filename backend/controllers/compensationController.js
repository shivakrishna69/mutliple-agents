/**
 * Annual CTC endpoints (routes/employeeRoutes.js; services/employeeCompensation.js), for
 * MANAGE_COMPENSATION (administrators, HR, Finance & Payroll):
 *
 *   GET /api/employees/compensation                current employees' annual CTC
 *   PUT /api/employees/:employeeId/compensation    { annualCtc, effectiveFrom? }
 *
 * Changes are audited with ids only, never the figure.
 */

import { CAPABILITIES } from '../constants/accessRoles.js';
import { COMPENSATION_MESSAGES } from '../constants/messages.js';
import { listEmployeeCompensation, setEmployeeCompensation } from '../services/employeeCompensation.js';
import { validateCompensationChange } from '../validators/taxValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const compensationHandler = createWorkforceHandlerFactory({
  auditCategory: 'compensation',
  restrictedMessage: COMPENSATION_MESSAGES.RESTRICTED,
  inputInvalidMessage: COMPENSATION_MESSAGES.INPUT_INVALID,
});

/** GET /api/employees/compensation */
export const getEmployeeCompensation = compensationHandler(
  'list_employee_compensation',
  { capability: CAPABILITIES.MANAGE_COMPENSATION, isWrite: false },
  async () => ({
    message: COMPENSATION_MESSAGES.COMPENSATION_RETRIEVED,
    data: { compensation: await listEmployeeCompensation() },
  }),
);

/** PUT /api/employees/:employeeId/compensation */
export const putEmployeeCompensation = compensationHandler(
  'set_employee_compensation',
  { capability: CAPABILITIES.MANAGE_COMPENSATION, isWrite: true },
  async (req) => {
    const invalidParams = idParamErrors(req.params, 'employeeId');
    if (invalidParams) return { validationErrors: invalidParams };
    const validation = validateCompensationChange(req.body);
    if (!validation.isValid) return validation;
    const compensation = await setEmployeeCompensation({
      employeeId: req.params.employeeId,
      ...validation.sanitizedInput,
      actorUserId: req.user.id,
    });
    return {
      message: COMPENSATION_MESSAGES.COMPENSATION_UPDATED,
      data: { compensation },
      auditDetails: { employeeId: compensation.employeeId },
    };
  },
);
