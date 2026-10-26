import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../../models/EmployeeProfile.js';
import {
  createSignedInClient,
  mongoUnavailableReason,
  startTestServer,
  STRONG_PASSWORD,
  TEST_ADMIN_EMAIL,
} from './testServer.js';

const skipReason = await mongoUnavailableReason();

function tokenFromInviteUrl(inviteUrl) {
  return new URL(inviteUrl).pathname.split('/').pop();
}

describe('onboarding by email invitation', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let hrClient;
  let customerClient;
  let departmentId;

  function invitationFor(email, overrides = {}) {
    return {
      name: 'Kiran Patel',
      email,
      role: 'customer',
      designation: 'Support Engineer',
      departmentId,
      workLocationType: WORK_LOCATION_TYPES.ONSITE,
      dateOfJoining: new Date().toISOString().slice(0, 10),
      employmentStatus: EMPLOYMENT_STATUSES.PROBATION,
      ...overrides,
    };
  }

  async function inviteAndGetToken(email) {
    const createResponse = await hrClient.post('/api/people/invitations', invitationFor(email));
    assert.equal(createResponse.status, 201, JSON.stringify(createResponse.body));
    return {
      invitationId: createResponse.body.data.invitation.id,
      token: tokenFromInviteUrl(createResponse.body.data.delivery.inviteUrl),
    };
  }

  before(async () => {
    testServer = await startTestServer();
    const insertResult = await testServer.database.collection('departments').insertOne({
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-100',
      departmentHeadId: null,
      parentDepartmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    departmentId = insertResult.insertedId.toString();
    adminClient = await createSignedInClient(testServer, { name: 'Admin User', email: TEST_ADMIN_EMAIL });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    customerClient = await createSignedInClient(testServer, { name: 'Cyrus Customer', email: 'cyrus@example.com' });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('hands HR the link when no mail server is configured, and stores only the token hash', async () => {
    const createResponse = await hrClient.post('/api/people/invitations', invitationFor('kiran@example.com'));
    assert.equal(createResponse.status, 201, JSON.stringify(createResponse.body));
    const { delivery } = createResponse.body.data;
    assert.notEqual(delivery.outcome, 'sent');
    const token = tokenFromInviteUrl(delivery.inviteUrl);

    const storedInvitation = await testServer.database
      .collection('employeeinvitations')
      .findOne({ email: 'kiran@example.com' });
    assert.equal(storedInvitation.tokenHash, createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(storedInvitation).includes(token), false, 'raw token must not be stored');
  });

  it('refuses a second open invitation for the same email', async () => {
    const duplicateResponse = await hrClient.post('/api/people/invitations', invitationFor('kiran@example.com'));
    assert.equal(duplicateResponse.status, 409);
    assert.equal(duplicateResponse.body.error.code, 'INVITATION_EXISTS');
  });

  it('lets HR invite employees and agents but not HR; admins may invite HR', async () => {
    const hrInvitesHr = await hrClient.post(
      '/api/people/invitations',
      invitationFor('second.hr@example.com', { role: 'hr' }),
    );
    assert.equal(hrInvitesHr.status, 403);
    assert.equal(hrInvitesHr.body.error.code, 'ROLE_NOT_ALLOWED');

    const adminInvitesHr = await adminClient.post(
      '/api/people/invitations',
      invitationFor('second.hr@example.com', { role: 'hr' }),
    );
    assert.equal(adminInvitesHr.status, 201);
  });

  it('refuses invitations from customers and for registered emails', async () => {
    const customerAttempt = await customerClient.post('/api/people/invitations', invitationFor('x@example.com'));
    assert.equal(customerAttempt.status, 403);

    const registeredEmail = await hrClient.post('/api/people/invitations', invitationFor('cyrus@example.com'));
    assert.equal(registeredEmail.status, 409);
    assert.equal(registeredEmail.body.error.code, 'EMAIL_ALREADY_REGISTERED');
  });

  it('creates the account and employee profile on acceptance, exactly once', async () => {
    const { token } = await inviteAndGetToken('nisha@example.com');
    const inviteeClient = testServer.createClient();

    const previewResponse = await inviteeClient.get(`/api/invitations/${token}`);
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.body.data.invitation.departmentName, 'Engineering');

    const weakPasswordResponse = await inviteeClient.post(`/api/invitations/${token}/accept`, { password: 'weak' });
    assert.equal(weakPasswordResponse.status, 400);

    const acceptResponse = await inviteeClient.post(`/api/invitations/${token}/accept`, { password: STRONG_PASSWORD });
    assert.equal(acceptResponse.status, 201, JSON.stringify(acceptResponse.body));
    assert.equal(acceptResponse.body.data.user.role, 'customer');

    const currentUserResponse = await inviteeClient.get('/api/auth/me');
    assert.equal(currentUserResponse.body.data.user.email, 'nisha@example.com');

    const newUserId = acceptResponse.body.data.user.id;
    const profile = await testServer.database
      .collection('employeeprofiles')
      .findOne({ userId: new testServer.database.base.Types.ObjectId(newUserId) });
    assert.ok(profile, 'expected an employee profile linked to the new user');

    const secondAccept = await testServer
      .createClient()
      .post(`/api/invitations/${token}/accept`, { password: STRONG_PASSWORD });
    assert.equal(secondAccept.status, 410);
    assert.equal(secondAccept.body.error.code, 'INVITATION_USED');
  });

  it('stops a revoked link from working', async () => {
    const { invitationId, token } = await inviteAndGetToken('revoked@example.com');
    const revokeResponse = await hrClient.post(`/api/people/invitations/${invitationId}/revoke`);
    assert.equal(revokeResponse.status, 200);

    const previewResponse = await testServer.createClient().get(`/api/invitations/${token}`);
    assert.equal(previewResponse.status, 404);
    assert.equal(previewResponse.body.error.code, 'INVITATION_INVALID');
  });

  it('stops an expired link from working', async () => {
    const { token } = await inviteAndGetToken('expired@example.com');
    await testServer.database
      .collection('employeeinvitations')
      .updateOne({ email: 'expired@example.com' }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });

    const previewResponse = await testServer.createClient().get(`/api/invitations/${token}`);
    assert.equal(previewResponse.status, 410);
    assert.equal(previewResponse.body.error.code, 'INVITATION_EXPIRED');
  });

  it('treats a malformed token as an invalid link', async () => {
    const previewResponse = await testServer.createClient().get('/api/invitations/not-a-real-token');
    assert.equal(previewResponse.status, 404);
  });
});
