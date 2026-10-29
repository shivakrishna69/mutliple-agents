/**
 * Carrying out a leave request's changes safely without multi-document transactions.
 *
 * Each change after submission (approve, reject, withdraw, cancel, decide a change, give back a
 * border charge) runs in three steps:
 *   1. lock      one atomic update sets `processing` on the request, but only if it is still in
 *                the state the change was worked out from (status and version) and no other
 *                change is running. `processing` holds the ledger movement to post and the fields
 *                to set, as plain data.
 *   2. post      the movement is posted under its idempotency key "<requestId>:<movement>", so
 *                posting it twice changes nothing (services/leaveLedger.js). A debit that the
 *                balance cannot cover unlocks the request unchanged.
 *   3. commit    the fields are set and the lock cleared, matched on the lock's id.
 * Then the request's surplus day claims are deleted, and requests whose border charges depended on
 * it are given those days back. Operations that price or give back border charges run under the
 * employee's leave lease (services/leaveEmployeeLock.js), taken by their entry points; the functions
 * here never take it themselves, so the work they do for such an operation stays inside its lease.
 *
 * If the server stops part-way, repairLeaveRequests (hourly, and on demand) completes the same
 * steps from what `processing` recorded, and cleans up after a submission that stopped before the
 * request was saved: its claims, and its hold.
 */

