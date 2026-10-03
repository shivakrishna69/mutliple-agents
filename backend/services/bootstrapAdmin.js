/**
 * First-administrator bootstrap for deployments without database access.
 *
 * BOOTSTRAP_ADMIN_EMAIL names the account that administers a fresh deployment:
 *   - signing up with that email creates an admin instead of a customer (authController), and
 *   - at every startup, if that account already exists with another role, it is promoted.
 * Promotion only ever raises that one account to admin; it never demotes anyone, and an admin
 * removed from the role by another admin is promoted back on the next restart, so remove or change
 * the variable once real administrators exist.
 */

import User, { ROLES } from '../models/User.js';
import { logger } from '../utils/logger.js';

/** Promotes the configured bootstrap admin if needed. Errors are logged, never fatal. */
export async function ensureBootstrapAdmin(bootstrapAdminEmail) {
  if (!bootstrapAdminEmail) return;
  try {
    const promotionResult = await User.updateOne(
      { email: bootstrapAdminEmail, role: { $ne: ROLES.ADMIN } },
      { $set: { role: ROLES.ADMIN } },
    );
    if (promotionResult.modifiedCount > 0) {
      logger.info('Bootstrap admin promoted', { email: bootstrapAdminEmail });
    }
  } catch (promotionError) {
    logger.error('Bootstrap admin promotion failed', { error: promotionError.message });
  }
}
