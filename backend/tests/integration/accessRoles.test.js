/**
 * The access roles end to end (constants/accessRoles.js): one signed-in person per role, and what
 * each may reach. "Allowed" means the server did not refuse (403); a request may still be invalid or
 * point at nothing (400/404), since several here send empty bodies on purpose so that nothing is
 * written. Also: the capabilities the browser is told, who an IT administrator may not touch, what an
 * inviter may grant, and job levels and employment types on invitations.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES,
  JOB_LEVEL_DEFINITIONS,
  ROLES,
  ROLE_DEFINITIONS,
  capabilitiesOf,
} from '../../constants/accessRoles.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { TEST_ADMIN_EMAIL, createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const ALL_ROLES = Object.values(ROLES);
const FORBIDDEN = 403;
const SOME_ID = '65f1a2b3c4d5e6f708192a3b';

describe('access roles', { skip: mongoReason ?? false }, () => {
  let testServer;
  let departmentId;
  let employeeProfile;
  /** One signed-in client per role. */
  const clients = {};

  before(async () => {
    testServer = await startTestServer({ mail: false, environment: { LOG_LEVEL: 'warn' } });
    clients[ROLES.ADMIN] = await createSignedInClient(testServer, { name: 'Ada Admin', email: TEST_ADMIN_EMAIL });
    for (const role of ALL_ROLES.filter((role) => role !== ROLES.ADMIN)) {
      clients[role] = await createSignedInClient(testServer, {
        name: `Role ${role}`,
        email: `${role.replace('_', '.')}@example.com`,
        role: role === ROLES.EMPLOYEE ? null : role,
      });
    }
    departmentId = await insertDepartment(testServer.database);
    employeeProfile = await onboardEmployee({
      testServer,
      hrClient: clients[ROLES.HR],
      email: 'esha.employee@example.com',
      name: 'Esha Employee',
      departmentId,
    });
  });

  after(async () => {
    await testServer?.stop();
  });

  /** For each role, whether `send(client)` was refused; compared with the roles expected to pass. */
  async function assertReachableBy(description, send, allowedRoles) {
    for (const role of ALL_ROLES) {
      const response = await send(clients[role]);
      const isAllowed = response.status !== FORBIDDEN;
      assert.equal(
        isAllowed,
        allowedRoles.includes(role),
        `${description} for ${role}: ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
  }

  it('tells each person their role label and exactly their capabilities', async () => {
    for (const role of ALL_ROLES) {
      const { user } = (await clients[role].get('/api/auth/me')).body.data;
      assert.equal(user.role, role);
      assert.equal(user.roleLabel, ROLE_DEFINITIONS.find((definition) => definition.value === role).label);
      assert.deepEqual(user.capabilities, capabilitiesOf(role));
    }
    assert.deepEqual(capabilitiesOf(ROLES.EMPLOYEE), [
      CAPABILITIES.ASK_DEPARTMENT_AGENTS,
      CAPABILITIES.USE_TASK_BOARDS,
      CAPABILITIES.USE_SUPPORT_CHAT,
    ]);
    assert.ok(
      ALL_ROLES.every((role) => capabilitiesOf(role).includes(CAPABILITIES.ASK_DEPARTMENT_AGENTS)),
      'every role may ask department agents (which ones is decided per agent)',
    );
  });

  it('keeps each area to the roles the access table gives it', async () => {
    const { ADMIN, HR, FINANCE, IT_ADMIN, AGENT } = ROLES;
    await assertReachableBy('people and onboarding', (client) => client.get('/api/people/invitations/options'), [
      ADMIN,
      HR,
    ]);
    await assertReachableBy('workforce analytics', (client) => client.get('/api/analytics/workforce-risk'), [
      ADMIN,
      HR,
    ]);
    await assertReachableBy('employee directory', (client) => client.get('/api/employees'), [
      ADMIN,
      HR,
      FINANCE,
      IT_ADMIN,
    ]);
    await assertReachableBy(
      "someone else's payslips",
      (client) => client.get(`/api/payroll/payslips?employeeId=${employeeProfile.profileId}`),
      [ADMIN, HR, FINANCE],
    );
    await assertReachableBy('issuing a payslip', (client) => client.post('/api/payroll/payslips', {}), [
      ADMIN,
      HR,
      FINANCE,
    ]);
    await assertReachableBy(
      'offers and the compensation policy',
      (client) => client.get('/api/hr/onboarding/settings'),
      [ADMIN, HR, FINANCE],
    );
    await assertReachableBy('the CTC calculator', (client) => client.post('/api/hr/onboarding/calculate', {}), [
      ADMIN,
      HR,
      FINANCE,
    ]);
    await assertReachableBy('preparing an offer', (client) => client.post('/api/hr/onboarding/create-draft', {}), [
      ADMIN,
      HR,
    ]);
    await assertReachableBy('users and roles', (client) => client.get('/api/admin/users'), [ADMIN, IT_ADMIN]);
    await assertReachableBy('reading the company settings', (client) => client.get('/api/company/settings'), [
      ADMIN,
      HR,
      IT_ADMIN,
    ]);
    await assertReachableBy('system health', (client) => client.get('/api/system/health'), [ADMIN, IT_ADMIN]);
    await assertReachableBy('the support console', (client) => client.post(`/api/conversations/${SOME_ID}/claim`), [
      ADMIN,
      AGENT,
    ]);
    await assertReachableBy('the organisation directory', (client) => client.get('/api/org/hierarchy'), [ADMIN, AGENT]);
    await assertReachableBy('the support chat', (client) => client.post('/api/support/messages', {}), [ROLES.EMPLOYEE]);
    await assertReachableBy(
      "every department's knowledge base",
      (client) => client.get(`/api/departments/${departmentId}/agent/settings`),
      [ADMIN],
    );
  });

  it('lets administrators and IT administrators change the company settings, and tells HR who can', async () => {
    for (const role of [ROLES.ADMIN, ROLES.IT_ADMIN, ROLES.HR]) {
      const { settings } = (await clients[ROLES.ADMIN].get('/api/company/settings')).body.data;
      const response = await clients[role].patch('/api/company/settings', {
        supportEmail: `${role.replace('_', '.')}.desk@example.com`,
        version: settings.version,
      });
      if (role === ROLES.HR) {
        assert.equal(response.status, FORBIDDEN);
        assert.equal(response.body.error.code, 'ADMINS_ONLY');
      } else {
        assert.equal(response.status, 200, `${role}: ${JSON.stringify(response.body)}`);
      }
    }
  });

  it('lets Finance work on the compensation policy but not on offers or their terms', async () => {
    const finance = clients[ROLES.FINANCE];
    const { settings } = (await finance.get('/api/hr/onboarding/settings')).body.data;
    const compensation = await finance.patch('/api/hr/onboarding/settings', {
      compensation: { basicShareBasisPoints: settings.compensation.basicShareBasisPoints },
      version: settings.version,
    });
    assert.notEqual(compensation.status, FORBIDDEN, JSON.stringify(compensation.body));
    const terms = await finance.patch('/api/hr/onboarding/settings', {
      offerTerms: { probationMonths: settings.offerTerms.probationMonths },
      version: settings.version,
    });
    assert.equal(terms.status, FORBIDDEN);
    assert.equal(terms.body.error.code, 'OFFER_MANAGERS_ONLY');
    const draft = await finance.post('/api/hr/onboarding/create-draft', {});
    assert.equal(draft.body.error.code, 'OFFER_MANAGERS_ONLY');
  });

  it('lets an IT administrator manage accounts but never grant or take away administration', async () => {
    const itAdmin = clients[ROLES.IT_ADMIN];
    const { users, roleOptions, canChangeAdmins } = (await itAdmin.get('/api/admin/users')).body.data;
    assert.equal(canChangeAdmins, false);
    assert.deepEqual(
      roleOptions.map((role) => role.value),
      ROLE_DEFINITIONS.map((role) => role.value).filter((role) => role !== ROLES.ADMIN),
      'an IT administrator is never offered the admin role',
    );
    const adminView = (await clients[ROLES.ADMIN].get('/api/admin/users')).body.data;
    assert.equal(adminView.canChangeAdmins, true);
    assert.deepEqual(adminView.roleOptions, ROLE_DEFINITIONS);
    const idOf = (email) => users.find((user) => user.email === email).id;
    const agentId = idOf('agent@example.com');

    const promoted = await itAdmin.patch(`/api/admin/users/${agentId}/role`, { role: ROLES.FINANCE });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.data.user.role, ROLES.FINANCE);
    await itAdmin.patch(`/api/admin/users/${agentId}/role`, { role: ROLES.AGENT });

    const toAdmin = await itAdmin.patch(`/api/admin/users/${agentId}/role`, { role: ROLES.ADMIN });
    assert.equal(toAdmin.status, FORBIDDEN);
    assert.match(toAdmin.body.error.message, /administrator/);
    const demoteAdmin = await itAdmin.patch(`/api/admin/users/${idOf(TEST_ADMIN_EMAIL)}/role`, {
      role: ROLES.EMPLOYEE,
    });
    assert.equal(demoteAdmin.status, FORBIDDEN);
    const stored = await testServer.database.collection('users').findOne({ email: TEST_ADMIN_EMAIL });
    assert.equal(stored.role, ROLES.ADMIN);

    const byAdmin = await clients[ROLES.ADMIN].patch(`/api/admin/users/${agentId}/role`, { role: ROLES.IT_ADMIN });
    assert.equal(byAdmin.status, 200);
    await clients[ROLES.ADMIN].patch(`/api/admin/users/${agentId}/role`, { role: ROLES.AGENT });
  });

  it('offers each inviter only the roles they may grant, with labels, groups, job levels and types', async () => {
    const adminOptions = (await clients[ROLES.ADMIN].get('/api/people/invitations/options')).body.data;
    assert.deepEqual(
      adminOptions.roleOptions.map((role) => role.value),
      [ROLES.HR, ROLES.FINANCE, ROLES.IT_ADMIN, ROLES.AGENT, ROLES.EMPLOYEE],
    );
    assert.equal(new Set(adminOptions.roleOptions.map((role) => role.label)).size, adminOptions.roleOptions.length);
    assert.ok(adminOptions.roleOptions.every((role) => role.label && role.category && role.description));
    assert.deepEqual(adminOptions.jobLevels, JOB_LEVEL_DEFINITIONS);
    assert.deepEqual(
      adminOptions.employmentTypes.map((type) => type.value),
      ['full_time', 'contractor', 'intern'],
    );
    assert.deepEqual(adminOptions.defaults, {
      role: ROLES.EMPLOYEE,
      jobLevel: 'individual_contributor',
      employmentType: 'full_time',
    });

    const hrOptions = (await clients[ROLES.HR].get('/api/people/invitations/options')).body.data;
    assert.deepEqual(
      hrOptions.roleOptions.map((role) => role.value),
      [ROLES.AGENT, ROLES.EMPLOYEE],
    );
    assert.deepEqual(hrOptions.roles, [ROLES.EMPLOYEE, ROLES.AGENT], 'the plain list stays for older screens');
  });

  /** The employee record of the account with `email`. */
  async function organizationOf(email) {
    const account = await testServer.database.collection('users').findOne({ email });
    return testServer.database.collection('employeeprofiles').findOne({ userId: account._id });
  }

  it('records the job level and employment type of an invited person, and refuses others', async () => {
    const invite = (client, overrides) =>
      client.post('/api/people/invitations', {
        name: 'Chitra Chief',
        email: `chitra.${overrides.role ?? 'employee'}@example.com`,
        role: ROLES.EMPLOYEE,
        designation: 'Chief Technology Officer',
        departmentId,
        workLocationType: 'Onsite',
        dateOfJoining: new Date().toISOString().slice(0, 10),
        employmentStatus: 'Active',
        ...overrides,
      });
    const created = await invite(clients[ROLES.ADMIN], { jobLevel: 'cto', employmentType: 'contractor' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const stored = await organizationOf('chitra.employee@example.com');
    assert.equal(stored.organizationData.jobLevel, 'cto');
    assert.equal(stored.organizationData.employmentType, 'contractor');
    const { invitations } = (await clients[ROLES.ADMIN].get('/api/people/invitations')).body.data;
    const listed = invitations.find((invitation) => invitation.email === 'chitra.employee@example.com');
    assert.deepEqual([listed.jobLevel, listed.employmentType], ['cto', 'contractor']);

    const unknownLevel = await invite(clients[ROLES.ADMIN], { role: ROLES.AGENT, jobLevel: 'emperor' });
    assert.equal(unknownLevel.status, 400);
    const hrGrantsFinance = await invite(clients[ROLES.HR], { role: ROLES.FINANCE });
    assert.equal(hrGrantsFinance.status, FORBIDDEN, JSON.stringify(hrGrantsFinance.body));
    const asAdmin = await invite(clients[ROLES.ADMIN], { role: ROLES.ADMIN });
    assert.equal(asAdmin.status, 400, 'nobody is invited as an administrator');

    const defaults = await invite(clients[ROLES.HR], { role: ROLES.AGENT });
    assert.equal(defaults.status, 201, JSON.stringify(defaults.body));
    const agentProfile = await organizationOf('chitra.agent@example.com');
    assert.equal(agentProfile.organizationData.jobLevel, 'individual_contributor');
    assert.equal(agentProfile.organizationData.employmentType, 'full_time');
  });

  it('gives administrators every capability but the support chat, and MANAGE_WORKFORCE to administrators and HR only', () => {
    assert.deepEqual(
      [...capabilitiesOf(ROLES.ADMIN)].sort(),
      Object.values(CAPABILITIES)
        .filter((capability) => capability !== CAPABILITIES.USE_SUPPORT_CHAT)
        .sort(),
    );
    assert.deepEqual(
      ALL_ROLES.filter((role) => capabilitiesOf(role).includes(CAPABILITIES.USE_SUPPORT_CHAT)),
      [ROLES.EMPLOYEE],
    );
    assert.deepEqual(
      ALL_ROLES.filter((role) => capabilitiesOf(role).includes(CAPABILITIES.MANAGE_KNOWLEDGE_BASES)),
      [ROLES.ADMIN],
    );
    assert.deepEqual(
      ALL_ROLES.filter((role) => capabilitiesOf(role).includes(CAPABILITIES.MANAGE_WORKFORCE)),
      [ROLES.ADMIN, ROLES.HR],
    );
    assert.deepEqual(
      ALL_ROLES.filter((role) => capabilitiesOf(role).includes(CAPABILITIES.ASSIGN_ADMIN_ROLE)),
      [ROLES.ADMIN],
    );
  });
});
