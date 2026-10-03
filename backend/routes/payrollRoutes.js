/**
 * Payroll routes, mounted in server.js under `/api/payroll`.
 *
 *   Public (no session; rate-limited per client IP)
 *     GET  /payslips/verify/:verificationId   authenticity check by the ID printed on a payslip
 *
 *   Signed in (protect: session cookie, plus the CSRF token on POST)
 *     GET  /rules                             form options for the tax estimate
 *     POST /tax-estimate                      income tax under both regimes plus EPF, ESI and PT
 *     POST /payslips                          generate a payslip PDF (HR and admins)
 *     GET  /payslips                          list payslips (own; HR and admins: anyone's)
 *     GET  /payslips/:payslipId/download      60-second pre-signed download link
 *
 * The public route is registered before `protect`, so it is the only one reachable without a
 * session. Every response carries Cache-Control: no-store because it may contain salary figures.
 */

import { Router } from 'express';
import { createPayslip, createTaxEstimate, downloadPayslip, getPayrollRules, listPayslips, verifyPayslipById } from '../controllers/payrollController.js';
import { protect } from '../middleware/authMiddleware.js';
import { payslipGenerationRateLimitByUser, payslipVerificationRateLimitByClientIp, taxEstimateRateLimitByUser } from '../middleware/rateLimiter.js';

const payrollRouter = Router();

payrollRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---- Public ----------------------------------------------------------------------------------
payrollRouter.get('/payslips/verify/:verificationId', payslipVerificationRateLimitByClientIp, verifyPayslipById);

// ---- Signed in -------------------------------------------------------------------------------
payrollRouter.use(protect);
payrollRouter.get('/rules', getPayrollRules);
payrollRouter.post('/tax-estimate', taxEstimateRateLimitByUser, createTaxEstimate);
payrollRouter.post('/payslips', payslipGenerationRateLimitByUser, createPayslip);
payrollRouter.get('/payslips', listPayslips);
payrollRouter.get('/payslips/:payslipId/download', downloadPayslip);

export default payrollRouter;
