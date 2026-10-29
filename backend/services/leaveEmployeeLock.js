/**
 * Runs leave operations of one employee one at a time, across every server (models/LeaveEmployeeLock.js).
 *
 * Border (sandwich) charges depend on the employee's other approved requests, so an operation that
 * prices them or gives them back must not overlap another such operation for the same employee:
 * approving, cancelling approved leave, deciding a change, and the repair of border charges. Each
 * takes the employee's lease at its entry point; work done inside it (giving neighbours their
 * border days back) runs under the same lease and never takes it again.
 *
 * Taking the lease is one atomic update guarded by a unique index. A busy lease is retried for a
 * short while, then the caller is told to try again (409 REQUEST_BUSY). A lease left by a stopped
 * server expires after LEASE_MS; operations finish in well under that.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import LeaveEmployeeLock from '../models/LeaveEmployeeLock.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { ServiceError } from './serviceError.js';

/** How long a lease lasts if its holder never releases it (the server stopped). */
export const LEASE_MS = 60 * 1000;
/** How long an operation waits for a busy lease before asking the caller to try again. */
const MAX_WAIT_MS = 10 * 1000;
const RETRY_DELAY_MS = 40;

async function tryToTakeLease(employeeId, holder) {
  const now = new Date();
  try {
    const { modifiedCount, upsertedCount } = await LeaveEmployeeLock.updateOne(
      { employeeId, $or: [{ holder: null }, { expiresAt: { $lte: now } }] },
      { $set: { holder, expiresAt: new Date(now.getTime() + LEASE_MS) } },
      { upsert: true },
    );
    return modifiedCount + upsertedCount === 1;
  } catch (leaseError) {
    // The employee's lock document exists and is held: the upsert tried to create a second one.
    if (isDuplicateKeyError(leaseError)) return false;
    throw leaseError;
  }
}

/**
 * Runs `task` while holding the employee's leave lease.
 * @template T
 * @param {object|string} employeeId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @throws {ServiceError} 409 REQUEST_BUSY when the lease stays busy for MAX_WAIT_MS
 */
export async function withEmployeeLeaveLock(employeeId, task) {
  const holder = randomUUID();
  const giveUpAt = Date.now() + MAX_WAIT_MS;
  while (!(await tryToTakeLease(employeeId, holder))) {
    if (Date.now() >= giveUpAt) {
      throw new ServiceError(HTTP_STATUS.CONFLICT, 'REQUEST_BUSY', LEAVE_MESSAGES.REQUEST_BUSY);
    }
    // A little jitter, so waiting operations do not retry in step.
    await sleep(RETRY_DELAY_MS + Math.floor(Math.random() * RETRY_DELAY_MS));
  }
  try {
    return await task();
  } finally {
    await LeaveEmployeeLock.updateOne({ employeeId, holder }, { $set: { holder: null, expiresAt: null } });
  }
}
