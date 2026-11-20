/**
 * The Form 16 portal against the real server (routes/taxRoutes.js), with S3 as an in-process stand-in
 * (s3StandIn.js) reached through the real AWS SDK:
 *   - employees at ₹11,99,999 and ₹12,00,000 (and one without a CTC) never appear to a CA and are
 *     404 everywhere a CA names them; ₹12,00,001 is listed, counted, searchable and can be uploaded for;
 *   - uploads: only PDFs, at most 10 MB, only by MANAGE_FORM16; a second upload supersedes the first;
 *   - an employee sees their own Form 16 (or eligible: false) and downloads it; another employee's
 *     Form 16 is 404 to them; downloads are audited;
 *   - a CA is refused the employee workspace, and only an admin can make someone a CA;
 *   - HR sets annual CTC through the API.
 */

import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FORM16_SETTINGS } from '../../constants/validation.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { serverLogMatching } from './nskStandIn.js';
import { startS3StandIn } from './s3StandIn.js';
import { TEST_ADMIN_EMAIL, createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const pdfBytes = (label) => Buffer.from(`%PDF-1.7\n% Form 16 ${label}\n%%EOF\n`, 'latin1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('Form 16 portal', { skip: mongoReason ?? false }, () => {
  let testServer;
  let s3;
  let admin;
  let hr;
  let ca;
  let itAdmin;
  let financialYear;
  /** Employees by CTC label: { client, userId, profileId }. */
  const staff = {};
  let firstDocumentId;
  let secondDocumentId;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const setCtc = (profileId, annualCtc) =>
    testServer.database
      .collection('employeeprofiles')
      .updateOne({ _id: asId(profileId) }, { $set: { 'compensation.annualCtc': annualCtc } });
  const uploadForm16 = (client, profileId, { bytes = pdfBytes('v1'), fileName = 'form16.pdf', fields = {} } = {}) => {
    const form = new FormData();
    form.append('financialYear', financialYear);
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), fileName);
    return client.request('POST', `/api/tax/ca/employees/${profileId}/form16`, { body: form });
  };

  before(async () => {
    s3 = await startS3StandIn();
    testServer = await startTestServer({
      mail: false,
      environment: { ...s3.environmentFor('TAX_DOCS'), LOG_LEVEL: 'info' },
    });
    admin = await createSignedInClient(testServer, { name: 'Ada Admin', email: TEST_ADMIN_EMAIL });
    hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    ca = await createSignedInClient(testServer, { name: 'Chitra CA', email: 'chitra.ca@example.com', role: 'ca' });
    itAdmin = await createSignedInClient(testServer, { name: 'Ivo IT', email: 'ivo@example.com', role: 'it_admin' });
    const departmentId = await insertDepartment(testServer.database, { name: 'Engineering', code: 'ENG' });
    const people = [
      ['below', 'Bala Below', 1_199_999],
      ['at', 'Asha AtThreshold', 1_200_000],
      ['above', 'Arjun Above', 1_200_001],
      ['high', 'Hema High', 2_400_000],
      ['unknown', 'Uma Unknown', null],
    ];
    for (const [key, name, annualCtc] of people) {
      staff[key] = await onboardEmployee({
        testServer,
        hrClient: hr,
        email: `${key}@example.com`,
        departmentId,
        name,
      });
      if (annualCtc !== null) await setCtc(staff[key].profileId, annualCtc);
    }
    financialYear = (await ca.get('/api/tax/years')).body.data.financialYears[0];
  });

  after(async () => {
    await testServer?.stop();
    await s3?.close();
  });

  it('lists and counts only employees above ₹12,00,000', async () => {
    const response = await ca.get(`/api/tax/ca/employees?fy=${financialYear}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { summary, employees } = response.body.data;
    assert.deepEqual(summary, { eligible: 2, uploaded: 0, pending: 2 });
    assert.deepEqual(employees.map((employee) => employee.name).sort(), ['Arjun Above', 'Hema High']);
    assert.ok(employees.every((employee) => employee.form16Status === 'pending' && employee.documents.length === 0));

    for (const search of ['Bala', 'Asha', 'below@example.com', 'Uma']) {
      const searched = await ca.get(`/api/tax/ca/employees?search=${encodeURIComponent(search)}`);
      assert.deepEqual(searched.body.data.employees, [], search);
    }
    const found = await ca.get('/api/tax/ca/employees?search=arjun');
    assert.deepEqual(
      found.body.data.employees.map((employee) => employee.employeeId),
      [staff.above.profileId],
    );
  });

  it('answers 404 for every CA request that names an employee at or below the threshold', async () => {
    for (const key of ['below', 'at', 'unknown']) {
      const { profileId } = staff[key];
      assert.equal((await ca.get(`/api/tax/ca/employees/${profileId}`)).status, 404, key);
      const upload = await uploadForm16(ca, profileId);
      assert.equal(upload.status, 404, `${key}: ${JSON.stringify(upload.body)}`);
    }
    assert.equal((await ca.get('/api/tax/ca/employees/not-an-id')).status, 404);
    assert.equal(s3.objects.size, 0, 'nothing is kept for a refused upload');
  });

  it('shows an eligible employee their CTC, the year’s TDS and an empty history', async () => {
    const response = await ca.get(`/api/tax/ca/employees/${staff.above.profileId}?fy=${financialYear}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { employee, ctc, taxDeducted, history } = response.body.data;
    assert.equal(employee.annualCtc, 1_200_001);
    assert.equal(ctc.annualCtc, 1_200_001);
    assert.equal(ctc.split, null, 'hired by invitation: no offer split');
    assert.deepEqual(taxDeducted.totals, { grossEarnings: 0, tds: 0 });
    assert.deepEqual(history, []);
  });

  it('accepts only PDFs of at most 10 MB, and only from MANAGE_FORM16', async () => {
    const notPdf = await uploadForm16(ca, staff.above.profileId, {
      bytes: Buffer.from('plain text'),
      fileName: 'a.pdf',
    });
    assert.equal(notPdf.status, 415, JSON.stringify(notPdf.body));
    const tooLarge = await uploadForm16(ca, staff.above.profileId, {
      bytes: Buffer.concat([pdfBytes('big'), Buffer.alloc(FORM16_SETTINGS.MAX_FILE_BYTES)]),
    });
    assert.equal(tooLarge.status, 413, JSON.stringify(tooLarge.body));
    const badSummary = await uploadForm16(ca, staff.above.profileId, {
      fields: { computationSummary: '{"tdsDeducted":-5}' },
    });
    assert.equal(badSummary.status, 400);
    for (const client of [hr, staff.above.client, itAdmin]) {
      assert.equal((await uploadForm16(client, staff.above.profileId)).status, 403);
    }
    assert.equal(s3.objects.size, 0);
  });

  it('stores a Form 16 and supersedes it cleanly on a second upload', async () => {
    const firstBytes = pdfBytes('version one');
    const first = await uploadForm16(ca, staff.above.profileId, {
      bytes: firstBytes,
      fields: { computationSummary: JSON.stringify({ tdsDeducted: 12500, taxRegime: 'new', caRemarks: 'First' }) },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstDocument = first.body.data.document;
    firstDocumentId = firstDocument.id;
    assert.equal(firstDocument.version, 1);
    assert.equal(firstDocument.status, 'ACTIVE');
    assert.equal(firstDocument.partType, 'CONSOLIDATED');
    assert.equal(firstDocument.sha256Checksum, sha256(firstBytes));
    assert.equal(firstDocument.computationSummary.tdsDeducted, 12500);
    assert.equal(first.body.data.supersededId, null);
    assert.equal(firstDocument.s3Key, undefined);
    const storedKey = `company-tax-docs/form16/${financialYear}/${staff.above.profileId}/${firstDocumentId}.pdf`;
    assert.deepEqual(s3.objects.get(storedKey)?.body, firstBytes);

    const second = await uploadForm16(admin, staff.above.profileId, { bytes: pdfBytes('version two') });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    secondDocumentId = second.body.data.document.id;
    assert.equal(second.body.data.document.version, 2);
    assert.equal(second.body.data.supersededId, firstDocumentId);

    const records = await testServer.database
      .collection('form16records')
      .find({ employeeId: asId(staff.above.profileId) })
      .sort({ version: 1 })
      .toArray();
    assert.deepEqual(
      records.map((record) => [record.version, record.status]),
      [
        [1, 'SUPERSEDED'],
        [2, 'ACTIVE'],
      ],
    );
    assert.equal(records[0].supersededBy.toString(), secondDocumentId);
    assert.ok(records[0].supersededAt instanceof Date);

    const detail = await ca.get(`/api/tax/ca/employees/${staff.above.profileId}?fy=${financialYear}`);
    assert.deepEqual(
      detail.body.data.history.map((document) => [document.version, document.status]),
      [
        [2, 'ACTIVE'],
        [1, 'SUPERSEDED'],
      ],
    );
    const list = await ca.get(`/api/tax/ca/employees?fy=${financialYear}`);
    assert.deepEqual(list.body.data.summary, { eligible: 2, uploaded: 1, pending: 1 });
    const pending = await ca.get(`/api/tax/ca/employees?fy=${financialYear}&status=pending`);
    assert.deepEqual(
      pending.body.data.employees.map((employee) => employee.name),
      ['Hema High'],
    );
  });

  it('shows employees their own Form 16, or that they are not eligible', async () => {
    const own = await staff.above.client.get(`/api/tax/my-form16?fy=${financialYear}`);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.eligible, true);
    assert.deepEqual(
      own.body.data.documents.map((document) => [document.id, document.version]),
      [[secondDocumentId, 2]],
    );
    const pendingOwn = await staff.high.client.get('/api/tax/my-form16');
    assert.deepEqual([pendingOwn.body.data.eligible, pendingOwn.body.data.documents], [true, []]);
    assert.match(pendingOwn.body.data.notice, /has not been uploaded yet/);
    assert.equal(own.body.data.notice, null);
    for (const key of ['below', 'at', 'unknown']) {
      const notEligible = await staff[key].client.get('/api/tax/my-form16');
      assert.deepEqual([notEligible.body.data.eligible, notEligible.body.data.documents], [false, []], key);
      assert.match(notEligible.body.data.notice, /above ₹12,00,000/, key);
    }
    assert.equal((await ca.get('/api/tax/my-form16')).status, 403);
    assert.equal((await staff.below.client.get('/api/tax/ca/employees')).status, 403);
  });

  it('downloads for the owner and the CA, and is not found for anyone else; downloads are audited', async () => {
    const owner = await staff.above.client.get(`/api/tax/form16/${secondDocumentId}/download`);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    const fetched = await fetch(owner.body.data.download.downloadUrl);
    assert.equal(fetched.status, 200);
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), pdfBytes('version two'));
    assert.ok(Date.parse(owner.body.data.download.expiresAt) - Date.now() <= 60_000);

    assert.equal((await ca.get(`/api/tax/form16/${firstDocumentId}/download`)).status, 200);
    for (const client of [staff.high.client, staff.below.client, hr]) {
      assert.equal((await client.get(`/api/tax/form16/${secondDocumentId}/download`)).status, 404);
    }
    assert.equal((await staff.above.client.get('/api/tax/form16/65f1a2b3c4d5e6f708192a3b/download')).status, 404);

    const output = await serverLogMatching(testServer, /FORM16_DOWNLOADED rejected/);
    assert.match(output, /audit form16\.FORM16_DOWNLOADED allowed/);
    assert.match(output, /audit form16\.FORM16_DOWNLOADED rejected/);
    assert.match(output, /audit form16\.FORM16_UPLOADED allowed/);
    assert.doesNotMatch(output, /X-Amz-Signature=[0-9a-f]{20}/, 'the signed link is never logged');
  });

  it('hides a Form 16 once the employee’s CTC drops to the threshold', async () => {
    await setCtc(staff.above.profileId, 1_200_000);
    assert.equal((await ca.get(`/api/tax/form16/${secondDocumentId}/download`)).status, 404);
    assert.equal((await ca.get(`/api/tax/ca/employees/${staff.above.profileId}`)).status, 404);
    const own = await staff.above.client.get('/api/tax/my-form16');
    assert.deepEqual([own.body.data.eligible, own.body.data.documents], [false, []]);
    await setCtc(staff.above.profileId, 1_200_001);
  });

  it('keeps a CA out of the employee workspace', async () => {
    for (const path of [
      '/api/attendance/me/today',
      '/api/leave/balances',
      '/api/payroll/payslips',
      '/api/dashboard/overview',
      '/api/okrs/alignment',
      `/api/vault/employees/${staff.above.profileId}/documents`,
      '/api/presence/me',
    ]) {
      assert.equal((await ca.get(path)).status, 403, path);
    }
    const me = await ca.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data.user.capabilities, ['manage_form16']);
  });

  it('lets only an admin make someone a CA', async () => {
    const target = await createSignedInClient(testServer, { name: 'Tara Target', email: 'tara@example.com' });
    const { user } = (await target.get('/api/auth/me')).body.data;
    const byItAdmin = await itAdmin.patch(`/api/admin/users/${user.id}/role`, { role: 'ca' });
    assert.equal(byItAdmin.status, 403, JSON.stringify(byItAdmin.body));
    const byAdmin = await admin.patch(`/api/admin/users/${user.id}/role`, { role: 'ca' });
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
    const caUser = (await admin.get('/api/admin/users?role=ca')).body.data.users.find((entry) => entry.id === user.id);
    assert.ok(caUser);
    assert.equal((await itAdmin.patch(`/api/admin/users/${user.id}/role`, { role: 'employee' })).status, 403);
  });

  it('lets HR set an annual CTC, and refuses anyone without manage_compensation', async () => {
    const changed = await hr.put(`/api/employees/${staff.below.profileId}/compensation`, {
      annualCtc: 1_800_000,
      effectiveFrom: '2026-04-01',
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(
      { annualCtc: changed.body.data.compensation.annualCtc, source: changed.body.data.compensation.source },
      { annualCtc: 1_800_000, source: 'manual' },
    );
    const list = await hr.get('/api/employees/compensation');
    assert.equal(
      list.body.data.compensation.find((entry) => entry.employeeId === staff.below.profileId).annualCtc,
      1_800_000,
    );
    assert.equal(
      (await ca.get(`/api/tax/ca/employees/${staff.below.profileId}`)).status,
      200,
      'now above the threshold',
    );
    assert.equal((await itAdmin.get('/api/employees/compensation')).status, 403);
    assert.equal((await ca.put(`/api/employees/${staff.below.profileId}/compensation`, { annualCtc: 1 })).status, 403);
    const invalid = await hr.put(`/api/employees/${staff.below.profileId}/compensation`, { annualCtc: 99 });
    assert.equal(invalid.status, 400);

    const directory = await hr.get('/api/employees');
    assert.ok(
      directory.body.data.employees.every((employee) => !('compensation' in employee) && !('annualCtc' in employee)),
      'the general directory never carries salary',
    );
  });
});
