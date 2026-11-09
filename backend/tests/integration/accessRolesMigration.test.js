/**
 * The access role migration (migrations/standardizeAccessRoles.js) on a real MongoDB, with data
 * written the old ways: "customer" on accounts, invitations, offer drafts and import rows; roles
 * typed in another case; employee records without a job level or employment type. Running it again
 * changes nothing.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

import standardizeAccessRoles from '../../migrations/standardizeAccessRoles.js';
import { MONGO_BASE_URL, mongoUnavailableReason } from './testServer.js';

const mongoReason = await mongoUnavailableReason();

describe('access role migration', { skip: mongoReason ?? false }, () => {
  let database;

  before(async () => {
    await mongoose.connect(`${MONGO_BASE_URL}/nsk_test_roles_${process.pid}_${randomBytes(4).toString('hex')}`);
    database = mongoose.connection.db;
    await database.collection('users').insertMany([
      { email: 'old.customer@example.com', role: 'customer' },
      { email: 'shouting.admin@example.com', role: 'ADMIN' },
      { email: 'mixed.hr@example.com', role: 'Hr' },
      { email: 'it.admin@example.com', role: 'IT_ADMIN' },
      { email: 'agent@example.com', role: 'agent' },
      { email: 'unknown@example.com', role: 'super_admin' },
    ]);
    await database.collection('employeeinvitations').insertOne({ email: 'invited@example.com', role: 'customer' });
    await database.collection('onboardingdrafts').insertOne({ position: { role: 'customer' } });
    await database.collection('employeeimportjobs').insertOne({
      rows: [{ input: { role: 'customer' } }, { input: { role: 'agent' } }, { input: { role: 'customer' } }],
    });
    await database.collection('employeeprofiles').insertMany([
      { userId: new mongoose.Types.ObjectId(), organizationData: { designation: 'Engineer' } },
      {
        userId: new mongoose.Types.ObjectId(),
        organizationData: { designation: 'Contractor', jobLevel: 'team_lead', employmentType: 'contractor' },
      },
    ]);
  });

  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('renames customer to employee everywhere, fixes roles in the wrong case, and fills in job details', async () => {
    const { changedCount } = await standardizeAccessRoles.run();
    assert.ok(changedCount > 0);

    const roleOf = async (email) => (await database.collection('users').findOne({ email })).role;
    assert.equal(await roleOf('old.customer@example.com'), 'employee');
    assert.equal(await roleOf('shouting.admin@example.com'), 'admin');
    assert.equal(await roleOf('mixed.hr@example.com'), 'hr');
    assert.equal(await roleOf('it.admin@example.com'), 'it_admin');
    assert.equal(await roleOf('agent@example.com'), 'agent');
    assert.equal(await roleOf('unknown@example.com'), 'super_admin', 'an unknown role is left for a person to decide');

    assert.equal((await database.collection('employeeinvitations').findOne()).role, 'employee');
    assert.equal((await database.collection('onboardingdrafts').findOne()).position.role, 'employee');
    assert.deepEqual(
      (await database.collection('employeeimportjobs').findOne()).rows.map((row) => row.input.role),
      ['employee', 'agent', 'employee'],
    );
    const profiles = await database.collection('employeeprofiles').find().sort({ _id: 1 }).toArray();
    assert.deepEqual(
      profiles.map((profile) => [profile.organizationData.jobLevel, profile.organizationData.employmentType]),
      [
        ['individual_contributor', 'full_time'],
        ['team_lead', 'contractor'],
      ],
    );
  });

  it('changes nothing when it runs again', async () => {
    assert.deepEqual(await standardizeAccessRoles.run(), { changedCount: 0 });
  });
});
