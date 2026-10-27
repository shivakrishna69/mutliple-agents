/**
 * Data migrations, run in order at every startup after MongoDB connects.
 *
 * Each migration must be idempotent: it only touches documents that still need it, so running it
 * again (a restart, or several instances starting together) changes nothing. A failure stops
 * startup, so the server never runs against data in a shape the code does not expect.
 */

import { logger } from '../utils/logger.js';
import addOfficeWeeklyOffRules from './addOfficeWeeklyOffRules.js';

/** In the order they must run. Add new migrations at the end. */
const MIGRATIONS = Object.freeze([addOfficeWeeklyOffRules]);

export async function runStartupMigrations() {
  for (const migration of MIGRATIONS) {
    const { changedCount } = await migration.run();
    if (changedCount > 0) logger.info('Migration applied', { migration: migration.name, changedCount });
  }
}
