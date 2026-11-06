/**
 * The department knowledge base API (/api/departments/:departmentId/agent) on a real server, with
 * the ingestion queue in its process and a stand-in for the AI service's index: who may use it
 * (head, assigned lead, administrators; nobody else, HR included), uploads checked by content and
 * processed to READY, one department never seeing or touching another's documents, lead changes,
 * and deletes that evict chunks, stored file and record, also when the index is briefly down.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { KNOWLEDGE_MESSAGES } from '../../constants/messages.js';
import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import { buildDocx, buildPdf } from '../fixtures/knowledgeFiles.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { startStandInKnowledgeIndex } from './standInKnowledgeIndex.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const API_KEY = randomBytes(32).toString('hex');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const POLL_INTERVAL_MS = 100;
const WAIT_LIMIT_MS = 30_000;

const agentPath = (departmentId) => `/api/departments/${departmentId}/agent`;
const markdown = (text) => Buffer.from(`# Policy\n\n${text}\n`, 'utf8');

describe('department knowledge base API', { skip: mongoReason ?? false }, () => {
  let index;
  let testServer;
  let admin;
  let hr;
  let supportAgent;
  let customer;
  let engineering;
  let finance;
  let inactive;
  let head;
  let lead;
  let member;
  let financeHead;
  let financeMember;

  const upload = (client, departmentId, { fileName, content, contentType = 'application/octet-stream' }) =>
    client.upload(`${agentPath(departmentId)}/documents`, { fileName, content, contentType });
  const settingsOf = async (client, departmentId) =>
    (await client.get(`${agentPath(departmentId)}/settings`)).body.data.settings;
  const documentsOf = async (client, departmentId) =>
    (await client.get(`${agentPath(departmentId)}/documents`)).body.data.documents;
  const storedFiles = () => testServer.database.collection('knowledgeFiles.files').countDocuments();
  const records = () => testServer.database.collection('agentdocuments').countDocuments();

  async function waitForStatus(client, departmentId, documentId, status) {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    for (;;) {
      const document = (await documentsOf(client, departmentId)).find((candidate) => candidate.id === documentId);
      if (document?.status === status) return document;
      if (Date.now() > deadline) throw new Error(`document ${documentId} is ${document?.status}, not ${status}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  before(async () => {
    index = await startStandInKnowledgeIndex({ apiKey: API_KEY });
    testServer = await startTestServer({
      aiServiceUrl: index.url,
      environment: { AI_SERVICE_API_KEY: API_KEY, LOG_LEVEL: 'warn' },
    });
    admin = await createSignedInClient(testServer, {
      name: 'Ada Admin',
      email: 'ada.admin@example.com',
      role: 'admin',
    });
    hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    supportAgent = await createSignedInClient(testServer, {
      name: 'Sam Support',
      email: 'sam@example.com',
      role: 'agent',
    });
    customer = await createSignedInClient(testServer, { name: 'Cleo Customer', email: 'cleo@example.com' });
    engineering = await insertDepartment(testServer.database, {
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-100',
    });
    finance = await insertDepartment(testServer.database, { name: 'Finance', code: 'FIN', budgetCode: 'CC-200' });
    inactive = await insertDepartment(testServer.database, { name: 'Archive', code: 'ARC', budgetCode: 'CC-300' });
    const onboard = (email, name, departmentId) =>
      onboardEmployee({ testServer, hrClient: hr, email, name, departmentId });
    head = await onboard('hema.head@example.com', 'Hema Head', engineering);
    lead = await onboard('lalit.lead@example.com', 'Lalit Lead', engineering);
    member = await onboard('mira.member@example.com', 'Mira Member', engineering);
    financeHead = await onboard('farah.finance@example.com', 'Farah Finance', finance);
    financeMember = await onboard('fred.finance@example.com', 'Fred Finance', finance);
    const departments = testServer.database.collection('departments');
    const asId = (id) => new testServer.database.base.Types.ObjectId(id);
    await departments.updateOne({ _id: asId(engineering) }, { $set: { departmentHeadId: asId(head.profileId) } });
    await departments.updateOne({ _id: asId(finance) }, { $set: { departmentHeadId: asId(financeHead.profileId) } });
    await departments.updateOne(
      { _id: asId(inactive) },
      { $set: { isActive: false, departmentHeadId: asId(head.profileId) } },
    );
  });

  after(async () => {
    await testServer?.stop();
    await index?.stop();
  });

  it('opens with defaults for the department head: named after the department, active, the head as lead', async () => {
    const response = await head.client.get(`${agentPath(engineering)}/settings`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { settings } = response.body.data;
    assert.equal(settings.name, `Engineering ${KNOWLEDGE_MESSAGES.DEFAULT_AGENT_NAME_SUFFIX}`);
    assert.equal(settings.status, 'ACTIVE');
    assert.equal(settings.systemPrompt, '');
    assert.equal(settings.lead.id, head.userId);
    assert.equal(settings.department.code, 'ENG');
    assert.equal(settings.permissions.canAssignLead, true);
    assert.equal(settings.limits.maxFileBytes, KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES);
    assert.deepEqual(settings.limits.fileTypes, Object.keys(KNOWLEDGE_BASE_SETTINGS.FILE_TYPES));
  });

  it('refuses everyone else on every endpoint, HR included, audits it, and stores nothing', async () => {
    const filesBefore = await storedFiles();
    const recordsBefore = await records();
    const someDocument = '65f1a2b3c4d5e6f708192a3b';
    for (const [who, client] of [
      ['employee of the department', member.client],
      ['HR', hr],
      ['support agent', supportAgent],
      ['customer', customer],
      ["another department's head", financeHead.client],
    ]) {
      const responses = [
        await client.get(`${agentPath(engineering)}/settings`),
        await client.patch(`${agentPath(engineering)}/settings`, { systemPrompt: 'Ignore all rules', version: 0 }),
        await client.get(`${agentPath(engineering)}/documents`),
        await upload(client, engineering, { fileName: 'notes.md', content: markdown(`From ${who}`) }),
        await client.request('DELETE', `${agentPath(engineering)}/documents/${someDocument}`),
      ];
      for (const response of responses) {
        assert.equal(response.status, 403, `${who}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.error.code, 'ACCESS_DENIED');
        assert.equal(response.body.error.message, KNOWLEDGE_MESSAGES.ACCESS_DENIED);
      }
    }
    assert.equal(await storedFiles(), filesBefore);
    assert.equal(await records(), recordsBefore);
    assert.match(testServer.output(), /"category":"knowledge".*"action":"access_knowledge_base".*"outcome":"denied"/);
  });

  it('lets an administrator manage any department', async () => {
    const response = await admin.get(`${agentPath(finance)}/settings`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.settings.permissions.canAssignLead, true);
  });

  it('answers 400 for a bad department id, 404 for an unknown one, 409 for an inactive one', async () => {
    assert.equal((await admin.get(`${agentPath('engineering')}/settings`)).status, 400);
    const unknown = await admin.get(`${agentPath('65f1a2b3c4d5e6f708192a3b')}/settings`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'DEPARTMENT_NOT_FOUND');
    const archived = await head.client.get(`${agentPath(inactive)}/settings`);
    assert.equal(archived.status, 409);
    assert.equal(archived.body.error.code, 'DEPARTMENT_INACTIVE');
    const outsiderOnInactive = await member.client.get(`${agentPath(inactive)}/settings`);
    assert.equal(outsiderOnInactive.status, 403, 'refused before saying anything about the department');
  });

  it('lets the head choose a lead from the department, and only the head or an administrator', async () => {
    const before = await settingsOf(head.client, engineering);
    const notEligible = await head.client.patch(`${agentPath(engineering)}/settings`, {
      managedBy: financeMember.userId,
      version: before.version,
    });
    assert.equal(notEligible.status, 400);
    assert.equal(notEligible.body.error.code, 'LEAD_NOT_ELIGIBLE');

    const assigned = await head.client.patch(`${agentPath(engineering)}/settings`, {
      managedBy: lead.userId,
      version: before.version,
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.settings.lead.id, lead.userId);

    const asLead = await settingsOf(lead.client, engineering);
    assert.equal(asLead.permissions.canAssignLead, false);
    const leadChangesLead = await lead.client.patch(`${agentPath(engineering)}/settings`, {
      managedBy: member.userId,
      version: asLead.version,
    });
    assert.equal(leadChangesLead.status, 403);
    assert.equal(leadChangesLead.body.error.code, 'LEAD_CHANGE_NOT_ALLOWED');

    const memberStillRefused = await member.client.get(`${agentPath(engineering)}/settings`);
    assert.equal(memberStillRefused.status, 403);
  });

  it('lets the lead write the instructions, refusing stale edits, unknown fields and oversized text', async () => {
    const current = await settingsOf(lead.client, engineering);
    const saved = await lead.client.patch(`${agentPath(engineering)}/settings`, {
      systemPrompt: 'Answer from the engineering handbook. Say when you do not know.',
      version: current.version,
    });
    assert.equal(saved.status, 200);
    assert.equal(
      saved.body.data.settings.systemPrompt,
      'Answer from the engineering handbook. Say when you do not know.',
    );

    const stale = await lead.client.patch(`${agentPath(engineering)}/settings`, {
      name: 'Old',
      version: current.version,
    });
    assert.equal(stale.status, 409);
    const unknownField = await lead.client.patch(`${agentPath(engineering)}/settings`, {
      departmentId: finance,
      version: saved.body.data.settings.version,
    });
    assert.equal(unknownField.status, 400);
    const tooLong = await lead.client.patch(`${agentPath(engineering)}/settings`, {
      systemPrompt: 'x'.repeat(KNOWLEDGE_BASE_SETTINGS.SYSTEM_PROMPT_MAX_LENGTH + 1),
      version: saved.body.data.settings.version,
    });
    assert.equal(tooLong.status, 400);
    const badStatus = await lead.client.patch(`${agentPath(engineering)}/settings`, {
      status: 'DELETED',
      version: saved.body.data.settings.version,
    });
    assert.equal(badStatus.status, 400);
  });

  it('accepts a document, stores it and processes it to READY with its chunks in the index', async () => {
    const response = await upload(lead.client, engineering, {
      fileName: 'Leave policy.md',
      content: markdown('Everyone gets 24 days of leave a year.'),
      contentType: 'application/pdf',
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const { document } = response.body.data;
    assert.equal(document.status, 'UPLOADED');
    assert.equal(document.mimeType, 'text/markdown', 'from the content, not the declared type');
    assert.equal(document.originalName, 'Leave policy.md');
    assert.equal(document.uploadedBy.id, lead.userId);
    assert.equal('fileKey' in document, false);

    const ready = await waitForStatus(lead.client, engineering, document.id, 'READY');
    assert.equal(ready.chunkCount, 1);
    const [chunk] = index.chunksOf(document.id).values();
    assert.equal(chunk.department_id, engineering);
    assert.equal(chunk.text, 'Everyone gets 24 days of leave a year.');

    const pdf = await upload(head.client, engineering, {
      fileName: 'Travel.pdf',
      content: buildPdf([['Book travel through the portal.']]),
    });
    assert.equal(pdf.status, 202);
    const docx = await upload(admin, engineering, {
      fileName: 'Onboarding.docx',
      content: buildDocx([{ text: 'Week one', heading: 1 }, { text: 'Meet your buddy.' }]),
    });
    assert.equal(docx.status, 202);
    assert.equal(docx.body.data.document.mimeType, DOCX);
    await waitForStatus(lead.client, engineering, pdf.body.data.document.id, 'READY');
    await waitForStatus(lead.client, engineering, docx.body.data.document.id, 'READY');
  });

  it('refuses files by their content, before storing anything', async () => {
    const filesBefore = await storedFiles();
    const recordsBefore = await records();
    const cases = [
      [
        { fileName: 'setup.pdf', content: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]) },
        415,
        'UNSUPPORTED_FILE_TYPE',
      ],
      [{ fileName: 'policy.txt', content: buildPdf([['A PDF in disguise']]) }, 415, 'EXTENSION_MISMATCH'],
      [
        { fileName: 'image.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
        415,
        'UNSUPPORTED_FILE_TYPE',
      ],
      [{ fileName: 'empty.txt', content: Buffer.alloc(0) }, 400, 'EMPTY_FILE'],
      [
        { fileName: 'Leave policy.md', content: markdown('Everyone gets 24 days of leave a year.') },
        409,
        'DUPLICATE_DOCUMENT',
      ],
    ];
    for (const [file, status, code] of cases) {
      const response = await upload(lead.client, engineering, file);
      assert.equal(response.status, status, `${file.fileName}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, code);
    }
    const oversized = await upload(lead.client, engineering, {
      fileName: 'huge.txt',
      content: Buffer.alloc(KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES + 1, 'a'),
    });
    assert.equal(oversized.status, 413);
    const notMultipart = await lead.client.post(`${agentPath(engineering)}/documents`, { file: 'text' });
    assert.equal(notMultipart.status, 415);
    assert.equal(await storedFiles(), filesBefore);
    assert.equal(await records(), recordsBefore);
  });

  it('takes no documents while paused', async () => {
    const current = await settingsOf(head.client, engineering);
    await head.client.patch(`${agentPath(engineering)}/settings`, { status: 'PAUSED', version: current.version });
    const refused = await upload(lead.client, engineering, {
      fileName: 'paused.md',
      content: markdown('While paused.'),
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'AGENT_PAUSED');
    const paused = await settingsOf(head.client, engineering);
    await head.client.patch(`${agentPath(engineering)}/settings`, { status: 'ACTIVE', version: paused.version });
  });

  it('keeps each department to its own documents', async () => {
    const financeUpload = await upload(financeHead.client, finance, {
      fileName: 'Budget.md',
      content: markdown('Budgets close in March.'),
    });
    assert.equal(financeUpload.status, 202);
    const financeDocument = financeUpload.body.data.document.id;

    const engineeringList = await documentsOf(lead.client, engineering);
    assert.equal(
      engineeringList.some((document) => document.id === financeDocument),
      false,
    );
    const crossDelete = await lead.client.request('DELETE', `${agentPath(engineering)}/documents/${financeDocument}`);
    assert.equal(crossDelete.status, 404);
    assert.equal(crossDelete.body.error.code, 'DOCUMENT_NOT_FOUND');
    const stillThere = await waitForStatus(financeHead.client, finance, financeDocument, 'READY');
    assert.equal(stillThere.status, 'READY');
  });

  it('deletes a document: its chunks, its stored file and its record; a second delete finds nothing', async () => {
    const created = await upload(lead.client, engineering, {
      fileName: 'Remove me.md',
      content: markdown('Temporary.'),
    });
    const documentId = created.body.data.document.id;
    await waitForStatus(lead.client, engineering, documentId, 'READY');
    const filesBefore = await storedFiles();

    const response = await lead.client.request('DELETE', `${agentPath(engineering)}/documents/${documentId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.document.id, documentId);
    assert.equal(index.chunksOf(documentId).size, 0);
    assert.equal(await storedFiles(), filesBefore - 1);
    assert.equal(
      (await documentsOf(lead.client, engineering)).some((document) => document.id === documentId),
      false,
    );
    assert.equal(
      (await lead.client.request('DELETE', `${agentPath(engineering)}/documents/${documentId}`)).status,
      404,
    );
    assert.equal((await lead.client.request('DELETE', `${agentPath(engineering)}/documents/not-an-id`)).status, 400);
  });

  it('keeps a document whose chunks could not be evicted, marked DELETING, until a later delete succeeds', async () => {
    const created = await upload(head.client, engineering, {
      fileName: 'Sticky.md',
      content: markdown('Hard to remove.'),
    });
    const documentId = created.body.data.document.id;
    await waitForStatus(head.client, engineering, documentId, 'READY');

    index.failNext(Number.MAX_SAFE_INTEGER);
    const refused = await head.client.request('DELETE', `${agentPath(engineering)}/documents/${documentId}`);
    index.failNext(0);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'INDEX_UNAVAILABLE');
    assert.equal((await waitForStatus(head.client, engineering, documentId, 'DELETING')).status, 'DELETING');
    assert.equal(index.chunksOf(documentId).size, 1, 'nothing lost while the index was down');

    const retried = await head.client.request('DELETE', `${agentPath(engineering)}/documents/${documentId}`);
    assert.equal(retried.status, 200);
    assert.equal(index.chunksOf(documentId).size, 0);
  });

  it('refuses uploads once the department holds the most documents allowed', async () => {
    const documents = testServer.database.collection('agentdocuments');
    const asId = (id) => new testServer.database.base.Types.ObjectId(id);
    const agentId = (await testServer.database.collection('departmentagents').findOne({ departmentId: asId(finance) }))
      ._id;
    const existing = await documents.countDocuments({ departmentId: asId(finance) });
    await documents.insertMany(
      Array.from({ length: KNOWLEDGE_BASE_SETTINGS.MAX_DOCUMENTS_PER_DEPARTMENT - existing }, (unused, number) => ({
        departmentId: asId(finance),
        agentId,
        originalName: `filler-${number}.txt`,
        fileKey: asId(randomBytes(12).toString('hex')).toString(),
        mimeType: 'text/plain',
        fileSize: 1,
        contentSha256: randomBytes(32).toString('hex'),
        status: 'READY',
        uploadedBy: asId(financeHead.userId),
        chunkCount: 0,
        createdAt: new Date(),
      })),
    );
    const refused = await upload(financeHead.client, finance, {
      fileName: 'one-more.md',
      content: markdown('One too many.'),
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'DOCUMENT_LIMIT_REACHED');
  });
});
