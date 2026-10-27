/**
 * Office management (routes/officeRoutes.js, routes/employeeRoutes.js) against the real server:
 * the weekly-off startup migration, office CRUD with version checks and model validation, weekly
 * offs including 2nd/4th Saturdays, removal rules, and assigning employees their base office.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WEEKDAYS } from '../../models/OfficeLocation.js';
import { insertDepartment, officeDocument, officeFields, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('office management', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let employee;
  let legacyOfficeId;
  let customRulesOfficeId;

  before(async () => {
    testServer = await startTestServer({
      // Offices created before weekly offs existed (no rules) and one where HR already chose none.
      seedBeforeStart: async (database) => {
        const offices = database.collection('officelocations');
        legacyOfficeId = (await offices.insertOne(officeDocument('LEGACY'))).insertedId.toString();
        customRulesOfficeId = (
          await offices.insertOne(officeDocument('SHIFT', { workday: { weeklyOffRules: [] } }))
        ).insertedId.toString();
      },
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    const departmentId = await insertDepartment(testServer.database);
    employee = await onboardEmployee({ testServer, hrClient, email: 'esha@example.com', departmentId });
  });

  after(async () => {
    await testServer?.stop();
  });

  async function getOffice(officeId) {
    const response = await hrClient.get(`/api/offices/${officeId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.office;
  }

  it('gives existing offices Saturday and Sunday off at startup, keeping rules HR already set', async () => {
    const legacyOffice = await getOffice(legacyOfficeId);
    assert.deepEqual(
      legacyOffice.workday.weeklyOffRules.map((rule) => rule.weekday).sort(),
      [WEEKDAYS.SUNDAY, WEEKDAYS.SATURDAY].sort(),
    );
    assert.deepEqual((await getOffice(customRulesOfficeId)).workday.weeklyOffRules, []);
  });

  it('keeps office management to HR and admins', async () => {
    assert.equal((await employee.client.get('/api/offices')).status, 403);
    assert.equal((await employee.client.post('/api/offices', officeFields('MINE'))).status, 403);
    const selfAssignment = await employee.client.request('PUT', `/api/employees/${employee.profileId}/office`, {
      body: { officeLocationId: legacyOfficeId },
    });
    assert.equal(selfAssignment.status, 403);
  });

  it('creates an office with the default weekly offs and refuses a duplicate code', async () => {
    const created = await hrClient.post('/api/offices', officeFields('mumbai'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const office = created.body.data.office;
    assert.equal(office.code, 'MUMBAI');
    assert.deepEqual(
      office.workday.weeklyOffRules.map((rule) => rule.weekday).sort(),
      [WEEKDAYS.SUNDAY, WEEKDAYS.SATURDAY].sort(),
    );
    const duplicate = await hrClient.post('/api/offices', officeFields('MUMBAI', { name: 'Mumbai Annexe' }));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'OFFICE_CODE_TAKEN');
  });

  it('returns every invalid field from the model, and ignores unknown fields', async () => {
    const response = await hrClient.post('/api/offices', {
      ...officeFields('BAD', { timeZone: 'Mars/Olympus', workday: { shiftEndLocalTime: '08:00' } }),
      isPublic: true,
    });
    assert.equal(response.status, 400);
    const invalidFields = response.body.error.details.map((detail) => detail.field).sort();
    assert.deepEqual(invalidFields, ['timeZone', 'workday.shiftEndLocalTime']);
  });

  it('switches an office to 2nd and 4th Saturdays, refusing stale edits and invalid rules', async () => {
    const created = await hrClient.post('/api/offices', officeFields('PNQ'));
    const office = created.body.data.office;
    const update = await hrClient.patch(`/api/offices/${office.id}`, {
      workday: {
        weeklyOffRules: [
          { weekday: WEEKDAYS.SUNDAY, occurrencesInMonth: [] },
          { weekday: WEEKDAYS.SATURDAY, occurrencesInMonth: [2, 4] },
        ],
      },
      version: office.version,
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.data.office.workday.shiftStartLocalTime, '09:30', 'other workday fields are kept');

    const stale = await hrClient.patch(`/api/offices/${office.id}`, { name: 'Pune HQ', version: office.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VERSION');

    const invalidRules = await hrClient.patch(`/api/offices/${office.id}`, {
      workday: { weeklyOffRules: [{ weekday: WEEKDAYS.SATURDAY, occurrencesInMonth: [6] }] },
      version: update.body.data.office.version,
    });
    assert.equal(invalidRules.status, 400);

    const days = await hrClient.get(
      `/api/work-calendar/days?from=2026-10-10&to=2026-10-17&officeLocationId=${office.id}`,
    );
    const kindByDate = Object.fromEntries(days.body.data.days.map((day) => [day.date, day.kind]));
    assert.deepEqual(
      [kindByDate['2026-10-10'], kindByDate['2026-10-11'], kindByDate['2026-10-17']],
      ['weekly_off', 'weekly_off', 'working'],
    );
  });

  it('assigns and clears an employee’s base office', async () => {
    const assign = await hrClient.request('PUT', `/api/employees/${employee.profileId}/office`, {
      body: { officeLocationId: legacyOfficeId },
    });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    assert.equal((await employee.client.get('/api/work-calendar/days?from=2026-10-05&to=2026-10-05')).status, 200);

    const unknownOffice = await hrClient.request('PUT', `/api/employees/${employee.profileId}/office`, {
      body: { officeLocationId: '64b000000000000000000099' },
    });
    assert.equal(unknownOffice.status, 404);
    const unknownEmployee = await hrClient.request('PUT', '/api/employees/64b000000000000000000098/office', {
      body: { officeLocationId: legacyOfficeId },
    });
    assert.equal(unknownEmployee.status, 404);

    const clear = await hrClient.request('PUT', `/api/employees/${employee.profileId}/office`, {
      body: { officeLocationId: null },
    });
    assert.equal(clear.status, 200);
    assert.equal((await employee.client.get('/api/work-calendar/days?from=2026-10-05&to=2026-10-05')).status, 409);
  });

  it('removes an unused office but not one that employees or holidays refer to', async () => {
    const created = await hrClient.post('/api/offices', officeFields('TEMP'));
    const officeId = created.body.data.office.id;
    await hrClient.request('PUT', `/api/employees/${employee.profileId}/office`, {
      body: { officeLocationId: officeId },
    });

    const inUse = await hrClient.request('DELETE', `/api/offices/${officeId}`);
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, 'OFFICE_IN_USE');

    await hrClient.request('PUT', `/api/employees/${employee.profileId}/office`, { body: { officeLocationId: null } });
    const holiday = await hrClient.post('/api/work-calendar/holidays', {
      name: 'Temp Office Day',
      date: '2026-12-01',
      officeLocationIds: [officeId],
    });
    assert.equal((await hrClient.request('DELETE', `/api/offices/${officeId}`)).status, 409);

    await hrClient.request('DELETE', `/api/work-calendar/holidays/${holiday.body.data.holiday.id}`);
    assert.equal((await hrClient.request('DELETE', `/api/offices/${officeId}`)).status, 200);
    assert.equal((await hrClient.get(`/api/offices/${officeId}`)).status, 404);
  });
});
