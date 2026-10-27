/**
 * Posting leave movements and keeping balances in step with the ledger, without multi-document
 * transactions (see models/LeaveBalance.js for the bookkeeping fields).
 *
 *   Credits   postCredit: the ledger entry is written first (its unique key makes a second post of
 *             the same accrual or year-end movement impossible), then applied to the balance.
 *   Debits    postDebit (anything that lowers the available days: a debit, an encashment, a
 *             request's hold or its confirmed debit): the change is reserved on the balance first,
 *             in one conditional update that refuses to take the available days below the allowed
 *             minimum (so two requests at once cannot overdraw), then the ledger entry is written.
 *             If writing the entry fails, the reservation is reversed straight away.
 *   Repair    reconcileLeaveBalances applies entries a balance is missing, reverses reservations
 *             whose ledger entry was never written (the server stopped in between), and corrects
 *             totals that do not match the applied entries.
 */

import mongoose from 'mongoose';
import LeaveBalance from '../models/LeaveBalance.js';
import LeaveLedgerEntry, { LEDGER_ENTRY_TYPES } from '../models/LeaveLedgerEntry.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';

/** A reservation older than this without its ledger entry is treated as abandoned by reconciliation. */
export const ABANDONED_RESERVATION_AGE_MS = 10 * 60 * 1000;

/** Thrown by postDebit when the balance cannot cover the debit. */
export class InsufficientLeaveBalanceError extends Error {
  constructor(availableCentidays) {
    super('The leave balance is not enough for this');
    this.name = 'InsufficientLeaveBalanceError';
    this.availableCentidays = availableCentidays;
  }
}

/** Thrown when a movement with the same unique key (accrual period, payroll reference...) exists. */
export class DuplicateLedgerEntryError extends Error {
  constructor() {
    super('This movement has already been recorded');
    this.name = 'DuplicateLedgerEntryError';
  }
}

const balanceKeyOf = ({ employeeId, leaveTypeId, leaveYear }) => ({ employeeId, leaveTypeId, leaveYear });

function appliedEntryOf(entryId, { balanceDeltaCentidays, heldDeltaCentidays = 0 }) {
  return { entryId, balanceDeltaCentidays, heldDeltaCentidays, appliedAt: new Date() };
}

/** Counts the entry in its balance once, creating the balance on first use. */
async function applyToBalance(balanceKey, appliedEntry) {
  const notYetApplied = { ...balanceKey, 'appliedEntries.entryId': { $ne: appliedEntry.entryId } };
  const update = {
    $inc: { balanceCentidays: appliedEntry.balanceDeltaCentidays, heldCentidays: appliedEntry.heldDeltaCentidays },
    $push: { appliedEntries: appliedEntry },
  };
  try {
    await LeaveBalance.updateOne(notYetApplied, update, { upsert: true });
  } catch (upsertError) {
    if (!isDuplicateKeyError(upsertError)) throw upsertError;
    // The balance exists: either it already counts this entry (nothing matches, nothing changes)
    // or another writer created it a moment ago (this applies the entry to it).
    await LeaveBalance.updateOne(notYetApplied, update);
  }
}

/** Creates an empty balance if there is none, so a conditional debit has a document to test. */
async function ensureBalanceExists(balanceKey) {
  try {
    await LeaveBalance.updateOne(
      balanceKey,
      { $setOnInsert: { balanceCentidays: 0, heldCentidays: 0 } },
      { upsert: true },
    );
  } catch (upsertError) {
    if (!isDuplicateKeyError(upsertError)) throw upsertError;
  }
}

/** The filter that finds the existing entry behind a duplicate-key error. */
function uniqueKeyFilter(fields) {
  if (fields.idempotencyKey) return { idempotencyKey: fields.idempotencyKey };
  const base = { employeeId: fields.employeeId, leaveTypeId: fields.leaveTypeId };
  if (fields.yearEndKind) return { ...base, leaveYear: fields.leaveYear, yearEndKind: fields.yearEndKind };
  if (fields.entryType === LEDGER_ENTRY_TYPES.ACCRUAL) {
    return { ...base, entryType: fields.entryType, accrualPeriod: fields.accrualPeriod };
  }
  if (fields.entryType === LEDGER_ENTRY_TYPES.ENCASHMENT) {
    return { ...base, entryType: fields.entryType, payrollReference: fields.payrollReference };
  }
  return null;
}

/**
 * Posts a credit (or a system movement sized from the balance itself, such as year end).
 * Posting the same accrual period or year-end movement again changes nothing.
 * @returns {Promise<{ entry: object, isNew: boolean }>}
 */
export async function postCredit(fields) {
  let entry;
  let isNew = true;
  try {
    entry = await LeaveLedgerEntry.create(fields);
  } catch (createError) {
    const existingFilter = isDuplicateKeyError(createError) ? uniqueKeyFilter(fields) : null;
    if (!existingFilter) throw createError;
    entry = await LeaveLedgerEntry.findOne(existingFilter);
    isNew = false;
  }
  // Applied even when the entry already existed: an earlier attempt may have stopped before this.
  await applyToBalance(balanceKeyOf(entry), appliedEntryOf(entry._id, entry));
  return { entry, isNew };
}

/**
 * Posts a movement that lowers the available days (balance - held) only if, afterwards, they stay
 * at or above `minimumAvailableCentidays` (0, or minus the type's negative limit; pass
 * -Infinity for a movement that must post regardless, such as one already approved).
 * @throws {InsufficientLeaveBalanceError | DuplicateLedgerEntryError}
 */
