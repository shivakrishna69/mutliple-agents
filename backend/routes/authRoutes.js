/**
 * Authentication routes, mounted in server.js under `/api/auth`:
 *
 *   POST /api/auth/signup                -> signup IP limit        -> registerUser             (public)
 *   POST /api/auth/verify-email/resend   -> account email IP limit -> resendVerificationEmail  (public)
 *   POST /api/auth/verify-email          -> link-use IP limit      -> confirmEmail             (public)
 *   POST /api/auth/password/forgot       -> account email IP limit -> forgotPassword           (public)
 *   GET  /api/auth/password/reset/:token -> link-use IP limit      -> describePasswordResetLink (public)
 *   POST /api/auth/password/reset        -> link-use IP limit      -> applyPasswordReset       (public)
 *   GET  /api/auth/password-policy                                -> getPasswordPolicy        (public)
 *   GET  /api/auth/options                                        -> getAuthOptions           (public)
 *   POST /api/auth/login   -> login rate limits -> loginUser       (public)
 *   GET  /api/auth/me      -> protect           -> getCurrentUser  (session required)
 *   POST /api/auth/logout  -> protect           -> logoutUser      (session + CSRF token required)
 *   POST /api/auth/password -> protect -> login IP rate limit -> changePassword (session + CSRF token)
 *
 * The login route applies two limits in order: per client IP first (cheap, stops one source
 * from trying many accounts), then per IP-and-email (stops guessing one account's password).
 * IP limits key on req.ip, which trusts X-Forwarded-For for exactly TRUST_PROXY_HOPS proxies.
 * Emails to one address are also spaced out (services/emailCooldown.js), whatever the IP.
 * Request-body parsing (express.json, 1 MB limit) is applied globally in server.js, before
 * these routes, so the per-email limiter can read `req.body.email`.
 */

import { Router } from 'express';
import {
  applyPasswordReset,
  confirmEmail,
  describePasswordResetLink,
  forgotPassword,
  registerUser,
  resendVerificationEmail,
} from '../controllers/accountEmailController.js';
import {
  changePassword,
  getCurrentUser,
  getAuthOptions,
  getPasswordPolicy,
  loginUser,
  logoutUser,
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import {
  accountEmailRequestRateLimitByClientIp,
  accountLinkUseRateLimitByClientIp,
  loginRateLimitByClientIp,
  loginRateLimitByClientIpAndEmail,
  signupRateLimitByClientIp,
} from '../middleware/rateLimiter.js';

const authRouter = Router();

authRouter.post('/signup', signupRateLimitByClientIp, registerUser);
authRouter.post('/verify-email/resend', accountEmailRequestRateLimitByClientIp, resendVerificationEmail);
authRouter.post('/verify-email', accountLinkUseRateLimitByClientIp, confirmEmail);
authRouter.post('/password/forgot', accountEmailRequestRateLimitByClientIp, forgotPassword);
authRouter.get('/password/reset/:token', accountLinkUseRateLimitByClientIp, describePasswordResetLink);
authRouter.post('/password/reset', accountLinkUseRateLimitByClientIp, applyPasswordReset);
authRouter.get('/password-policy', getPasswordPolicy);
authRouter.get('/options', getAuthOptions);
authRouter.post('/login', loginRateLimitByClientIp, loginRateLimitByClientIpAndEmail, loginUser);
authRouter.get('/me', protect, getCurrentUser);
authRouter.post('/logout', protect, logoutUser);
// Rate-limited like login: it checks a password, so it must not become a guessing oracle.
authRouter.post('/password', protect, loginRateLimitByClientIp, changePassword);

export default authRouter;
