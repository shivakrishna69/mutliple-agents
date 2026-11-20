/**
 * The annual CTC migration (migrations/addEmployeeCompensation.js) on a real MongoDB: employees hired
 * through a sent offer (DISPATCHED, or DISPATCH_FAILED: created, email not sent) get the latest such
 * offer's CTC from its joining date; drafts never sent, cancelled ones and CTCs already set are left
 * alone; running it again changes nothing.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

import addEmployeeCompensation from '../../migrations/addEmployeeCompensation.js';
import { MONGO_BASE_URL, mongoUnavailableReason } from './testServer.js';

const mongoReason = await mongoUnavailableReason();

describe('annual CTC migration', { skip: mongoReason ?? false }, () => {
  let database;
  const ids = Object.fromEntries(
    ['sent', 'failed', 'pending', 'cancelled', 'alreadySet', 'resent', 'hr'].map((key) => [
      key,
      new mongoose.Types.ObjectId(),
    ]),
  );
  const offer = ({ userId, status, annualCtc, joining = '2026-06-01', updatedAt = '2026-05-01' }) => ({
    status,
    compensation: { annualCtc },
    position: { dateOfJoining: new Date(`${joining}T00:00:00Z`) },
    dispatch: { employeeUserId: userId, dispatchedByUserId: ids.hr },
    updatedAt: new Date(`${updatedAt}T00:00:00Z`),
  });
  const profileOf = (userId) => database.collection('employeeprofiles').findOne({ userId });

  before(async () => {
    await mongoose.connect(`${MONGO_BASE_URL}/nsk_test_ctc_${process.pid}_${randomBytes(4).toString('hex')}`);
    database = mongoose.connection.db;
    await database.collection('employeeprofiles').insertMany([
      { userId: ids.sent, organizationData: { designation: 'Engineer' } },
      { userId: ids.failed, organizationData: { designation: 'Engineer' } },
      { userId: ids.pending, organizationData: { designation: 'Engineer' } },
      { userId: ids.cancelled, organizationData: { designation: 'Engineer' } },
      {
        userId: ids.alreadySet,
        organizationData: { designation: 'Engineer' },
        compensation: { annualCtc: 3_000_000, source: 'manual' },
      },
      { userId: ids.resent, organizationData: { designation: 'Engineer' } },
    ]);
    await database
      .collection('onboardingdrafts')
      .insertMany([
        offer({ userId: ids.sent, status: 'DISPATCHED', annualCtc: 1_500_000 }),
        offer({ userId: ids.failed, status: 'DISPATCH_FAILED', annualCtc: 900_000, joining: '2026-07-15' }),
        offer({ userId: ids.pending, status: 'PENDING_REVIEW', annualCtc: 2_000_000 }),
        offer({ userId: ids.cancelled, status: 'CANCELLED', annualCtc: 2_000_000 }),
        offer({ userId: ids.alreadySet, status: 'DISPATCHED', annualCtc: 1_000_000 }),
        offer({ userId: ids.resent, status: 'DISPATCHED', annualCtc: 1_100_000, updatedAt: '2026-04-01' }),
        offer({ userId: ids.resent, status: 'DISPATCHED', annualCtc: 1_300_000, updatedAt: '2026-05-10' }),
      ]);
  });

  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('copies the latest sent offer’s CTC onto employees without one, once', async () => {
    const { changedCount } = await addEmployeeCompensation.run();
    assert.equal(changedCount, 3);

    const sent = await profileOf(ids.sent);
    assert.equal(sent.compensation.annualCtc, 1_500_000);
    assert.equal(sent.compensation.source, 'offer');
    assert.equal(sent.compensation.effectiveFrom.toISOString(), '2026-06-01T00:00:00.000Z');
    assert.equal(sent.compensation.updatedByUserId.toString(), ids.hr.toString());
    assert.equal((await profileOf(ids.failed)).compensation.annualCtc, 900_000);
    assert.equal((await profileOf(ids.resent)).compensation.annualCtc, 1_300_000, 'the latest offer wins');
    assert.equal((await profileOf(ids.pending)).compensation, undefined);
    assert.equal((await profileOf(ids.cancelled)).compensation, undefined);
    assert.deepEqual((await profileOf(ids.alreadySet)).compensation, { annualCtc: 3_000_000, source: 'manual' });

    assert.equal((await addEmployeeCompensation.run()).changedCount, 0);
  });
});
