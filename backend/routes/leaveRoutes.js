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
 *   POST   /jobs/reconcile                    bring balances back in line with the ledger
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
import { protect } from '../middleware/authMiddleware.js';
import { leaveAdminWriteRateLimitByUser } from '../middleware/rateLimiter.js';

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

export default leaveRouter;
