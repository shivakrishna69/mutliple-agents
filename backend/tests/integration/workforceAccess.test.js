/**
 * Organisation-wide HR access and "my own profile" resolution (services/workforceAccess.js), through
 * the endpoints that rely on them: payslip listing and attendance regularization reviews.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('workforce access rules', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let noProfileClient;
  let firstEmployee;
  let secondEmployee;

  before(async () => {
    testServer = await startTestServer();
    const departmentId = await insertDepartment(testServer.database, {
      name: 'Finance',
      code: 'FIN',
      budgetCode: 'CC-300',
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    noProfileClient = await createSignedInClient(testServer, { name: 'Nia Noprofile', email: 'nia@example.com' });
    firstEmployee = await onboardEmployee({ testServer, hrClient, email: 'first@example.com', departmentId });
    secondEmployee = await onboardEmployee({ testServer, hrClient, email: 'second@example.com', departmentId });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('lets an employee list their own payslips but not a colleague’s', async () => {
    assert.equal((await firstEmployee.client.get('/api/payroll/payslips')).status, 200);
    const colleagueResponse = await firstEmployee.client.get(
      `/api/payroll/payslips?employeeId=${secondEmployee.profileId}`,
    );
    assert.equal(colleagueResponse.status, 403);
  });

  it('lets HR list any employee’s payslips', async () => {
    const response = await hrClient.get(`/api/payroll/payslips?employeeId=${secondEmployee.profileId}`);
    assert.equal(response.status, 200);
  });

  it('tells an account without an employee profile that it has none', async () => {
    assert.equal((await noProfileClient.get('/api/payroll/payslips')).status, 404);
  });

  it('opens the regularization review queue to HR and managers, not to accounts without a profile', async () => {
    assert.equal((await hrClient.get('/api/attendance/regularization-reviews')).status, 200);
    assert.equal((await firstEmployee.client.get('/api/attendance/regularization-reviews')).status, 200);
    assert.equal((await noProfileClient.get('/api/attendance/regularization-reviews')).status, 403);
  });
});
