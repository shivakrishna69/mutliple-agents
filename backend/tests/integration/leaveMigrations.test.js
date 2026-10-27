/**
 * Leave startup migrations against the real server, for a company whose leave types were created
 * before a policy field existed: template types get the template's value, other types the
 * default, and values HR already set are kept. The template itself is not seeded again.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

/** A leave type as stored before `usage.maxBackdatedDays` existed. */
function legacyLeaveType(code, usage = {}) {
  return {
    code,
    name: `${code} Leave`,
    description: '',
    isPaid: true,
    tracksBalance: true,
    accrual: { method: 'NONE', annualQuotaDays: 0, timing: 'START_OF_MONTH', proRataRoundingStepDays: 0.5 },
    accrueDuringNotice: true,
    carryForward: { maxDays: 0, yearEndExcessAction: 'LAPSE' },
    encashment: { isEncashable: false, minBalanceRetainedDays: 0 },
    usage: {
      sandwichRule: false,
      allowHalfDay: true,
      maxConsecutiveDays: null,
      minNoticeDays: 0,
      eligibleEmploymentStatuses: ['Probation', 'Active', 'Notice'],
      minServiceDays: 0,
      attachmentRequiredAfterDays: null,
      allowNegativeBalance: false,
      maxNegativeDays: 0,
      ...usage,
    },
    isActive: true,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    __v: 0,
  };
}

describe('leave startup migrations', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;

  before(async () => {
    testServer = await startTestServer({
      seedBeforeStart: async (database) => {
        await database
          .collection('leavetypes')
          .insertMany([
            legacyLeaveType('CL'),
            legacyLeaveType('SL', { maxBackdatedDays: 2 }),
            legacyLeaveType('STUDY'),
          ]);
      },
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hana HR', email: 'hana.hr@example.com', role: 'hr' });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('fills in back-dating from the template, keeping values HR set, without seeding again', async () => {
    const response = await hrClient.get('/api/leave/types?includeInactive=true');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const backdatingByCode = Object.fromEntries(
      response.body.data.leaveTypes.map((type) => [type.code, type.usage.maxBackdatedDays]),
    );
    assert.deepEqual(backdatingByCode, { CL: 3, SL: 2, STUDY: 0 });
    const stored = await testServer.database.collection('leavetypes').findOne({ code: 'STUDY' });
    assert.equal(stored.usage.maxBackdatedDays, 0, 'the default is written, not only applied on read');
  });
});
