/**
 * Accounts created with the invitation (services/employeeProvisioning.js) against the real server:
 * the invited account and profile exist at once with an employee ID, cannot sign in until the link
 * is used, get a company address in the company's mail domain, and are disabled by revoking and
 * reused by inviting again. Also: disabled accounts lose their sessions, employee IDs stay unique
 * under concurrent invitations, and data from before all this is migrated (accounts become active,
 * profiles are numbered, old invitations still work).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { hashSecureToken } from '../../utils/secureTokens.js';
import { STRONG_PASSWORD, createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const today = () => new Date().toISOString().slice(0, 10);

describe('account lifecycle', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let departmentId;
  const legacy = { inviteToken: randomBytes(32).toString('base64url') };

  before(async () => {
    testServer = await startTestServer({
      // Tests the behaviour without a mail server: HR is handed the invitation links.
      mail: false,
      // Data from before account statuses and employee IDs: an account, its profile, and an open invitation.
      seedBeforeStart: async (database) => {
        const now = new Date();
        departmentId = (
          await database.collection('departments').insertOne({
            name: 'Engineering',
            code: 'ENG',
            slug: 'engineering',
            isActive: true,
            budgetCode: null,
            departmentHeadId: null,
            parentDepartmentId: null,
            createdAt: now,
            updatedAt: now,
          })
        ).insertedId;
        legacy.userId = (
          await database.collection('users').insertOne({
            name: 'Old Timer',
            email: 'old.timer@example.com',
            password: 'not-a-real-hash',
            role: 'customer',
            createdAt: now,
            updatedAt: now,
          })
        ).insertedId;
        await database.collection('employeeprofiles').insertOne({
          userId: legacy.userId,
          organizationData: {
            designation: 'Engineer',
            departmentId,
            reportingManagerId: null,
            officeLocationId: null,
            workLocationType: 'Remote',
            dateOfJoining: now,
            employmentStatus: 'Active',
          },
          createdAt: now,
          updatedAt: now,
        });
        await database.collection('employeeinvitations').insertOne({
          email: 'legacy.invitee@example.com',
          name: 'Legacy Invitee',
          role: 'customer',
          profileDraft: {
            designation: 'Analyst',
            departmentId,
            reportingManagerId: null,
            workLocationType: 'Hybrid',
            dateOfJoining: now,
            employmentStatus: 'Probation',
          },
          tokenHash: hashSecureToken(legacy.inviteToken),
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          status: 'pending',
          invitedByUserId: legacy.userId,
          sendCount: 1,
          lastSentAt: now,
          lastDelivery: { outcome: 'not_configured', at: now },
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
      },
    });
    adminClient = await createSignedInClient(testServer, { name: 'Ada Admin', email: 'admin@example.com' });
  });

  after(async () => {
    await testServer?.stop();
  });

  const users = () => testServer.database.collection('users');
  const profiles = () => testServer.database.collection('employeeprofiles');

  async function invite(fields) {
    const response = await adminClient.post('/api/people/invitations', {
      role: 'customer',
      designation: 'Data Engineer',
      departmentId: departmentId.toString(),
      workLocationType: 'Onsite',
      dateOfJoining: today(),
      employmentStatus: 'Probation',
      ...fields,
    });
    return response;
  }

  const tokenOf = (inviteResponse) => new URL(inviteResponse.body.data.delivery.inviteUrl).pathname.split('/').pop();

  it('migrates older data: accounts become active, profiles get IDs, and old invitations still work', async () => {
    const oldAccount = await users().findOne({ _id: legacy.userId });
    assert.equal(oldAccount.status, 'active');
    assert.equal(oldAccount.profileCompleted, true);
    assert.equal((await profiles().findOne({ userId: legacy.userId })).employeeCode, 'NSK0001');

    const accepted = await testServer
      .createClient()
      .post(`/api/invitations/${legacy.inviteToken}/accept`, {
        password: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
        acceptTerms: true,
      });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const legacyAccount = await users().findOne({ email: 'legacy.invitee@example.com' });
    assert.equal(legacyAccount.status, 'active');
    assert.equal((await profiles().findOne({ userId: legacyAccount._id })).employeeCode, 'NSK0002');
  });

  it('creates the invited account and profile at once, with an ID, and keeps it from signing in', async () => {
    const invited = await invite({ name: 'Puja Sharma', email: 'puja@example.com' });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    assert.equal(invited.body.data.invitation.employeeCode, 'NSK0003');

    const account = await users().findOne({ email: 'puja@example.com' });
    assert.equal(account.status, 'invited');
    assert.equal(account.password, undefined);
    assert.equal(account.personalEmail, 'puja@example.com');
    assert.equal(account.companyEmail, null, 'no mail domain is set yet');
    assert.equal(account.profileCompleted, false);
    const profile = await profiles().findOne({ userId: account._id });
    assert.equal(profile.employeeCode, 'NSK0003');
    const directory = await adminClient.get('/api/employees');
    const listed = directory.body.data.employees.find((employee) => employee.employeeId === profile._id.toString());
    assert.equal(listed.employeeCode, 'NSK0003');
    assert.equal(listed.accountStatus, 'invited');

    const signIn = await testServer.createClient().login('puja@example.com', STRONG_PASSWORD);
    assert.equal(signIn.status, 401);
    const again = await invite({ name: 'Puja Sharma', email: 'puja@example.com' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVITATION_EXISTS');

    const activated = await testServer
      .createClient()
      .post(`/api/invitations/${tokenOf(invited)}/accept`, {
        password: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
        acceptTerms: true,
      });
    assert.equal(activated.status, 201, JSON.stringify(activated.body));
    assert.equal(activated.body.data.user.id, account._id.toString());
    assert.equal((await users().findOne({ _id: account._id })).status, 'active');
    assert.equal((await testServer.createClient().login('puja@example.com', STRONG_PASSWORD)).status, 200);
    const reused = await testServer
      .createClient()
      .post(`/api/invitations/${tokenOf(invited)}/accept`, {
        password: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
        acceptTerms: true,
      });
    assert.equal(reused.status, 410);
  });

  it('gives each invited person a free address in the company mail domain, or the one HR chose', async () => {
    const { body: settingsBody } = await adminClient.get('/api/company/settings');
    const changed = await adminClient.patch('/api/company/settings', {
      emailDomain: 'nsksofttech.in',
      version: settingsBody.data.settings.version,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    await invite({ name: 'Ádupa Rajeshwari', email: 'rajeshwari@example.com' });
    await invite({ name: 'Adupa K Rajeshwari', email: 'rajeshwari.k@example.com' });
    await invite({ name: 'Ramya', email: 'ramya@example.com', companyEmail: 'ramya.de@nsksofttech.in' });
    const companyEmailOf = async (email) => (await users().findOne({ email })).companyEmail;
    assert.equal(await companyEmailOf('rajeshwari@example.com'), 'adupa.rajeshwari@nsksofttech.in');
    assert.equal(await companyEmailOf('rajeshwari.k@example.com'), 'adupa.rajeshwari2@nsksofttech.in');
    assert.equal(await companyEmailOf('ramya@example.com'), 'ramya.de@nsksofttech.in');

    const clash = await invite({
      name: 'Other Ramya',
      email: 'ramya2@example.com',
      companyEmail: 'ramya.de@nsksofttech.in',
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'COMPANY_EMAIL_TAKEN');
    assert.equal(await users().findOne({ email: 'ramya2@example.com' }), null, 'nothing is left behind');
  });

  it('disables the account when the invitation is revoked, and reuses it, ID included, when invited again', async () => {
    const invited = await invite({ name: 'Vamshi Krishna', email: 'vamshi@example.com' });
    const { employeeCode } = invited.body.data.invitation;
    const revoked = await adminClient.post(`/api/people/invitations/${invited.body.data.invitation.id}/revoke`);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const account = await users().findOne({ email: 'vamshi@example.com' });
    assert.equal(account.status, 'disabled');
    assert.equal((await profiles().findOne({ userId: account._id })).organizationData.employmentStatus, 'Terminated');
    const oldLink = await testServer.createClient().post(`/api/invitations/${tokenOf(invited)}/accept`, {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
      acceptTerms: true,
    });
    assert.equal(oldLink.status, 404);

    const reinvited = await invite({
      name: 'Vamshi Krishna',
      email: 'vamshi@example.com',
      designation: 'Data Engineer II',
    });
    assert.equal(reinvited.status, 201, JSON.stringify(reinvited.body));
    assert.equal(reinvited.body.data.invitation.employeeCode, employeeCode);
    const reopenedProfile = await profiles().findOne({ userId: account._id });
    assert.equal(reopenedProfile.organizationData.employmentStatus, 'Probation');
    assert.equal(reopenedProfile.organizationData.designation, 'Data Engineer II');
    const activated = await testServer
      .createClient()
      .post(`/api/invitations/${tokenOf(reinvited)}/accept`, {
        password: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
        acceptTerms: true,
      });
    assert.equal(activated.status, 201, JSON.stringify(activated.body));
  });

  it('ends the sessions of an account that is disabled', async () => {
    const client = await createSignedInClient(testServer, { name: 'Cyrus', email: 'cyrus@example.com' });
    assert.equal((await client.get('/api/auth/me')).status, 200);
    await users().updateOne({ email: 'cyrus@example.com' }, { $set: { status: 'disabled' } });
    assert.equal((await client.get('/api/auth/me')).status, 401);
    assert.equal((await testServer.createClient().login('cyrus@example.com')).status, 401);
  });

  it('never gives two people the same employee ID, however many are invited at once', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (unused, index) =>
        invite({ name: `Batch Person ${index}`, email: `batch${index}@example.com` }),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      Array(12).fill(201),
    );
    const codes = responses.map((response) => response.body.data.invitation.employeeCode);
    assert.equal(new Set(codes).size, 12);
    assert.ok(codes.every((code) => /^NSK\d{4}$/.test(code)));
  });
});
