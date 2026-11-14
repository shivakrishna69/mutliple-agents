/**
 * Offboarding through NSK against the real server: who may preview, start, read and download
 * (HR and administrators run it; finance reads settlements and downloads the statement only; the IT
 * administrator sees the notice checklist only; employees nothing), the settlement as previewed
 * (salary from the latest issued payslip, else the accepted offer; HR's adjustments; the
 * 2-working-day banner), starting it (status Notice, documents generated in the background with
 * Socket.IO progress, stored in S3), the three documents themselves (two PDFs and the attendance and
 * leave audit workbook with its three sheets), a preview gone stale, and the audit trail.
 *
 * S3 is an in-process stand-in (s3StandIn.js) reached through the real AWS SDK. The PDFs need a
 * Chromium (PDF_BROWSER_CHANNEL or PDF_BROWSER_EXECUTABLE_PATH), as the offer letter tests do.
 */

import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { io } from 'socket.io-client';

import { OFFBOARDING_MESSAGES } from '../../constants/messages.js';
import { addDaysToCalendarDate } from '../../utils/calendarDates.js';
import { computeFinalSettlement, financialYearOf } from '../../utils/payroll/finalSettlement.js';
import { SUPPORTED_FINANCIAL_YEAR } from '../../utils/payroll/rules.js';
import { settlementInputOf } from '../../services/nskBot/offboarding/offboardingService.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { serverLogMatching } from './nskStandIn.js';
import { startS3StandIn } from './s3StandIn.js';
import { TEST_APP_ORIGIN, createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const pdfBrowserEnvironment = Object.fromEntries(
  ['PDF_BROWSER_CHANNEL', 'PDF_BROWSER_EXECUTABLE_PATH']
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
const mongoReason = await mongoUnavailableReason();
const skipReason =
  mongoReason ??
  (Object.keys(pdfBrowserEnvironment).length === 0
    ? 'no PDF browser: set PDF_BROWSER_CHANNEL or PDF_BROWSER_EXECUTABLE_PATH'
    : null);
if (process.env.CI === 'true' && skipReason && !mongoReason) {
  throw new Error(`The offboarding tests cannot run in CI: ${skipReason}`);
}

const GENERATION_TIMEOUT_MS = 90_000;
const today = new Date().toISOString().slice(0, 10);
const NOTICE_DATE = addDaysToCalendarDate(today, -40);
const LAST_WORKING_DAY = addDaysToCalendarDate(today, 10);
const engineIsCurrent = financialYearOf(LAST_WORKING_DAY) === SUPPORTED_FINANCIAL_YEAR;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('offboarding through NSK', { skip: skipReason ?? false }, () => {
  let testServer;
  let s3;
  let hr;
  let admin;
  let finance;
  let itAdmin;
  let employee;
  let rahul;
  let meera;
  let leaveTypeId;
  let startedCase;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const collection = (name) => testServer.database.collection(name);
  const separation = (overrides = {}) => ({
    kind: 'RESIGNATION',
    noticeDate: NOTICE_DATE,
    lastWorkingDay: LAST_WORKING_DAY,
    reason: 'Moving to another city',
    ...overrides,
  });
  const preview = (client, employeeId, body = {}) =>
    client.post('/api/nsk-bot/offboarding/preview', { employeeId, separation: separation(), ...body });

  async function untilCase(caseId, test) {
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let response;
    do {
      response = await hr.get(`/api/nsk-bot/offboarding/cases/${caseId}`);
      if (test(response.body.data?.case)) return response.body.data.case;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    assert.fail(
      `the case did not get there in time: ${JSON.stringify(response.body)}\n${testServer.output().slice(-3000)}`,
    );
  }

  before(async () => {
    s3 = await startS3StandIn();
    testServer = await startTestServer({
      environment: {
        ...s3.environmentFor('OFFBOARDING'),
        ...pdfBrowserEnvironment,
        COMPANY_LEGAL_NAME: 'NSK Software Technologies Private Limited',
        COMPANY_REGISTERED_ADDRESS: '1 Test Road, Bengaluru 560001',
        LOG_LEVEL: 'info',
      },
    });
    hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    admin = await createSignedInClient(testServer, {
      name: 'Ada Admin',
      email: 'ada.admin@example.com',
      role: 'admin',
    });
    finance = await createSignedInClient(testServer, {
      name: 'Fia Finance',
      email: 'fia@example.com',
      role: 'finance',
    });
    itAdmin = await createSignedInClient(testServer, { name: 'Ivo IT', email: 'ivo@example.com', role: 'it_admin' });
    employee = await createSignedInClient(testServer, { name: 'Eli Employee', email: 'eli@example.com' });
    const engineeringId = await insertDepartment(testServer.database, {
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-1',
    });
    rahul = await onboardEmployee({
      testServer,
      hrClient: hr,
      email: 'rahul.sharma@example.com',
      departmentId: engineeringId,
      name: 'Rahul Sharma',
    });
    meera = await onboardEmployee({
      testServer,
      hrClient: hr,
      email: 'meera@example.com',
      departmentId: engineeringId,
      name: 'Meera Offer',
    });

    // Rahul joined six years ago, has an issued payslip, encashable leave, and attendance and leave
    // in the last three months.
    await collection('employeeprofiles').updateOne(
      { _id: asId(rahul.profileId) },
      { $set: { 'organizationData.dateOfJoining': new Date('2020-06-01T00:00:00Z') } },
    );
    await collection('payslips').insertOne({
      employeeId: asId(rahul.profileId),
      financialYear: financialYearOf(addDaysToCalendarDate(today, -35)),
      period: { year: 2026, month: 1 },
      status: 'Issued',
      earnings: [
        { code: 'BASIC', label: 'Basic Salary', amount: 50000 },
        { code: 'HRA', label: 'House Rent Allowance', amount: 25000 },
        { code: 'SPECIAL', label: 'Special Allowance', amount: 25000 },
      ],
      deductions: [
        { code: 'EPF', label: 'EPF', amount: 1800 },
        { code: 'PROFESSIONAL_TAX', label: 'Professional Tax', amount: 200 },
        { code: 'TDS', label: 'Income Tax (TDS)', amount: 9000 },
      ],
      grossEarnings: 100000,
      totalDeductions: 11000,
      netPay: 89000,
      taxSummary: { regime: 'new' },
      verification: { verificationId: 'PS-202601-AAAA-0000-0000-0001' },
    });
    // An older payslip with a lower salary: the settlement starts from the latest one.
    await collection('payslips').insertOne({
      employeeId: asId(rahul.profileId),
      financialYear: '2025-26',
      period: { year: 2025, month: 12 },
      status: 'Issued',
      earnings: [{ code: 'BASIC', label: 'Basic Salary', amount: 40000 }],
      deductions: [],
      grossEarnings: 80000,
      totalDeductions: 0,
      netPay: 80000,
      taxSummary: { regime: 'new' },
      verification: { verificationId: 'PS-202512-AAAA-0000-0000-0003' },
    });
    leaveTypeId = (
      await collection('leavetypes').insertOne({
        code: 'XEL',
        name: 'Earned Leave (test)',
        isPaid: true,
        tracksBalance: true,
        isActive: true,
        encashment: { isEncashable: true, minBalanceRetainedDays: 0 },
      })
    ).insertedId;
    const month = Number(today.slice(5, 7));
    const leaveYear = month >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
    await collection('leavebalances').insertOne({
      employeeId: asId(rahul.profileId),
      leaveTypeId,
      leaveYear,
      balanceCentidays: 1250,
      heldCentidays: 0,
    });
    // Leave that cannot be encashed does not count.
    const sickLeaveId = (
      await collection('leavetypes').insertOne({
        code: 'XSL',
        name: 'Sick Leave (test)',
        isPaid: true,
        tracksBalance: true,
        isActive: true,
        encashment: { isEncashable: false, minBalanceRetainedDays: 0 },
      })
    ).insertedId;
    await collection('leavebalances').insertOne({
      employeeId: asId(rahul.profileId),
      leaveTypeId: sickLeaveId,
      leaveYear,
      balanceCentidays: 500,
      heldCentidays: 0,
    });
    const workedDay = addDaysToCalendarDate(today, -7);
    await collection('attendances').insertOne({
      employeeId: asId(rahul.profileId),
      date: workedDay,
      timeZone: 'Asia/Kolkata',
      checkInTime: new Date(`${workedDay}T04:00:00Z`),
      checkOutTime: new Date(`${workedDay}T12:30:00Z`),
      workedMinutes: 510,
      workMode: 'office',
      calculationStatus: 'Late',
      lateByMinutes: 30,
      entrySource: 'device_punch',
    });
    const halfDay = addDaysToCalendarDate(today, -14);
    const rejectedDay = addDaysToCalendarDate(today, -21);
    await collection('leaverequests').insertMany([
      {
        employeeId: asId(rahul.profileId),
        leaveTypeId,
        startDate: halfDay,
        startDayPortion: 'first_half',
        endDate: halfDay,
        endDayPortion: 'first_half',
        days: [{ date: halfDay, kind: 'working', chargedCentidays: 50 }],
        status: 'APPROVED',
        reason: 'Doctor appointment in the morning',
        createdAt: new Date(),
      },
      {
        employeeId: asId(rahul.profileId),
        leaveTypeId,
        startDate: rejectedDay,
        startDayPortion: 'full',
        endDate: rejectedDay,
        endDayPortion: 'full',
        days: [{ date: rejectedDay, kind: 'working', chargedCentidays: 100 }],
        status: 'REJECTED',
        reason: 'Family function out of town',
        createdAt: new Date(),
      },
    ]);
  });

  after(async () => {
    await testServer?.stop();
    await s3?.close();
  });

  it('lets HR and administrators preview, and refuses finance, IT and employees', async () => {
    for (const client of [finance, itAdmin, employee]) {
      const refused = await preview(client, rahul.profileId);
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
    }
    const byAdmin = await preview(admin, meera.profileId);
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
    const cancelled = await admin.delete(
      `/api/nsk-bot/offboarding/cases/${byAdmin.body.data.case.id}?version=${byAdmin.body.data.case.version}`,
    );
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.case.status, 'CANCELLED');
    assert.match(await serverLogMatching(testServer, /"action":"cancel_offboarding"/), /"action":"cancel_offboarding"/);
  });

  it('previews the settlement from the latest payslip, with the banner, and refuses bad dates and self-offboarding', async () => {
    const response = await preview(hr, rahul.profileId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const offboardingCase = response.body.data.case;
    assert.equal(offboardingCase.status, 'DRAFT');
    assert.equal(offboardingCase.prefill.salarySource, 'payslip');
    assert.equal(offboardingCase.prefill.monthlyGross, 100000);
    assert.equal(offboardingCase.prefill.monthlyBasic, 50000);
    assert.equal(offboardingCase.prefill.encashableDays, 12.5);
    assert.equal(offboardingCase.employee.name, 'Rahul Sharma');
    assert.equal(offboardingCase.settlement.gratuity.eligible, true);
    assert.match(offboardingCase.complianceNote, new RegExp(offboardingCase.settlementDueDate));
    assert.ok(offboardingCase.settlementDueDate > LAST_WORKING_DAY);
    assert.ok(offboardingCase.notes.some((note) => note.includes('latest issued payslip')));
    // The figures are the calculator's for what the case holds.
    const expected = computeFinalSettlement(
      settlementInputOf({
        snapshot: offboardingCase.employee,
        separation: offboardingCase.separation,
        prefill: (await collection('offboardingcases').findOne({ _id: asId(offboardingCase.id) })).prefill,
        adjustments: offboardingCase.adjustments,
      }),
    );
    assert.deepEqual(offboardingCase.settlement.totals, expected.totals);
    if (engineIsCurrent) {
      assert.equal(offboardingCase.settlement.tax.source, 'computed');
      assert.deepEqual(offboardingCase.blockers, []);
    }

    const badDates = await preview(hr, rahul.profileId, {
      separation: separation({ lastWorkingDay: addDaysToCalendarDate(NOTICE_DATE, -1) }),
      version: offboardingCase.version,
    });
    assert.equal(badDates.status, 422);
    assert.equal(badDates.body.error.code, 'LAST_DAY_BEFORE_NOTICE');
    const tooFar = await preview(hr, rahul.profileId, {
      separation: separation({ lastWorkingDay: addDaysToCalendarDate(today, 200) }),
    });
    assert.equal(tooFar.status, 422);
    assert.equal(tooFar.body.error.code, 'LAST_DAY_TOO_FAR');
    const beforeJoining = await preview(hr, rahul.profileId, {
      separation: separation({ noticeDate: '2019-01-01', lastWorkingDay: '2019-12-31' }),
    });
    assert.equal(beforeJoining.status, 422);
    assert.equal(beforeJoining.body.error.code, 'LAST_DAY_BEFORE_JOINING');
    const hrProfile = await collection('users').findOne({ email: 'hari.hr@example.com' });
    await collection('employeeprofiles').insertOne({
      userId: hrProfile._id,
      employeeCode: 'HRSELF1',
      organizationData: (await collection('employeeprofiles').findOne({ _id: asId(meera.profileId) })).organizationData,
    });
    const hrSelf = await collection('employeeprofiles').findOne({ userId: hrProfile._id });
    const self = await preview(hr, hrSelf._id.toString());
    assert.equal(self.status, 403);
    assert.equal(self.body.error.code, 'CANNOT_OFFBOARD_SELF');
  });

  it('applies HR adjustments, and refuses a preview based on an older version', async () => {
    const current = (await preview(hr, rahul.profileId)).body.data.case;
    const adjusted = await preview(hr, rahul.profileId, {
      version: current.version,
      adjustments: {
        noticeRecoveryWaived: true,
        encashableDays: 10,
        tdsOverride: 5000,
        otherDeductions: [{ label: 'Laptop not returned', amount: 20000 }],
        otherEarnings: [{ label: 'Joining bonus clawback reversal', amount: 1000, taxable: false }],
      },
    });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    const { settlement } = adjusted.body.data.case;
    assert.equal(settlement.notice.recovery, 0);
    assert.equal(settlement.encashment.amount, Math.round((50000 / 26) * 10));
    assert.equal(settlement.tax.source, 'override');
    assert.ok(settlement.deductions.some((line) => line.label === 'Laptop not returned' && line.amount === 20000));
    assert.ok(adjusted.body.data.case.notes.includes(OFFBOARDING_MESSAGES.TDS_NOTES.override()));
    const stale = await preview(hr, rahul.profileId, { version: current.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    startedCase = adjusted.body.data.case;
  });

  it('starts offboarding: Notice status, documents in S3 with progress over Socket.IO', async () => {
    const wrongVersion = await hr.post('/api/nsk-bot/offboarding/execute', {
      caseId: startedCase.id,
      version: startedCase.version + 5,
    });
    assert.equal(wrongVersion.status, 409);
    const byFinance = await finance.post('/api/nsk-bot/offboarding/execute', {
      caseId: startedCase.id,
      version: startedCase.version,
    });
    assert.equal(byFinance.status, 403);

    const socket = io(testServer.baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Origin: TEST_APP_ORIGIN, Cookie: hr.cookieHeader() },
    });
    const progress = [];
    const completed = new Promise((resolve) => {
      socket.on('OFFBOARDING_PROGRESS', (payload) => {
        progress.push(payload);
        if (payload.status === 'COMPLETED') resolve(payload);
      });
    });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    try {
      const started = await hr.post('/api/nsk-bot/offboarding/execute', {
        caseId: startedCase.id,
        version: startedCase.version,
      });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      assert.equal(started.body.message, OFFBOARDING_MESSAGES.STARTED);
      const profile = await collection('employeeprofiles').findOne({ _id: asId(rahul.profileId) });
      assert.equal(profile.organizationData.employmentStatus, 'Notice');
      const account = await collection('users').findOne({ _id: asId(rahul.userId) });
      assert.equal(account.status, 'active');

      const done = await untilCase(startedCase.id, (item) => item?.status === 'COMPLETED');
      assert.deepEqual(
        done.artifacts.map((artifact) => artifact.kind),
        ['RELIEVING_LETTER', 'SETTLEMENT_STATEMENT', 'ATTENDANCE_AUDIT'],
      );
      assert.equal(done.progress.completedSteps, 3);
      const finalEvent = await Promise.race([
        completed,
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('no COMPLETED event')), 5_000)),
      ]);
      assert.equal(finalEvent.caseId, startedCase.id);
      assert.ok(progress.some((event) => event.progress.currentStep === 'SETTLEMENT_STATEMENT'));
      startedCase = done;
    } finally {
      socket.close();
    }
    // Stored under ids only, encrypted, never with a name in the key.
    const keys = [...s3.objects.keys()];
    assert.equal(keys.length, 3);
    for (const key of keys) {
      assert.match(key, new RegExp(`^company-offboarding/${startedCase.id}/[a-z_]+_[0-9a-f]{16}\\.(pdf|xlsx)$`));
      assert.equal(s3.objects.get(key).headers['x-amz-server-side-encryption'], 'AES256');
    }
  });

  it('downloads each document only for the roles it is for, and the bytes are the recorded ones', async () => {
    const byKind = Object.fromEntries(startedCase.artifacts.map((artifact) => [artifact.kind, artifact]));
    const download = (client, artifact) => client.get(`/api/nsk-bot/artifacts/${artifact.id}/download`);

    for (const artifact of startedCase.artifacts) {
      const response = await download(hr, artifact);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const file = await fetch(response.body.data.download.url);
      assert.equal(file.status, 200);
      assert.match(file.headers.get('content-disposition'), /^attachment; filename="/);
      const bytes = Buffer.from(await file.arrayBuffer());
      assert.equal(sha256(bytes), artifact.sha256);
      if (artifact.kind === 'ATTENDANCE_AUDIT') {
        assert.equal(bytes.subarray(0, 2).toString(), 'PK');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(bytes);
        assert.deepEqual(
          workbook.worksheets.map((sheet) => sheet.name),
          ['Summary', 'Daily Attendance Log', 'Leave Breakdown'],
        );
        const leaveRows = [];
        workbook.getWorksheet('Leave Breakdown').eachRow((row, rowNumber) => {
          if (rowNumber > 1) leaveRows.push(row.values.slice(1));
        });
        assert.ok(
          leaveRows.some((row) => row.includes('Doctor appointment in the morning') && row.includes('First half')),
        );
        assert.ok(leaveRows.some((row) => row.includes('Family function out of town') && row.includes('Rejected')));
        const dailyRows = [];
        workbook.getWorksheet('Daily Attendance Log').eachRow((row) => dailyRows.push(row.values.slice(1)));
        assert.ok(dailyRows.some((row) => row.includes('Present (late)') && row.includes('09:30')));
      } else {
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      }
    }

    const financeStatement = await download(finance, byKind.SETTLEMENT_STATEMENT);
    assert.equal(financeStatement.status, 200);
    for (const kind of ['RELIEVING_LETTER', 'ATTENDANCE_AUDIT']) {
      const refused = await download(finance, byKind[kind]);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, 'ARTIFACT_NOT_ALLOWED');
    }
    for (const artifact of startedCase.artifacts) {
      assert.equal((await download(itAdmin, artifact)).status, 403);
      assert.equal((await download(employee, artifact)).status, 403);
    }
    const financeView = await finance.get(`/api/nsk-bot/offboarding/cases/${startedCase.id}`);
    assert.equal(financeView.status, 200);
    assert.deepEqual(
      financeView.body.data.case.artifacts.map((artifact) => [artifact.kind, artifact.downloadable]),
      [
        ['RELIEVING_LETTER', false],
        ['SETTLEMENT_STATEMENT', true],
        ['ATTENDANCE_AUDIT', false],
      ],
    );
    assert.equal((await itAdmin.get(`/api/nsk-bot/offboarding/cases/${startedCase.id}`)).status, 403);
  });

  it('refuses to start or preview again once started', async () => {
    const again = await hr.post('/api/nsk-bot/offboarding/execute', {
      caseId: startedCase.id,
      version: startedCase.version,
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_STARTED');
    const repreview = await preview(hr, rahul.profileId);
    assert.equal(repreview.status, 409);
    assert.equal(repreview.body.error.code, 'ALREADY_STARTED');
  });

  it('shows IT who is serving notice and what to revoke, without pay figures', async () => {
    const response = await itAdmin.get('/api/nsk-bot/offboarding/it-checklist');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const person = response.body.data.people.find((item) => item.employeeId === rahul.profileId);
    assert.equal(person.lastWorkingDay, LAST_WORKING_DAY);
    assert.equal(person.name, 'Rahul Sharma');
    // Only people serving notice are listed.
    assert.equal(
      response.body.data.people.some((item) => item.employeeId === meera.profileId),
      false,
    );
    assert.deepEqual(response.body.data.items, [...OFFBOARDING_MESSAGES.IT_CHECKLIST_ITEMS]);
    assert.doesNotMatch(JSON.stringify(response.body), /salary|gross|settlement|100000/i);
    assert.equal((await finance.get('/api/nsk-bot/offboarding/it-checklist')).status, 403);
    assert.equal((await employee.get('/api/nsk-bot/offboarding/it-checklist')).status, 403);
  });

  it('falls back to the accepted offer, and refuses to start figures that changed since the preview', async () => {
    await collection('onboardingdrafts').insertOne({
      status: 'DISPATCHED',
      dispatch: { employeeUserId: asId(meera.userId), dispatchedAt: new Date() },
      compensation: { taxRegime: 'old' },
      terms: { noticePeriodDays: 30 },
      structure: {
        earnings: { gross: { monthly: 60000 }, basic: { monthly: 30000 } },
        employeeDeductions: {
          providentFund: { monthly: 1800 },
          esi: { monthly: 0 },
          professionalTax: { monthly: 200 },
        },
      },
    });
    const first = await preview(hr, meera.profileId, { adjustments: { tdsOverride: 0 } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const offboardingCase = first.body.data.case;
    assert.equal(offboardingCase.prefill.salarySource, 'offer');
    assert.equal(offboardingCase.prefill.monthlyGross, 60000);
    assert.equal(offboardingCase.prefill.noticePeriodDays, 30);

    // A payslip issued after the preview changes the salary the settlement starts from.
    await collection('payslips').insertOne({
      employeeId: asId(meera.profileId),
      financialYear: financialYearOf(today),
      period: { year: 2026, month: 2 },
      status: 'Issued',
      earnings: [{ code: 'BASIC', label: 'Basic Salary', amount: 35000 }],
      deductions: [],
      grossEarnings: 70000,
      totalDeductions: 0,
      netPay: 70000,
      taxSummary: { regime: 'old' },
      verification: { verificationId: 'PS-202602-AAAA-0000-0000-0002' },
    });
    const stale = await hr.post('/api/nsk-bot/offboarding/execute', {
      caseId: offboardingCase.id,
      version: offboardingCase.version,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'PREVIEW_OUT_OF_DATE');
    const profile = await collection('employeeprofiles').findOne({ _id: asId(meera.profileId) });
    assert.notEqual(profile.organizationData.employmentStatus, 'Notice');
  });

  it('asks for the salary when there is no payslip or offer, and will not start without it', async () => {
    const nobody = await onboardEmployee({
      testServer,
      hrClient: hr,
      email: 'nora@example.com',
      departmentId: (await collection('departments').findOne({ code: 'ENG' }))._id.toString(),
      name: 'Nora Nopay',
    });
    const response = await preview(hr, nobody.profileId, { adjustments: { tdsOverride: 0 } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.case.blockers, ['SALARY_REQUIRED']);
    const refused = await hr.post('/api/nsk-bot/offboarding/execute', {
      caseId: response.body.data.case.id,
      version: response.body.data.case.version,
    });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'SALARY_REQUIRED');
  });

  it('lists cases for finance, and audits changes and downloads without figures', async () => {
    const listed = await finance.get('/api/nsk-bot/offboarding/cases');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.cases.some((item) => item.id === startedCase.id));
    assert.equal((await employee.get('/api/nsk-bot/offboarding/cases')).status, 403);

    const log = await serverLogMatching(testServer, /download_offboarding_document/);
    // The log keeps its latest part only; the cancel is checked where it happens.
    for (const action of ['preview_offboarding', 'execute_offboarding', 'download_offboarding_document']) {
      assert.match(log, new RegExp(`"action":"${action}"`), action);
    }
    const auditLines = log.split('\n').filter((line) => line.includes('"category":"offboarding"'));
    assert.ok(auditLines.length > 0);
    for (const line of auditLines) assert.doesNotMatch(line, /100000|monthlyGross|settlement/);
    assert.ok(
      auditLines.some((line) => line.includes('"outcome":"denied"') && line.includes('download_offboarding_document')),
    );
  });
});