export async function postDebit(fields, { minimumAvailableCentidays = 0 } = {}) {
  // Already posted under this key: report it before reserving anything.
  if (fields.idempotencyKey && (await LeaveLedgerEntry.exists({ idempotencyKey: fields.idempotencyKey }))) {
    throw new DuplicateLedgerEntryError();
  }
  const entryId = new mongoose.Types.ObjectId();
  const balanceKey = balanceKeyOf(fields);
  const heldDeltaCentidays = fields.heldDeltaCentidays ?? 0;
  const debitCentidays = heldDeltaCentidays - fields.balanceDeltaCentidays;
  await ensureBalanceExists(balanceKey);
  const coversDebit = Number.isFinite(minimumAvailableCentidays)
    ? {
        $expr: {
          $gte: [
            { $subtract: [{ $subtract: ['$balanceCentidays', '$heldCentidays'] }, debitCentidays] },
            minimumAvailableCentidays,
          ],
        },
      }
    : {};
  const reservation = await LeaveBalance.updateOne(
    { ...balanceKey, ...coversDebit },
    {
      $inc: { balanceCentidays: fields.balanceDeltaCentidays, heldCentidays: heldDeltaCentidays },
      $push: { appliedEntries: appliedEntryOf(entryId, fields) },
    },
  );
  if (reservation.modifiedCount === 0) {
    const balance = await LeaveBalance.findOne(balanceKey).lean();
    throw new InsufficientLeaveBalanceError(balance ? balance.balanceCentidays - balance.heldCentidays : 0);
  }
  try {
    const entry = await LeaveLedgerEntry.create({ ...fields, _id: entryId });
    return { entry };
  } catch (createError) {
    await LeaveBalance.updateOne(
      { ...balanceKey, 'appliedEntries.entryId': entryId },
      {
        $inc: { balanceCentidays: -fields.balanceDeltaCentidays, heldCentidays: -heldDeltaCentidays },
        $pull: { appliedEntries: { entryId } },
      },
    );
    if (isDuplicateKeyError(createError)) throw new DuplicateLedgerEntryError();
    throw createError;
  }
}

/**
 * Brings every balance back in line with the ledger. Safe to run at any time, as often as wanted.
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ balancesChecked: number, missingApplied: number, abandonedReversed: number, totalsCorrected: number }>}
 */
export async function reconcileLeaveBalances({ now = new Date() } = {}) {
  const summary = { balancesChecked: 0, missingApplied: 0, abandonedReversed: 0, totalsCorrected: 0 };

  // Ledger entries no balance counts yet.
  const entryGroups = await LeaveLedgerEntry.aggregate([
    {
      $group: {
        _id: { employeeId: '$employeeId', leaveTypeId: '$leaveTypeId', leaveYear: '$leaveYear' },
        entryIds: { $push: '$_id' },
      },
    },
  ]);
  for (const { _id: balanceKey, entryIds } of entryGroups) {
    const balance = await LeaveBalance.findOne(balanceKey).select('+appliedEntries').lean();
    const appliedIds = new Set((balance?.appliedEntries ?? []).map((applied) => applied.entryId.toString()));
    const missingIds = entryIds.filter((entryId) => !appliedIds.has(entryId.toString()));
    if (missingIds.length === 0) continue;
    const missingEntries = await LeaveLedgerEntry.find({ _id: { $in: missingIds } }).lean();
    for (const entry of missingEntries) {
      await applyToBalance(balanceKey, appliedEntryOf(entry._id, entry));
      summary.missingApplied += 1;
    }
  }

  // Applied reservations whose entry was never written, and totals that drifted.
  const abandonedBefore = new Date(now.getTime() - ABANDONED_RESERVATION_AGE_MS);
  for await (const balance of LeaveBalance.find({}).select('+appliedEntries').lean().cursor()) {
    summary.balancesChecked += 1;
    const appliedIds = balance.appliedEntries.map((applied) => applied.entryId);
    const existingIds = new Set(
      (
        await LeaveLedgerEntry.find({ _id: { $in: appliedIds } })
          .select('_id')
          .lean()
      ).map((entry) => entry._id.toString()),
    );
    for (const applied of balance.appliedEntries) {
      if (existingIds.has(applied.entryId.toString()) || applied.appliedAt > abandonedBefore) continue;
      await LeaveBalance.updateOne(
        { _id: balance._id, 'appliedEntries.entryId': applied.entryId },
        {
          $inc: { balanceCentidays: -applied.balanceDeltaCentidays, heldCentidays: -applied.heldDeltaCentidays },
          $pull: { appliedEntries: { entryId: applied.entryId } },
        },
      );
      summary.abandonedReversed += 1;
    }
    const fresh = await LeaveBalance.findById(balance._id).select('+appliedEntries').lean();
    const expectedBalance = fresh.appliedEntries.reduce((total, applied) => total + applied.balanceDeltaCentidays, 0);
    const expectedHeld = fresh.appliedEntries.reduce((total, applied) => total + applied.heldDeltaCentidays, 0);
    if (fresh.balanceCentidays !== expectedBalance || fresh.heldCentidays !== expectedHeld) {
      await LeaveBalance.updateOne(
        { _id: fresh._id, updatedAt: fresh.updatedAt },
        { $set: { balanceCentidays: expectedBalance, heldCentidays: expectedHeld } },
      );
      summary.totalsCorrected += 1;
    }
  }
  return summary;
}
