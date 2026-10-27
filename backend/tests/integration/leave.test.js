/**
 * Leave policies and balances (routes/leaveRoutes.js) against the real server: the template seeded
 * at startup, settings and leave types with their locks, who may see and do what, HR adjustments
 * and encashments with their limits, concurrent debits, reconciliation, and the leave job's
 * accruals and year ends over two leave years.
 *
 * Dates are relative to the current leave year (Y, from the API) so the suite gives the same
 * results whenever it runs: the job is run "as of" dates that are already past, and employees'
 * joining dates are set in the database to the dates a scenario needs.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('leave policies and balances', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  // A second administrator for the job runs and scenario setup, so neither client reaches the
  // per-user limit on leave changes.
  let operationsClient;
  let departmentId;
  let employee;
  let leaveTypeIdByCode;
  let currentLeaveYear;
  let previousLeaveYear;

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    operationsClient = await createSignedInClient(testServer, {
      name: 'Ola Admin',
      email: 'ola.admin@example.com',
      role: 'admin',
    });
    departmentId = await insertDepartment(testServer.database);
    employee = await onboardEmployee({ testServer, hrClient, email: 'meera@example.com', departmentId });
    const typesResponse = await employee.client.get('/api/leave/types');
    assert.equal(typesResponse.status, 200, JSON.stringify(typesResponse.body));
    leaveTypeIdByCode = Object.fromEntries(typesResponse.body.data.leaveTypes.map((type) => [type.code, type.id]));
    const balancesResponse = await employee.client.get('/api/leave/balances');
    assert.equal(balancesResponse.status, 200, JSON.stringify(balancesResponse.body));
    currentLeaveYear = balancesResponse.body.data.currentLeaveYear;
    previousLeaveYear = currentLeaveYear - 1;
  });

  after(async () => {
    await testServer?.stop();
  });

  // ----------------------------------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------------------------------

  const objectId = (id) => new testServer.database.base.Types.ObjectId(id);

  async function expectStatus(responsePromise, expectedStatus, expectedCode) {
    const response = await responsePromise;
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    if (expectedCode) assert.equal(response.body.error.code, expectedCode);
    return response.body;
  }

  /** An employee whose joining date (and status) are set to what the scenario needs. */
  async function employeeJoinedOn(email, joiningDate, employmentStatus = EMPLOYMENT_STATUSES.ACTIVE) {
    const onboarded = await onboardEmployee({ testServer, hrClient, email, departmentId });
    await testServer.database.collection('employeeprofiles').updateOne(
      { _id: objectId(onboarded.profileId) },
      {
        $set: {
          'organizationData.dateOfJoining': new Date(`${joiningDate}T00:00:00Z`),
          'organizationData.employmentStatus': employmentStatus,
        },
      },
    );
    return onboarded;
  }

  async function runLeaveJob(asOfDate) {
    const body = await expectStatus(operationsClient.post('/api/leave/jobs/accrual', { asOfDate }), 200);
    return body.data.summary;
  }

  /** { CL: { balanceDays, heldDays, availableDays, movements }, ... } as HR sees them. */
  async function balancesOf(profileId, leaveYear) {
    const body = await expectStatus(
      hrClient.get(`/api/leave/employees/${profileId}/balances?leaveYear=${leaveYear}`),
      200,
    );
    return Object.fromEntries(body.data.balances.map((balance) => [balance.leaveType.code, balance]));
  }

  const adjust = (client, fields) =>
    client.post('/api/leave/adjustments', { reasonCode: 'MANUAL', note: 'Test adjustment', ...fields });

  // ----------------------------------------------------------------------------------------------
  // Settings, types and access
  // ----------------------------------------------------------------------------------------------

  it('seeds the India standard leave types at startup', async () => {
    const { leaveTypes } = (await expectStatus(employee.client.get('/api/leave/types'), 200)).data;
    const byCode = Object.fromEntries(leaveTypes.map((type) => [type.code, type]));
    assert.deepEqual(Object.keys(byCode).sort(), ['CL', 'EL', 'LOP', 'SL']);
    for (const code of ['CL', 'SL']) {
      assert.equal(byCode[code].accrual.method, 'MONTHLY');
      assert.equal(byCode[code].accrual.annualQuotaDays, 12);
      assert.equal(byCode[code].accrual.timing, 'START_OF_MONTH');
      assert.equal(byCode[code].carryForward.maxDays, 0);
      assert.equal(byCode[code].usage.sandwichRule, false);
    }
    const earned = byCode.EL;
    assert.equal(earned.accrual.annualQuotaDays, 15);
    assert.equal(earned.accrual.timing, 'END_OF_MONTH');
    assert.equal(earned.accrueDuringNotice, false);
    assert.deepEqual(earned.carryForward, { maxDays: 30, yearEndExcessAction: 'ENCASH' });
    assert.deepEqual(earned.encashment, { isEncashable: true, minBalanceRetainedDays: 15 });
    assert.equal(earned.usage.sandwichRule, true);
    assert.equal(byCode.LOP.isPaid, false);
    assert.equal(byCode.LOP.tracksBalance, false);
    assert.equal(byCode.LOP.usage.sandwichRule, true);
  });

  it('keeps leave to employees, HR and admins, and management to HR and admins', async () => {
    const outsider = await createSignedInClient(testServer, { name: 'Out Sider', email: 'outsider@example.com' });
    await expectStatus(outsider.get('/api/leave/types'), 403, 'EMPLOYEES_ONLY');
    await expectStatus(outsider.get('/api/leave/balances'), 403, 'EMPLOYEES_ONLY');
    await expectStatus(outsider.get('/api/leave/settings'), 403, 'EMPLOYEES_ONLY');

    const { client } = employee;
    assert.equal((await client.patch('/api/leave/settings', { defaultTimeZone: 'UTC', version: 0 })).status, 403);
    assert.equal((await client.post('/api/leave/types', { code: 'MINE', name: 'Mine', isPaid: true })).status, 403);
    assert.equal(
      (await adjust(client, { employeeId: employee.profileId, leaveTypeId: leaveTypeIdByCode.CL, days: 5 })).status,
      403,
    );
    assert.equal((await client.get(`/api/leave/employees/${employee.profileId}/balances`)).status, 403);
    assert.equal((await client.post('/api/leave/jobs/accrual', {})).status, 403);
    assert.equal((await client.post('/api/leave/jobs/reconcile', {})).status, 403);
    // HR without an employee profile has no balance of their own.
    await expectStatus(hrClient.get('/api/leave/balances'), 403, 'EMPLOYEES_ONLY');
  });

  it('changes settings with version checks, and locks the leave year start once leave is recorded', async () => {
    let { settings } = (await expectStatus(employee.client.get('/api/leave/settings'), 200)).data;
    assert.equal(settings.leaveYearStartMonth, 4);
    assert.equal(settings.defaultTimeZone, 'Asia/Kolkata');

    const invalidZone = await expectStatus(
      hrClient.patch('/api/leave/settings', { defaultTimeZone: 'Mars/Olympus', version: settings.version }),
      400,
    );
    assert.ok(invalidZone.error.details.some((detail) => detail.field === 'defaultTimeZone'));
    // Nothing recorded yet: the start month may still change (and change back).
    ({ settings } = (
      await expectStatus(
        hrClient.patch('/api/leave/settings', { leaveYearStartMonth: 1, version: settings.version }),
        200,
      )
    ).data);
    await expectStatus(
      hrClient.patch('/api/leave/settings', { leaveYearStartMonth: 4, version: settings.version - 1 }),
      409,
      'STALE_VERSION',
    );
    ({ settings } = (
      await expectStatus(
        hrClient.patch('/api/leave/settings', { leaveYearStartMonth: 4, version: settings.version }),
        200,
      )
    ).data);

    await expectStatus(
      adjust(hrClient, { employeeId: employee.profileId, leaveTypeId: leaveTypeIdByCode.CL, days: 1 }),
      201,
    );
    await expectStatus(
      hrClient.patch('/api/leave/settings', { leaveYearStartMonth: 1, version: settings.version }),
      409,
      'LEAVE_YEAR_LOCKED',
    );
    // Other settings stay editable.
    ({ settings } = (
      await expectStatus(
        hrClient.patch('/api/leave/settings', { defaultTimeZone: 'UTC', version: settings.version }),
        200,
      )
    ).data);
    await expectStatus(
      hrClient.patch('/api/leave/settings', { defaultTimeZone: 'Asia/Kolkata', version: settings.version }),
      200,
    );
  });

  it('creates, changes and retires leave types, with the model validating every value', async () => {
    const maternity = {
      code: 'maternity',
      name: 'Maternity Leave',
      isPaid: true,
      usage: { minServiceDays: 80, unknownRule: true },
      unknownField: 'dropped',
    };
    const created = (await expectStatus(hrClient.post('/api/leave/types', maternity), 201)).data.leaveType;
    assert.equal(created.code, 'MATERNITY');
    assert.equal(created.accrual.method, 'NONE');
    assert.equal(created.usage.minServiceDays, 80);
    assert.equal(created.usage.unknownRule, undefined);
    leaveTypeIdByCode.MATERNITY = created.id;

    await expectStatus(
      hrClient.post('/api/leave/types', { ...maternity, name: 'Again' }),
      409,
      'LEAVE_TYPE_CODE_TAKEN',
    );
    const inconsistent = await expectStatus(
      hrClient.post('/api/leave/types', { code: 'BAD', name: 'Bad', isPaid: true, accrual: { annualQuotaDays: 5 } }),
      400,
    );
    assert.ok(inconsistent.error.details.some((detail) => detail.field === 'accrual.annualQuotaDays'));
    const offStep = await expectStatus(
      hrClient.post('/api/leave/types', { code: 'ODD', name: 'Odd', isPaid: true, usage: { minNoticeDays: 1.3 } }),
      400,
    );
    assert.ok(offStep.error.details.some((detail) => detail.field === 'usage.minNoticeDays'));

    const path = `/api/leave/types/${created.id}`;
    await expectStatus(hrClient.patch(path, { code: 'OTHER', version: created.version }), 400);
    const changed = (
      await expectStatus(hrClient.patch(path, { usage: { maxConsecutiveDays: 182 }, version: created.version }), 200)
    ).data.leaveType;
    assert.equal(changed.usage.maxConsecutiveDays, 182);
    assert.equal(changed.usage.minServiceDays, 80, 'other usage rules are kept');
    await expectStatus(hrClient.patch(path, { name: 'Stale', version: created.version }), 409, 'STALE_VERSION');

    const retired = (await expectStatus(hrClient.patch(path, { isActive: false, version: changed.version }), 200)).data
      .leaveType;
    const employeeView = (await expectStatus(employee.client.get('/api/leave/types?includeInactive=true'), 200)).data;
    assert.ok(!employeeView.leaveTypes.some((type) => type.code === 'MATERNITY'), 'employees see active types only');
    const hrView = (await expectStatus(hrClient.get('/api/leave/types?includeInactive=true'), 200)).data;
    assert.ok(hrView.leaveTypes.some((type) => type.code === 'MATERNITY'));
    await expectStatus(hrClient.patch(path, { isActive: true, version: retired.version }), 200);
  });

  it('locks whether a type keeps a balance once leave is recorded for it', async () => {
    const path = `/api/leave/types/${leaveTypeIdByCode.CL}`;
    const { leaveTypes } = (await expectStatus(hrClient.get('/api/leave/types'), 200)).data;
    const casual = leaveTypes.find((type) => type.code === 'CL');
    await expectStatus(
      hrClient.patch(path, {
        tracksBalance: false,
        isPaid: false,
        accrual: { method: 'NONE', annualQuotaDays: 0 },
        version: casual.version,
      }),
      409,
      'TRACKS_BALANCE_LOCKED',
    );
  });

  // ----------------------------------------------------------------------------------------------
  // Adjustments and encashments
  // ----------------------------------------------------------------------------------------------

  it('grants and adjusts days within the balance, in open leave years only', async () => {
    const target = { employeeId: employee.profileId, leaveTypeId: leaveTypeIdByCode.MATERNITY };
    const granted = await expectStatus(
      adjust(hrClient, { ...target, reasonCode: 'ENTITLEMENT_GRANT', days: 10, note: 'Maternity entitlement' }),
      201,
    );
    assert.deepEqual(granted.data.balance, { balanceDays: 10, heldDays: 0, availableDays: 10 });
    assert.equal(granted.data.entry.reasonCode, 'ENTITLEMENT_GRANT');
    assert.equal(granted.data.entry.postedBySystem, false);

    await expectStatus(adjust(hrClient, { ...target, reasonCode: 'ENTITLEMENT_GRANT', days: -1 }), 400);
    await expectStatus(adjust(hrClient, { ...target, reasonCode: 'LAPSE', days: 1 }), 400);
    await expectStatus(adjust(hrClient, { ...target, days: 1.234 }), 400);
    await expectStatus(adjust(hrClient, { ...target, days: 1, note: '' }), 400);
    await expectStatus(adjust(hrClient, { ...target, days: -12 }), 422, 'INSUFFICIENT_BALANCE');
    const reduced = await expectStatus(adjust(hrClient, { ...target, days: -4 }), 201);
    assert.equal(reduced.data.balance.availableDays, 6);

    await expectStatus(
      adjust(hrClient, { ...target, leaveTypeId: leaveTypeIdByCode.LOP, days: 1 }),
      422,
      'BALANCE_NOT_TRACKED',
    );
    await expectStatus(
      adjust(hrClient, { ...target, leaveYear: currentLeaveYear + 1, days: 1 }),
      422,
      'LEAVE_YEAR_NOT_OPEN',
    );
    await expectStatus(
      adjust(hrClient, { ...target, leaveYear: currentLeaveYear - 2, days: 1 }),
      422,
      'LEAVE_YEAR_NOT_OPEN',
    );
    await expectStatus(
      adjust(hrClient, { ...target, employeeId: '0123456789abcdef01234567', days: 1 }),
      404,
      'EMPLOYEE_NOT_FOUND',
    );
    await expectStatus(
      adjust(hrClient, { ...target, leaveTypeId: '0123456789abcdef01234567', days: 1 }),
      404,
      'LEAVE_TYPE_NOT_FOUND',
    );
  });

  it('never overdraws when several debits arrive at once', async () => {
    const target = { employeeId: employee.profileId, leaveTypeId: leaveTypeIdByCode.MATERNITY, days: -2 };
    const responses = await Promise.all(Array.from({ length: 5 }, () => adjust(hrClient, target)));
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 422, 422], 'only the three debits the 6 days cover succeed');
    const balances = await balancesOf(employee.profileId, currentLeaveYear);
    assert.equal(balances.MATERNITY.balanceDays, 0);
    assert.equal(balances.MATERNITY.movements.adjusted, 0, 'granted 10, removed 4 + 3 x 2');
  });

  it('encashes within the retained minimum, once per payroll reference', async () => {
    const target = { employeeId: employee.profileId, leaveTypeId: leaveTypeIdByCode.EL };
    const encash = (fields) =>
      hrClient.post('/api/leave/encashments', { ...target, payrollMonth: `${currentLeaveYear}-11`, ...fields });
    await expectStatus(adjust(hrClient, { ...target, days: 20 }), 201);

    await expectStatus(
      encash({ leaveTypeId: leaveTypeIdByCode.CL, days: 1, payrollReference: 'PAY-CL-1' }),
      422,
      'NOT_ENCASHABLE',
    );
    await expectStatus(encash({ days: 6, payrollReference: 'PAY-NOV-1' }), 422, 'ENCASHMENT_EXCEEDS_LIMIT');
    await expectStatus(encash({ days: 1, payrollReference: 'year-end-2020' }), 422, 'PAYROLL_REFERENCE_RESERVED');
    await expectStatus(encash({ days: 1, payrollReference: 'x' }), 400);
    await expectStatus(encash({ days: 1, payrollReference: 'PAY-NOV-1', payrollMonth: '2026-13' }), 400);

    const encashed = await expectStatus(encash({ days: 5, payrollReference: 'PAY-NOV-1' }), 201);
    assert.equal(encashed.data.balance.availableDays, 15, 'the retained 15 days stay');
    assert.equal(encashed.data.entry.payrollReference, 'PAY-NOV-1');

    await expectStatus(adjust(hrClient, { ...target, days: 10 }), 201);
    await expectStatus(encash({ days: 1, payrollReference: 'PAY-NOV-1' }), 409, 'DUPLICATE_ENCASHMENT');
    const balances = await balancesOf(employee.profileId, currentLeaveYear);
    assert.equal(balances.EL.availableDays, 25, 'the refused encashment left the balance untouched');
    assert.equal(balances.EL.movements.encashed, -5);
  });

  it('does not let HR move days in or out of their own balance', async () => {
    const hrEmployee = await onboardEmployee({ testServer, hrClient, email: 'hr.emp@example.com', departmentId });
    await testServer.database
      .collection('users')
      .updateOne({ _id: objectId(hrEmployee.userId) }, { $set: { role: 'hr' } });
    await expectStatus(hrEmployee.client.login('hr.emp@example.com'), 200);
    const ownTarget = { employeeId: hrEmployee.profileId, leaveTypeId: leaveTypeIdByCode.CL, days: 5 };
    await expectStatus(adjust(hrEmployee.client, ownTarget), 403, 'OWN_BALANCE_RESTRICTED');
    await expectStatus(
      hrEmployee.client.post('/api/leave/encashments', {
        ...ownTarget,
        leaveTypeId: leaveTypeIdByCode.EL,
        payrollReference: 'PAY-OWN-1',
        payrollMonth: `${currentLeaveYear}-11`,
      }),
      403,
      'OWN_BALANCE_RESTRICTED',
    );
    await expectStatus(adjust(hrClient, ownTarget), 201);
  });

  it('shows employees their own balances and ledger, adding up to the balance', async () => {
    const own = (await expectStatus(employee.client.get(`/api/leave/balances?leaveYear=${currentLeaveYear}`), 200))
      .data;
    const hrView = await balancesOf(employee.profileId, currentLeaveYear);
    const ownByCode = Object.fromEntries(own.balances.map((balance) => [balance.leaveType.code, balance]));
    assert.deepEqual(ownByCode, hrView);
    assert.ok(!('LOP' in ownByCode), 'types without a balance are not listed');
    for (const balance of own.balances) {
      const movementsTotal = Object.values(balance.movements).reduce((total, days) => total + days, 0);
      assert.equal(Math.round(movementsTotal * 100), Math.round(balance.balanceDays * 100), balance.leaveType.code);
    }

    const ledger = (
      await expectStatus(employee.client.get(`/api/leave/ledger?leaveTypeId=${leaveTypeIdByCode.EL}`), 200)
    ).data;
    assert.deepEqual(
      ledger.entries.map((entry) => [entry.entryType, entry.days]),
      [
        ['ADJUSTMENT', 20],
        ['ENCASHMENT', -5],
        ['ADJUSTMENT', 10],
      ],
    );
    await expectStatus(employee.client.get('/api/leave/ledger?leaveYear=1990'), 400);
  });

  // ----------------------------------------------------------------------------------------------
  // Reconciliation
  // ----------------------------------------------------------------------------------------------

  it('reconciles a drifted total and reverses a reservation whose ledger entry was never written', async () => {
    const balances = testServer.database.collection('leavebalances');
    const key = {
      employeeId: objectId(employee.profileId),
      leaveTypeId: objectId(leaveTypeIdByCode.EL),
      leaveYear: currentLeaveYear,
    };
    const original = await balances.findOne(key);
    await balances.updateOne(key, { $inc: { balanceCentidays: 500 } });
    await balances.updateOne(key, {
      $inc: { balanceCentidays: -300 },
      $push: {
        appliedEntries: {
          entryId: objectId('0123456789abcdef01234567'),
          balanceDeltaCentidays: -300,
          heldDeltaCentidays: 0,
          appliedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      },
    });
    const summary = (await expectStatus(operationsClient.post('/api/leave/jobs/reconcile', {}), 200)).data.summary;
    assert.equal(summary.abandonedReversed, 1);
    assert.ok(summary.totalsCorrected >= 1);
    const repaired = await balances.findOne(key);
    assert.equal(repaired.balanceCentidays, original.balanceCentidays);
    assert.equal(repaired.appliedEntries.length, original.appliedEntries.length);

    const again = (await expectStatus(operationsClient.post('/api/leave/jobs/reconcile', {}), 200)).data.summary;
    assert.deepEqual([again.missingApplied, again.abandonedReversed, again.totalsCorrected], [0, 0, 0]);
  });

  // ----------------------------------------------------------------------------------------------
  // The leave job
  // ----------------------------------------------------------------------------------------------

  it('refuses to run the leave job for a future or invalid date', async () => {
    await expectStatus(
      operationsClient.post('/api/leave/jobs/accrual', { asOfDate: '2999-01-01' }),
      422,
      'FUTURE_RUN_DATE',
    );
    await expectStatus(operationsClient.post('/api/leave/jobs/accrual', { asOfDate: '2026-02-30' }), 400);
  });

  it('accrues, then carries forward into a year whose own accruals are still due', async () => {
    // Joined two leave years ago. First run: early in the previous year; second: the current one.
    const twoYearsAgo = previousLeaveYear - 1;
    const veteran = await employeeJoinedOn('veteran@example.com', `${twoYearsAgo}-04-01`);
    await runLeaveJob(`${previousLeaveYear}-04-01`);
    let previous = await balancesOf(veteran.profileId, previousLeaveYear);
    assert.deepEqual([previous.CL.balanceDays, previous.SL.balanceDays], [1, 1], 'April credited at the start');
    assert.equal(previous.EL.balanceDays, 15, 'a full year of EL carried in, April not yet earned');
    assert.equal(previous.EL.movements.carriedIn, 15);
    const closedYear = await balancesOf(veteran.profileId, twoYearsAgo);
    assert.deepEqual([closedYear.CL.movements.accrued, closedYear.CL.movements.lapsed], [12, -12]);

    await runLeaveJob(`${currentLeaveYear}-04-01`);
    previous = await balancesOf(veteran.profileId, previousLeaveYear);
    // The carry-in belongs to that year's balance; it does not close the year early.
    assert.deepEqual(previous.EL.movements, {
      accrued: 15,
      carriedIn: 15,
      adjusted: 0,
      used: 0,
      encashed: 0,
      lapsed: 0,
      carriedOut: -30,
    });
    const current = await balancesOf(veteran.profileId, currentLeaveYear);
    assert.deepEqual([current.CL.balanceDays, current.SL.balanceDays, current.EL.balanceDays], [1, 1, 30]);
  });

  it('carries forward up to the cap and encashes the rest at year end, and posts nothing twice', async () => {
    const joined = `${previousLeaveYear - 1}-06-15`;
    const regular = await employeeJoinedOn('regular@example.com', joined);
    const saver = await employeeJoinedOn('saver@example.com', joined);
    // HR credits the saver 20 more EL days in the previous year, before its year end runs.
    await expectStatus(
      adjust(operationsClient, {
        employeeId: saver.profileId,
        leaveTypeId: leaveTypeIdByCode.EL,
        leaveYear: previousLeaveYear,
        days: 20,
      }),
      201,
    );

    const firstRun = await runLeaveJob(`${currentLeaveYear}-04-01`);
    assert.ok(firstRun.accrualsPosted > 0);

    const regularPrevious = await balancesOf(regular.profileId, previousLeaveYear);
    assert.deepEqual(
      [regularPrevious.CL.balanceDays, regularPrevious.SL.balanceDays, regularPrevious.EL.balanceDays],
      [0, 0, 0],
      'the year is closed: CL and SL lapsed, EL carried forward',
    );
    assert.deepEqual([regularPrevious.CL.movements.lapsed, regularPrevious.EL.movements.carriedOut], [-12, -15]);
    const regularCurrent = await balancesOf(regular.profileId, currentLeaveYear);
    assert.deepEqual([regularCurrent.CL.balanceDays, regularCurrent.EL.balanceDays], [1, 15]);

    const saverPrevious = await balancesOf(saver.profileId, previousLeaveYear);
    assert.deepEqual(
      [saverPrevious.EL.movements.carriedOut, saverPrevious.EL.movements.encashed],
      [-30, -5],
      '15 earned + 20 credited: 30 carried (the cap), 5 encashed',
    );
    const saverLedger = (
      await expectStatus(
        hrClient.get(
          `/api/leave/employees/${saver.profileId}/ledger?leaveYear=${previousLeaveYear}&leaveTypeId=${leaveTypeIdByCode.EL}`,
        ),
        200,
      )
    ).data.entries;
    const yearEndEncashment = saverLedger.find((entry) => entry.entryType === 'ENCASHMENT');
    assert.equal(yearEndEncashment.payrollReference, `YEAR-END-${previousLeaveYear}`);
    assert.equal(yearEndEncashment.payrollMonth, `${currentLeaveYear}-04`);
    assert.equal(yearEndEncashment.postedBySystem, true);
    assert.equal((await balancesOf(saver.profileId, currentLeaveYear)).EL.balanceDays, 30);

    // The year is closed now, so HR can no longer adjust it.
    await expectStatus(
      adjust(operationsClient, {
        employeeId: saver.profileId,
        leaveTypeId: leaveTypeIdByCode.EL,
        leaveYear: previousLeaveYear,
        days: 1,
      }),
      422,
      'LEAVE_YEAR_NOT_OPEN',
    );

    const secondRun = await runLeaveJob(`${currentLeaveYear}-04-01`);
    assert.deepEqual([secondRun.accrualsPosted, secondRun.yearEndMovementsPosted], [0, 0]);
  });

  it('prorates a joiner and stops EL, not CL, during notice', async () => {
    // Joined on the 16th of a 30-day month: half of that month.
    const joined = `${previousLeaveYear}-09-16`;
    const joiner = await employeeJoinedOn('joiner@example.com', joined);
    const leaver = await employeeJoinedOn('leaver@example.com', joined, EMPLOYMENT_STATUSES.NOTICE);
    await runLeaveJob(`${previousLeaveYear}-10-27`);

    const joinerBalances = await balancesOf(joiner.profileId, previousLeaveYear);
    // CL: half of September (0.5) at joining + October at its start (1). EL: half of September
    // (0.625, rounded to 0.5) at September's end; October not yet earned.
    assert.deepEqual([joinerBalances.CL.balanceDays, joinerBalances.EL.balanceDays], [1.5, 0.5]);
    const leaverBalances = await balancesOf(leaver.profileId, previousLeaveYear);
    assert.deepEqual([leaverBalances.CL.balanceDays, leaverBalances.EL.balanceDays], [1.5, 0]);
  });
});
