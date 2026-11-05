/**
 * Employee CSV imports (routes/employeeRoutes.js /bulk-upload) against the real server: who may
 * import, files that are not usable, every row check, the background run (departments created,
 * managers before their teams, employee IDs, offices, activation links that work and are stored
 * sealed), starting only once, resuming an import a stopped server left behind, giving up after
 * repeated failures, and the BullMQ queue when a test Redis is given (TEST_REDIS_URL).
 *
 * The sample company is invented; no real people.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { officeFields, onboardEmployee } from './fixtures.js';
import { STRONG_PASSWORD, createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const redisSkipReason = process.env.TEST_REDIS_URL ? null : 'TEST_REDIS_URL is not set';
const today = new Date().toISOString().slice(0, 10);

const HEADER =
  'name,personal_email,company_email,department_code,department_name,designation,role,manager_email,' +
  'date_of_joining,work_type,employment_status,office_code';
const csvOf = (rows) => [HEADER, ...rows].join('\n');

/** Polls an import until `isDone` says so (by default: completed). */
async function waitForImport(client, jobId, isDone = (job) => job.status === 'completed') {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await client.get(`/api/employees/bulk-upload/${jobId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (isDone(response.body.data.job)) return response.body.data.job;
    if (Date.now() > deadline) throw new Error(`Import still ${response.body.data.job.status} after 30 s`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const tokenOf = (activationLink) => new URL(activationLink).pathname.split('/').pop();

describe('employee import', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let hrClient;

  before(async () => {
    // Without a mail server: rows report their links instead of pacing emails.
    testServer = await startTestServer({ mail: false });
    adminClient = await createSignedInClient(testServer, { name: 'Ada Admin', email: 'admin@example.com' });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
  });

  after(async () => {
    await testServer?.stop();
  });

  const upload = (client, content, fileName = 'employees.csv') =>
    client.upload('/api/employees/bulk-upload', { fileName, content });

  it('keeps imports to HR and administrators, and refuses files it cannot use', async () => {
    const customer = await createSignedInClient(testServer, { name: 'Cyrus', email: 'cyrus@example.com' });
    assert.equal((await upload(customer, csvOf([]))).status, 403);
    assert.equal((await customer.get('/api/employees/bulk-upload')).status, 403);

    assert.equal((await hrClient.post('/api/employees/bulk-upload', { file: 'not multipart' })).status, 415);
    const refusals = await Promise.all([
      upload(hrClient, 'PK\u0003\u0004binary\u0000spreadsheet', 'employees.xlsx'),
      upload(hrClient, HEADER),
      upload(hrClient, 'name,email\nAsha,asha@example.com'),
      upload(hrClient, 'name,"unclosed\n'),
    ]);
    assert.deepEqual(
      refusals.map((response) => [response.status, response.body.error.code]),
      [
        [400, 'FILE_NOT_CSV'],
        [400, 'FILE_EMPTY'],
        [400, 'COLUMNS_MISSING'],
        [400, 'FILE_NOT_CSV'],
      ],
    );
    assert.match(refusals[2].body.error.message, /department_code, designation, date_of_joining/);
  });

  it('checks every row and imports the good ones in the background, managers first', async () => {
    const officeResponse = await adminClient.post('/api/offices', officeFields('BLR'));
    assert.equal(officeResponse.status, 201, JSON.stringify(officeResponse.body));
    const inactive = await adminClient.post('/api/departments', { name: 'Old Unit', code: 'OLD' });
    await adminClient.patch(`/api/departments/${inactive.body.data.department.id}`, {
      isActive: false,
      version: inactive.body.data.department.version,
    });
    const legal = await adminClient.post('/api/departments', { name: 'Legal', code: 'LEG' });
    const existingManager = await onboardEmployee({
      testServer,
      hrClient: adminClient,
      email: 'maya.manager@example.com',
      departmentId: legal.body.data.department.id,
      name: 'Maya Manager',
    });

    const content = csvOf([
      // 2-7: will be imported. Rows 3 and 6 report to people further down or up the file.
      `Hana Head,hana@example.com,,PEOPLE,People Team,HR Manager,hr,,${today},Hybrid,Active,BLR`,
      `Ivan Intern,ivan@example.com,,DATA,,Data Engineer,employee,lena@example.com,2025-06-30,remote,,`,
      `Harry Exec,harry@example.com,harry.e@example.org,PEOPLE,,HR Executive,hr,hana@example.com,${today},,,`,
      `Lena Lead,lena@example.com,,DATA,Data Platform,Data Engineering Lead,,,${today},Onsite,Probation,`,
      `Dora Designer,dora@example.com,,LEG,,Graphic Designer,,maya.manager@example.com,${today},,,`,
      `Omar Ops,omar@example.com,,DATA,,Data Engineer,,ivan@example.com,${today},,,`,
      // 8-17: each has a problem.
      `X,not-an-email,,DATA,,Engineer,,,${today},,,`,
      `Ivan Twin,ivan@example.com,,DATA,,Engineer,,,${today},,,`,
      `Bad Date,bad.date@example.com,,DATA,,Engineer,,,02/11/2026,,,`,
      `Chief Person,chief@example.com,,DATA,,Chief,ceo,,${today},,,`,
      `Old Timer,old@example.com,,OLD,,Engineer,,,${today},,,`,
      `No Manager,nomgr@example.com,,DATA,,Engineer,,ghost@example.com,${today},,,`,
      `Circle One,circle1@example.com,,DATA,,Engineer,,circle2@example.com,${today},,,`,
      `Circle Two,circle2@example.com,,DATA,,Engineer,,circle1@example.com,${today},,,`,
      `Taken Address,taken@example.com,maya.manager@example.com,DATA,,Engineer,,,${today},,,`,
      `Wrong Office,office@example.com,,DATA,,Engineer,,x@example.com,${today},office,,MARS`,
      // 18: fine itself, but its manager's row (8 is not an email, so 17 instead) has problems.
      `Follower,follower@example.com,,DATA,,Engineer,,office@example.com,${today},,,`,
    ]);

    const hrUpload = await upload(hrClient, content);
    assert.equal(hrUpload.status, 201, JSON.stringify(hrUpload.body));
    const hrIssues = hrUpload.body.data.job.issues.filter((issue) => issue.field === 'role');
    assert.ok(
      hrIssues.some((issue) => issue.rowNumber === 2 && /cannot add someone as hr/.test(issue.message)),
      JSON.stringify(hrUpload.body.data.job.issues),
    );

    const uploaded = await upload(adminClient, content);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const job = uploaded.body.data.job;
    assert.equal(job.status, 'validated');
    assert.deepEqual(job.counts, { total: 17, valid: 6, invalid: 11, created: 0, failed: 0, emailed: 0, remaining: 6 });
    assert.deepEqual(job.departmentsToCreate, [
      { code: 'PEOPLE', name: 'People Team' },
      // Named by the first row that gives a name (row 5), not the first row with the code (row 3).
      { code: 'DATA', name: 'Data Platform' },
    ]);
    const issuesByRow = new Map();
    for (const issue of job.issues)
      issuesByRow.set(issue.rowNumber, [...(issuesByRow.get(issue.rowNumber) ?? []), issue.field]);
    assert.deepEqual(Object.fromEntries(issuesByRow), {
      8: ['name', 'personal_email'],
      9: ['personal_email'],
      10: ['date_of_joining'],
      11: ['role'],
      12: ['department_code'],
      13: ['manager_email'],
      14: ['manager_email'],
      15: ['manager_email'],
      16: ['company_email'],
      17: ['work_type', 'office_code', 'manager_email'],
      18: ['manager_email'],
    });
    assert.equal(
      await testServer.database.collection('users').countDocuments({ email: 'lena@example.com' }),
      0,
      'checking creates nobody',
    );

    const started = await adminClient.post(`/api/employees/bulk-upload/${job.id}/confirm`);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const again = await adminClient.post(`/api/employees/bulk-upload/${job.id}/confirm`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'IMPORT_ALREADY_STARTED');

    const finished = await waitForImport(adminClient, job.id);
    assert.equal(finished.counts.created, 6);
    assert.equal(finished.counts.failed, 0);
    assert.equal(finished.counts.emailed, 0, 'no mail server in tests');

    const results = await adminClient.get(`/api/employees/bulk-upload/${job.id}/results`);
    assert.equal(results.status, 200, JSON.stringify(results.body));
    const created = results.body.data.rows.filter((row) => row.status === 'created');
    assert.equal(created.length, 6);
    assert.equal(new Set(created.map((row) => row.employeeCode)).size, 6);
    assert.ok(created.every((row) => /^NSK\d{4}$/.test(row.employeeCode) && row.delivery === 'not_configured'));
    assert.ok(created.every((row) => row.activationLink?.startsWith('http://localhost:5173/invite/')));
    assert.equal(results.body.data.rows.find((row) => row.rowNumber === 4).companyEmail, 'harry.e@example.org');
    assert.equal(results.body.data.rows.find((row) => row.rowNumber === 9).status, 'invalid');

    // The links are stored sealed, not readable in the database.
    const storedJob = await testServer.database
      .collection('employeeimportjobs')
      .findOne({ _id: new testServer.database.base.Types.ObjectId(job.id) });
    const storedRow = storedJob.rows.find((row) => row.rowNumber === 2);
    assert.ok(storedRow.sealedInviteUrl.startsWith('v1.'));
    const linkToken = tokenOf(created.find((row) => row.rowNumber === 2).activationLink);
    assert.equal(storedRow.sealedInviteUrl.includes(linkToken), false);

    // Departments created, managers linked (including across the file's order), office assigned.
    const departments = await adminClient.get('/api/departments');
    const departmentByCode = new Map(
      departments.body.data.departments.map((department) => [department.code, department]),
    );
    assert.equal(departmentByCode.get('PEOPLE').name, 'People Team');
    assert.equal(departmentByCode.get('DATA').memberCount, 3);
    const profiles = testServer.database.collection('employeeprofiles');
    const profileOf = async (email) => {
      const account = await testServer.database.collection('users').findOne({ email });
      return profiles.findOne({ userId: account._id });
    };
    const [hana, harry, lena, ivan, omar, dora] = await Promise.all(
      ['hana', 'harry', 'lena', 'ivan', 'omar', 'dora'].map((name) => profileOf(`${name}@example.com`)),
    );
    assert.equal(harry.organizationData.reportingManagerId.toString(), hana._id.toString());
    assert.equal(ivan.organizationData.reportingManagerId.toString(), lena._id.toString());
    assert.equal(omar.organizationData.reportingManagerId.toString(), ivan._id.toString());
    assert.equal(dora.organizationData.reportingManagerId.toString(), existingManager.profileId);
    assert.equal(hana.organizationData.officeLocationId.toString(), officeResponse.body.data.office.id);
    assert.equal(ivan.organizationData.workLocationType, 'Remote');
    assert.equal(ivan.organizationData.dateOfJoining.toISOString().slice(0, 10), '2025-06-30');

    // An imported person activates their account with their link.
    const accepted = await testServer
      .createClient()
      .post(`/api/invitations/${linkToken}/accept`, { password: STRONG_PASSWORD, acceptTerms: true });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal((await testServer.createClient().login('hana@example.com')).status, 200);

    const listed = await adminClient.get('/api/employees/bulk-upload');
    assert.ok(listed.body.data.jobs.some((listedJob) => listedJob.id === job.id && listedJob.issues.length === 0));
  });

  it('refuses to start a file with nothing to import', async () => {
    const uploaded = await upload(adminClient, csvOf([`X,not-an-email,,DATA,,Engineer,,,${today},,,`]));
    assert.equal(uploaded.body.data.job.counts.valid, 0);
    const started = await adminClient.post(`/api/employees/bulk-upload/${uploaded.body.data.job.id}/confirm`);
    assert.equal(started.status, 409, JSON.stringify(started.body));
    assert.equal(started.body.error.code, 'NOTHING_TO_IMPORT');
  });
});

describe('employee import after a restart', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  const jobIds = {};

  const row = (rowNumber, email, status, extra = {}) => ({
    rowNumber,
    input: {
      name: `Person ${rowNumber}`,
      personalEmail: email,
      companyEmail: null,
      departmentCode: 'OPS',
      designation: 'Analyst',
      role: 'customer',
      managerEmail: null,
      dateOfJoining: today,
      workLocationType: 'Onsite',
      employmentStatus: 'Probation',
      officeCode: null,
    },
    existingManagerId: null,
    issues: [],
    status,
    ...extra,
  });

  const job = (rows, extra) => ({
    status: 'queued',
    fileName: 'restart.csv',
    createdBy: { userId: null, name: 'Ada Admin', role: 'admin' },
    departmentsToCreate: [{ code: 'OPS', name: 'Operations' }],
    rows,
    counts: { total: rows.length, valid: rows.length, invalid: 0, created: 0, failed: 0, emailed: 0 },
    lease: { owner: null, until: null },
    attempts: 0,
    confirmedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });

  before(async () => {
    testServer = await startTestServer({
      mail: false,
      // Imports a stopped server left behind: one interrupted mid-row (its lease ran out), one
      // that has already been tried too often.
      seedBeforeStart: async (database) => {
        const { insertedId: adminId } = await database.collection('users').insertOne({
          name: 'Ada Admin',
          email: 'seeded.admin@example.com',
          password: 'unused',
          role: 'admin',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const imports = database.collection('employeeimportjobs');
        const interrupted = job(
          [row(2, 'done.before@example.com', 'pending'), row(3, 'half.done@example.com', 'processing')],
          { status: 'running', lease: { owner: 'stopped-server', until: new Date(Date.now() - 1000) }, attempts: 1 },
        );
        interrupted.createdBy.userId = adminId;
        jobIds.interrupted = (await imports.insertOne(interrupted)).insertedId.toString();
        const exhausted = job([row(2, 'never@example.com', 'pending')], { attempts: 3 });
        exhausted.createdBy.userId = adminId;
        jobIds.exhausted = (await imports.insertOne(exhausted)).insertedId.toString();
      },
    });
    adminClient = await createSignedInClient(testServer, { name: 'Ada Admin', email: 'admin@example.com' });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('resumes an import whose worker stopped, reporting the row it was in the middle of', async () => {
    const finished = await waitForImport(adminClient, jobIds.interrupted);
    assert.equal(finished.counts.created, 1);
    assert.equal(finished.counts.failed, 1);
    const results = await adminClient.get(`/api/employees/bulk-upload/${jobIds.interrupted}/results`);
    const [done, halfDone] = results.body.data.rows;
    assert.equal(done.status, 'created');
    assert.match(done.employeeCode, /^NSK\d{4}$/);
    assert.equal(halfDone.status, 'failed');
    assert.match(halfDone.message, /Interrupted by a restart/);
    assert.equal(await testServer.database.collection('users').countDocuments({ email: 'half.done@example.com' }), 0);
  });

  it('gives up on an import that keeps failing, reporting what is left', async () => {
    const finished = await waitForImport(adminClient, jobIds.exhausted);
    assert.equal(finished.counts.failed, 1);
    const results = await adminClient.get(`/api/employees/bulk-upload/${jobIds.exhausted}/results`);
    assert.match(results.body.data.rows[0].message, /Could not be imported/);
  });
});

describe('employee import on BullMQ', { skip: skipReason ?? redisSkipReason ?? false }, () => {
  let testServer;

  before(async () => {
    testServer = await startTestServer({ mail: false, environment: { REDIS_URL: process.env.TEST_REDIS_URL } });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('runs a confirmed import through the Redis queue', async () => {
    const adminClient = await createSignedInClient(testServer, { name: 'Ada Admin', email: 'admin@example.com' });
    const uploaded = await adminClient.upload('/api/employees/bulk-upload', {
      fileName: 'queue.csv',
      content: csvOf([
        `Queue Lead,queue.lead@example.com,,QUE,Queue Team,Lead,,,${today},,,`,
        `Queue Member,queue.member@example.com,,QUE,,Analyst,,queue.lead@example.com,${today},,,`,
      ]),
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const started = await adminClient.post(`/api/employees/bulk-upload/${uploaded.body.data.job.id}/confirm`);
    assert.equal(started.status, 202);
    const finished = await waitForImport(adminClient, uploaded.body.data.job.id);
    assert.equal(finished.counts.created, 2);
  });
});
