/**
 * Leave routes, mounted at /api/leave (controllers/leaveController.js says who may use each). All
 * require a signed-in session and the CSRF token on changes. Amounts are in days.
 *
 *   GET    /settings                          leave year start month and default time zone
 *   PATCH  /settings                          change them (send version; start month locks once used)
 *   GET    /types                             active leave types (?includeInactive=true for HR)
 *   POST   /types                             add a leave type
 *   PATCH  /types/:leaveTypeId                change a type's policy (send version; code is fixed)
 *   GET    /balances                          own balances (?leaveYear=, default the current one)
 *   GET    /ledger                            own ledger (?leaveYear=&leaveTypeId=)
 *   GET    /employees/:employeeId/balances    an employee's balances (HR)
 *   GET    /employees/:employeeId/ledger      an employee's ledger (HR)
 *   POST   /adjustments                       add or remove days (MANUAL) or grant them (ENTITLEMENT_GRANT)
 *   POST   /encashments                       pay out days through payroll
 *   POST   /jobs/accrual                      post due accruals and year ends now ({ asOfDate? })
 *   POST   /jobs/reconcile                    finish interrupted request changes; bring balances in line
 *
 *   POST   /requests/preview                  price a leave before asking (nothing is saved)
 *   POST   /requests                          ask for leave
 *   GET    /requests                          own requests (?leaveYear=&status=)
 *   GET    /requests/:requestId               one request (its employee, approver, or HR)
 *   POST   /requests/:requestId/cancel        withdraw a pending request / cancel leave not yet started
 *   POST   /requests/:requestId/change        once leave has started: ask to cancel or end it early
 *   POST   /requests/:requestId/approve       approver or HR ({ note? })
 *   POST   /requests/:requestId/reject        approver or HR ({ note })
 *   POST   /requests/:requestId/change/decision   approver or HR ({ approve, note? })
 *   GET    /approvals                         what the caller can decide (?queue=requests|changes)
 *   GET    /employees/:employeeId/requests    an employee's requests (HR)
 *   GET    /payroll-export                    unpaid and encashed days for a month (HR; ?month=&changedSince=)
 */

import { Router } from 'express';
import {
  getBalancesOfEmployee,
  getLedgerOfEmployee,
  getOwnBalances,
  getOwnLedger,
  getSettings,
  getTypes,
  patchSettings,
  patchType,
  postAccrualJobRun,
  postAdjustment,
  postEncashmentEntry,
  postReconcileRun,
  postType,
} from '../controllers/leaveController.js';
import {
  getApprovalQueue,
  getOwnRequests,
  getPayrollExport,
  getRequest,
  getRequestsOfEmployee,
  postApprove,
  postCancel,
  postChange,
  postChangeDecision,
  postPreview,
  postReject,
  postRequest,
} from '../controllers/leaveRequestController.js';
import { protect } from '../middleware/authMiddleware.js';
import { leaveAdminWriteRateLimitByUser, leaveRequestWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const leaveRouter = Router();

leaveRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
leaveRouter.get('/settings', getSettings);
leaveRouter.patch('/settings', leaveAdminWriteRateLimitByUser, patchSettings);
leaveRouter.get('/types', getTypes);
leaveRouter.post('/types', leaveAdminWriteRateLimitByUser, postType);
leaveRouter.patch('/types/:leaveTypeId', leaveAdminWriteRateLimitByUser, patchType);
leaveRouter.get('/balances', getOwnBalances);
leaveRouter.get('/ledger', getOwnLedger);
leaveRouter.get('/employees/:employeeId/balances', getBalancesOfEmployee);
leaveRouter.get('/employees/:employeeId/ledger', getLedgerOfEmployee);
leaveRouter.post('/adjustments', leaveAdminWriteRateLimitByUser, postAdjustment);
leaveRouter.post('/encashments', leaveAdminWriteRateLimitByUser, postEncashmentEntry);
leaveRouter.post('/jobs/accrual', leaveAdminWriteRateLimitByUser, postAccrualJobRun);
leaveRouter.post('/jobs/reconcile', leaveAdminWriteRateLimitByUser, postReconcileRun);
leaveRouter.post('/requests/preview', leaveRequestWriteRateLimitByUser, postPreview);
leaveRouter.post('/requests', leaveRequestWriteRateLimitByUser, postRequest);
leaveRouter.get('/requests', getOwnRequests);
leaveRouter.get('/requests/:requestId', getRequest);
leaveRouter.post('/requests/:requestId/cancel', leaveRequestWriteRateLimitByUser, postCancel);
leaveRouter.post('/requests/:requestId/change', leaveRequestWriteRateLimitByUser, postChange);
leaveRouter.post('/requests/:requestId/approve', leaveRequestWriteRateLimitByUser, postApprove);
leaveRouter.post('/requests/:requestId/reject', leaveRequestWriteRateLimitByUser, postReject);
leaveRouter.post('/requests/:requestId/change/decision', leaveRequestWriteRateLimitByUser, postChangeDecision);
leaveRouter.get('/approvals', getApprovalQueue);
leaveRouter.get('/employees/:employeeId/requests', getRequestsOfEmployee);
leaveRouter.get('/payroll-export', getPayrollExport);

export default leaveRouter;
