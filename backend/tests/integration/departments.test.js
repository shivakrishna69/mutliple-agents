/**
 * Departments (routes/departmentRoutes.js) against the real server: slugs for departments created
 * before slugs existed, who may manage departments, slugs made from names and kept on rename,
 * clashes, head counts, deactivation (which invitations respect) and the removal rule.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

const legacyDepartment = (name, code) => ({
  name,
  code,
  budgetCode: 'CC-100',
  departmentHeadId: null,
  parentDepartmentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('departments', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;

  before(async () => {
    testServer = await startTestServer({
      // Departments from before slugs: two names that make the same slug.
      seedBeforeStart: async (database) => {
        await database
          .collection('departments')
          .insertMany([legacyDepartment('Data Science & AI', 'DSAI'), legacyDepartment('Data-Science AI', 'DSA2')]);
      },
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
  });

  after(async () => {
    await testServer?.stop();
  });

  async function listDepartments(query = '') {
    const response = await hrClient.get(`/api/departments${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.departments;
  }

  async function createDepartment(fields) {
    const response = await hrClient.post('/api/departments', fields);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.department;
  }

  it('gives departments from before slugs a unique slug at startup and marks them active', async () => {
    const departments = await listDepartments();
    assert.deepEqual(
      departments.map(({ code, slug, isActive }) => ({ code, slug, isActive })),
      [
        { code: 'DSAI', slug: 'data-science-ai', isActive: true },
        { code: 'DSA2', slug: 'data-science-ai-2', isActive: true },
      ],
    );
  });

  it('makes a slug from the name, keeps it on rename, and takes a budget code only when given', async () => {
    const engineering = await createDepartment({ name: 'Engineering Café', code: 'eng' });
    assert.equal(engineering.code, 'ENG');
    assert.equal(engineering.slug, 'engineering-cafe');
    assert.equal(engineering.budgetCode, null);
    assert.equal(engineering.memberCount, 0);

    const renamed = await hrClient.patch(`/api/departments/${engineering.id}`, {
      name: 'Engineering',
      budgetCode: 'cc-200',
      version: engineering.version,
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.data.department.slug, 'engineering-cafe');
    assert.equal(renamed.body.data.department.budgetCode, 'CC-200');

    const stale = await hrClient.patch(`/api/departments/${engineering.id}`, { name: 'Late', version: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VERSION');
  });

  it('refuses clashing codes, slugs and sibling names, and values the model does not accept', async () => {
    await createDepartment({ name: 'Payroll', code: 'PAY', slug: 'payroll' });
    const clashes = await Promise.all([
      hrClient.post('/api/departments', { name: 'Payroll Ops', code: 'PAY' }),
      hrClient.post('/api/departments', { name: 'Pay Team', code: 'PAYT', slug: 'payroll' }),
      hrClient.post('/api/departments', { name: 'Payroll', code: 'PAY2' }),
    ]);
    assert.deepEqual(
      clashes.map((response) => [response.status, response.body.error.code]),
      [
        [409, 'DEPARTMENT_CODE_TAKEN'],
        [409, 'DEPARTMENT_SLUG_TAKEN'],
        [409, 'DEPARTMENT_NAME_TAKEN'],
      ],
    );
    const invalid = await hrClient.post('/api/departments', {
      name: 'Bad',
      code: 'BAD',
      slug: 'Not A Slug',
      parentDepartmentId: 'not-an-id',
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(
      invalid.body.error.details.map((detail) => detail.field),
      ['parentDepartmentId'],
    );
    const invalidSlug = await hrClient.post('/api/departments', { name: 'Bad', code: 'BAD', slug: 'Not A Slug' });
    assert.equal(invalidSlug.status, 400);
    assert.deepEqual(
      invalidSlug.body.error.details.map((detail) => detail.field),
      ['slug'],
    );
  });

  it('counts members, hides deactivated departments from lists and invitations, and removes only unused ones', async () => {
    const support = await createDepartment({ name: 'Support', code: 'SUP' });
    const employee = await onboardEmployee({
      testServer,
      hrClient,
      email: 'sam@example.com',
      departmentId: support.id,
    });
    assert.equal((await listDepartments()).find((department) => department.id === support.id).memberCount, 1);
    assert.equal((await employee.client.get('/api/departments')).status, 403);

    const inUse = await hrClient.request('DELETE', `/api/departments/${support.id}`);
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, 'DEPARTMENT_IN_USE');

    const deactivated = await hrClient.patch(`/api/departments/${support.id}`, {
      isActive: false,
      version: support.version,
    });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(
      (await listDepartments()).some((department) => department.id === support.id),
      false,
    );
    assert.equal(
      (await listDepartments('?includeInactive=true')).some((department) => department.id === support.id),
      true,
    );
    const options = await hrClient.get('/api/people/invitations/options');
    assert.equal(
      options.body.data.departments.some((department) => department.id === support.id),
      false,
    );
    const invitation = await hrClient.post('/api/people/invitations', {
      name: 'Late Joiner',
      email: 'late@example.com',
      role: 'employee',
      designation: 'Agent',
      departmentId: support.id,
      workLocationType: 'Remote',
      dateOfJoining: '2026-11-02',
      employmentStatus: 'Probation',
    });
    assert.equal(invitation.status, 400);
    assert.equal(invitation.body.error.code, 'DEPARTMENT_INACTIVE');

    const unused = await createDepartment({ name: 'Temporary', code: 'TMP' });
    const removed = await hrClient.request('DELETE', `/api/departments/${unused.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await hrClient.get(`/api/departments/${unused.id}`)).status, 404);
  });
});
