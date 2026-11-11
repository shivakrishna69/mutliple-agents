/**
 * The leave policy an offer letter states (services/onboardingService.js loadLeavePolicy), read from
 * a real database: the active leave types that give a yearly quota, by name; leave HR grants per
 * person (no quota) and retired types are left out.
 */

import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { loadLeavePolicy } from '../../services/onboardingService.js';
import { MONGO_BASE_URL, mongoUnavailableReason } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('offer letter leave policy', { skip: skipReason ?? false }, () => {
  before(async () => {
    await mongoose.connect(`${MONGO_BASE_URL}/nsk_test_leave_policy_${process.pid}_${randomBytes(4).toString('hex')}`);
    // Written as stored; only the fields the letter reads matter here.
    await mongoose.connection.collection('leavetypes').insertMany([
      { name: 'Sick Leave', isActive: true, accrual: { annualQuotaDays: 6 } },
      { name: 'Casual Leave', isActive: true, accrual: { annualQuotaDays: 12 } },
      { name: 'Maternity Leave', isActive: true, accrual: { annualQuotaDays: 0 } },
      { name: 'Old Comp Off', isActive: false, accrual: { annualQuotaDays: 4 } },
    ]);
  });

  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('lists the active leave types with a yearly quota, by name', async () => {
    assert.deepEqual(await loadLeavePolicy(), [
      { name: 'Casual Leave', annualDays: 12 },
      { name: 'Sick Leave', annualDays: 6 },
    ]);
  });
});