import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import LeaveDayClaim from '../models/LeaveDayClaim.js';
import LeaveLedgerEntry, { ADJUSTMENT_REASON_CODES, LEDGER_ENTRY_TYPES } from '../models/LeaveLedgerEntry.js';
import LeaveRequest, { LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import { withEmployeeLeaveLock } from './leaveEmployeeLock.js';
import {
  ABANDONED_RESERVATION_AGE_MS,
  DuplicateLedgerEntryError,
  InsufficientLeaveBalanceError,
  postCredit,
  postDebit,
} from './leaveLedger.js';
import { borderingNeighbourIds, claimedHalvesOf } from './leaveRequestPricing.js';

export const REQUEST_OPERATIONS = Object.freeze({
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  WITHDRAW: 'WITHDRAW',
  CANCEL: 'CANCEL',
  DECIDE_CHANGE: 'DECIDE_CHANGE',
  NEIGHBOUR_CREDIT: 'NEIGHBOUR_CREDIT',
});

export const OPERATION_OUTCOMES = Object.freeze({ COMPLETED: 'completed', INSUFFICIENT: 'insufficient' });

const OPEN_STATUSES = Object.freeze([LEAVE_REQUEST_STATUSES.PENDING, LEAVE_REQUEST_STATUSES.APPROVED]);

/** The idempotency key of one movement of a request. */
export const requestMovementKey = (requestId, ...movement) => [requestId.toString(), ...movement].join(':');

/** Ledger fields every movement of `request` shares. */
function movementFields(request, { effectiveDate, idempotencyKey, createdByUserId }) {
  return {
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    leaveYear: request.leaveYear,
    leaveRequestId: request._id,
    effectiveDate,
    idempotencyKey,
    createdByUserId,
  };
}

/** A movement that gives held days back (reject, withdraw, approval of a request that costs nothing). */
export function releaseHoldPosting(request, { effectiveDate, createdByUserId }) {
  if (!request.tracksBalance || request.holdCentidays === 0) return null;
  return {
    isDebit: false,
    fields: {
      ...movementFields(request, {
        effectiveDate,
        idempotencyKey: requestMovementKey(request._id, 'RELEASE'),
        createdByUserId,
      }),
      entryType: LEDGER_ENTRY_TYPES.RELEASE_HOLD,
      balanceDeltaCentidays: 0,
      heldDeltaCentidays: -request.holdCentidays,
    },
  };
}

/** The approval debit: uses the hold and charges the price, if the balance allows. */
export function confirmDebitPosting(request, { chargedCentidays, minimumAvailableCentidays, createdByUserId }) {
  return {
    isDebit: true,
    minimumAvailableCentidays,
    fields: {
      ...movementFields(request, {
        effectiveDate: request.startDate,
        idempotencyKey: requestMovementKey(request._id, 'CONFIRM'),
        createdByUserId,
      }),
      entryType: LEDGER_ENTRY_TYPES.CONFIRM_DEBIT,
      balanceDeltaCentidays: -chargedCentidays,
      heldDeltaCentidays: -request.holdCentidays,
    },
  };
}

/** Days given back to the balance (cancelled, shortened, or a border charge that no longer applies). */
export function cancellationCreditPosting(request, { creditCentidays, movement, effectiveDate, createdByUserId }) {
  if (!request.tracksBalance || creditCentidays <= 0) return null;
  return {
    isDebit: false,
    fields: {
      ...movementFields(request, {
        effectiveDate,
        idempotencyKey: requestMovementKey(request._id, ...movement),
        createdByUserId,
      }),
      entryType: LEDGER_ENTRY_TYPES.ADJUSTMENT,
      reasonCode: ADJUSTMENT_REASON_CODES.CANCELLATION_CREDIT,
      balanceDeltaCentidays: creditCentidays,
    },
  };
}

/**
 * Step 1: locks the request for `operation` if it still has `status` and `version`.
 * @param {{ set: object, push?: object, releasesClaims?: boolean, affectsNeighbours?: boolean }} result
 * @returns {Promise<object|null>} the locked request (lean), or null when it changed meanwhile
 */
export function lockRequest({ requestId, status, version }, { operation, posting, result }) {
  return LeaveRequest.findOneAndUpdate(
    { _id: requestId, status, __v: version, processing: null },
    {
      $set: {
        processing: { lockId: randomUUID(), operation, startedAt: new Date(), posting: posting ?? null, result },
      },
    },
    { new: true },
  ).lean();
}

async function postMovement({ isDebit, minimumAvailableCentidays, fields }) {
  if (!isDebit) {
    await postCredit(fields);
    return;
  }
  try {
    await postDebit(fields, { minimumAvailableCentidays: minimumAvailableCentidays ?? -Infinity });
  } catch (debitError) {
    // Posted by an earlier attempt at this same operation.
    if (!(debitError instanceof DuplicateLedgerEntryError)) throw debitError;
  }
}

/** Deletes the request's claims outside the days it still occupies (all of them once closed). */
export async function releaseSurplusClaims(requestId) {
  const request = await LeaveRequest.findById(requestId).lean();
  if (!request) return 0;
  const keptHalves = OPEN_STATUSES.includes(request.status)
    ? new Set(claimedHalvesOf(request).map(({ date, half }) => `${date}:${half}`))
    : new Set();
  const claims = await LeaveDayClaim.find({ leaveRequestId: request._id }).select('date half').lean();
  const surplusIds = claims.filter((claim) => !keptHalves.has(`${claim.date}:${claim.half}`)).map((claim) => claim._id);
  if (surplusIds.length > 0) await LeaveDayClaim.deleteMany({ _id: { $in: surplusIds } });
  // Only if nothing changed the request meanwhile; otherwise the next pass looks again.
  await LeaveRequest.updateOne(
    { _id: request._id, __v: request.__v, hasClaimsToRelease: true },
    { $set: { hasClaimsToRelease: false } },
  );
  return surplusIds.length;
}

/**
 * Steps 2 and 3 for a locked request, then the follow-up work.
 * @returns {Promise<'completed'|'insufficient'>}
 */
export async function completeOperation(lockedRequest) {
  const { lockId, posting, result } = lockedRequest.processing;
  const lockFilter = { _id: lockedRequest._id, 'processing.lockId': lockId };
  if (posting) {
    try {
      await postMovement(posting);
    } catch (postError) {
      if (!(postError instanceof InsufficientLeaveBalanceError)) throw postError;
      await LeaveRequest.updateOne(lockFilter, { $set: { processing: null } });
      return OPERATION_OUTCOMES.INSUFFICIENT;
    }
  }
  const update = { $set: { ...result.set, processing: null }, $inc: { __v: 1 } };
  if (result.push) update.$push = result.push;
  await LeaveRequest.updateOne(lockFilter, update);
  if (result.releasesClaims) await releaseSurplusClaims(lockedRequest._id);
  if (result.affectsNeighbours) await creditNeighboursOf(lockedRequest._id);
  return OPERATION_OUTCOMES.COMPLETED;
}

/**
 * Gives `request` back the border days it was charged because of `neighbourId`, if that leave no
 * longer borders it (cancelled, or shortened away). Skipped while the request is busy; the repair
 * job comes back to it.
 * @returns {Promise<boolean>} whether days were given back
 */
async function settleBorderWith(request, neighbourId) {
  const chargesForNeighbour = request.borderCharges.filter((charge) => charge.neighbourRequestId.equals(neighbourId));
  if (chargesForNeighbour.length === 0) return false;
  if ((await borderingNeighbourIds(request)).has(neighbourId.toString())) return false;
  const creditCentidays = chargesForNeighbour.reduce((total, charge) => total + charge.chargedCentidays, 0);
  const lockedRequest = await lockRequest(
    { requestId: request._id, status: LEAVE_REQUEST_STATUSES.APPROVED, version: request.__v },
    {
      operation: REQUEST_OPERATIONS.NEIGHBOUR_CREDIT,
      posting: cancellationCreditPosting(request, {
        creditCentidays,
        movement: ['NEIGHBOUR', neighbourId.toString()],
        effectiveDate: chargesForNeighbour[0].date,
        createdByUserId: null,
      }),
      result: {
        set: {
          borderCharges: request.borderCharges.filter((charge) => !charge.neighbourRequestId.equals(neighbourId)),
          chargedCentidays: request.chargedCentidays - creditCentidays,
        },
      },
    },
  );
  if (!lockedRequest) return false;
  return (await completeOperation(lockedRequest)) === OPERATION_OUTCOMES.COMPLETED;
}

/** Settles the border charges other approved requests carry because of `neighbourId`. */
export async function creditNeighboursOf(neighbourId) {
  const dependants = await LeaveRequest.find({
    'borderCharges.neighbourRequestId': neighbourId,
    status: LEAVE_REQUEST_STATUSES.APPROVED,
    processing: null,
  }).lean();
  let credited = 0;
  for (const dependant of dependants) {
    if (await settleBorderWith(dependant, neighbourId)) credited += 1;
  }
  return credited;
}

/**
 * Brings every leave request in line with its ledger and claims. Safe to run at any time.
 * @param {{ now?: Date }} [options]
 */
export async function repairLeaveRequests({ now = new Date() } = {}) {
  const summary = {
    operationsCompleted: 0,
    operationsUndone: 0,
    claimsReleased: 0,
    orphanClaimsDeleted: 0,
    orphanHoldsReleased: 0,
    borderChargesCredited: 0,
  };
  const abandonedBefore = new Date(now.getTime() - ABANDONED_RESERVATION_AGE_MS);

  // Operations the server stopped in the middle of; finishing one may give neighbours their border
  // days back, so it holds the employee's lease like the operation it completes.
  for (const lockedRequest of await LeaveRequest.find({ 'processing.startedAt': { $lt: abandonedBefore } }).lean()) {
    const outcome = await withEmployeeLeaveLock(lockedRequest.employeeId, () => completeOperation(lockedRequest));
    if (outcome === OPERATION_OUTCOMES.COMPLETED) summary.operationsCompleted += 1;
    else summary.operationsUndone += 1;
  }

  // Claims of requests that gave days up.
  for (const request of await LeaveRequest.find({ hasClaimsToRelease: true, updatedAt: { $lt: abandonedBefore } })
    .select('_id')
    .lean()) {
    summary.claimsReleased += await releaseSurplusClaims(request._id);
  }

  // A submission that stopped before its request was saved: its claims and its hold.
  const existingRequestIds = async (requestIds) =>
    new Set(
      (
        await LeaveRequest.find({ _id: { $in: requestIds } })
          .select('_id')
          .lean()
      ).map((request) => request._id.toString()),
    );
  const claimedRequestIds = await LeaveDayClaim.distinct('leaveRequestId', { createdAt: { $lt: abandonedBefore } });
  const requestsWithClaims = await existingRequestIds(claimedRequestIds);
  const orphanClaimRequestIds = claimedRequestIds.filter((requestId) => !requestsWithClaims.has(requestId.toString()));
  if (orphanClaimRequestIds.length > 0) {
    const { deletedCount } = await LeaveDayClaim.deleteMany({ leaveRequestId: { $in: orphanClaimRequestIds } });
    summary.orphanClaimsDeleted += deletedCount;
  }
  const heldRequestIds = await LeaveLedgerEntry.distinct('leaveRequestId', {
    entryType: LEDGER_ENTRY_TYPES.HOLD,
    createdAt: { $lt: abandonedBefore },
  });
  const requestsWithHolds = await existingRequestIds(heldRequestIds);
  for (const requestId of heldRequestIds.filter((heldId) => !requestsWithHolds.has(heldId.toString()))) {
    const hold = await LeaveLedgerEntry.findOne({
      leaveRequestId: requestId,
      entryType: LEDGER_ENTRY_TYPES.HOLD,
    }).lean();
    const { isNew } = await postCredit({
      employeeId: hold.employeeId,
      leaveTypeId: hold.leaveTypeId,
      leaveYear: hold.leaveYear,
      leaveRequestId: requestId,
      entryType: LEDGER_ENTRY_TYPES.RELEASE_HOLD,
      balanceDeltaCentidays: 0,
      heldDeltaCentidays: -hold.heldDeltaCentidays,
      effectiveDate: hold.effectiveDate,
      idempotencyKey: requestMovementKey(requestId, 'RELEASE'),
      createdByUserId: null,
    });
    if (isNew) summary.orphanHoldsReleased += 1;
  }

  // Border charges whose neighbouring leave was cancelled or shortened.
  const bordered = await LeaveRequest.find({
    status: LEAVE_REQUEST_STATUSES.APPROVED,
    processing: null,
    'borderCharges.0': { $exists: true },
  }).lean();
  for (const request of bordered) {
    const neighbourIds = [...new Set(request.borderCharges.map((charge) => charge.neighbourRequestId.toString()))];
    await withEmployeeLeaveLock(request.employeeId, async () => {
      for (const neighbourId of neighbourIds) {
        // Re-read: settling the previous neighbour changed the request and its version.
        const current = await LeaveRequest.findOne({ _id: request._id, processing: null }).lean();
        if (current && (await settleBorderWith(current, new mongoose.Types.ObjectId(neighbourId)))) {
          summary.borderChargesCredited += 1;
        }
      }
    });
  }
  return summary;
}
