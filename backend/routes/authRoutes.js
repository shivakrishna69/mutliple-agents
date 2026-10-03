/**
 * Authentication routes, mounted in server.js under `/api/auth`:
 *
 *   POST /api/auth/signup  -> signup rate limit -> registerUser    (public)
 *   POST /api/auth/login   -> login rate limits -> loginUser       (public)
 *   GET  /api/auth/me      -> protect           -> getCurrentUser  (session required)
 *   POST /api/auth/logout  -> protect           -> logoutUser      (session + CSRF token required)
 *
 * The login route applies two limits in order: per client IP first (cheap, stops one source
 * from trying many accounts), then per IP-and-email (stops guessing one account's password).
 * Request-body parsing (express.json, 1 MB limit) is applied globally in server.js, before
 * these routes, so the per-email limiter can read `req.body.email`.
 */

import { Router } from 'express';
import { getCurrentUser, loginUser, logoutUser, registerUser } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import {
  loginRateLimitByClientIp,
  loginRateLimitByClientIpAndEmail,
  signupRateLimitByClientIp,
} from '../middleware/rateLimiter.js';

const authRouter = Router();

authRouter.post('/signup', signupRateLimitByClientIp, registerUser);
authRouter.post('/login', loginRateLimitByClientIp, loginRateLimitByClientIpAndEmail, loginUser);
authRouter.get('/me', protect, getCurrentUser);
authRouter.post('/logout', protect, logoutUser);

export default authRouter;
