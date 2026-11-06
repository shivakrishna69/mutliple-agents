/**
 * The knowledge ingestion pipeline (services/knowledge/ingestionRunner.js, ingestionQueue.js) on a
 * real MongoDB with GridFS, the real reader thread and chunker, and a stand-in for the AI service's
 * index (./standInKnowledgeIndex.js): documents become READY with their chunks and metadata, unusable
 * files FAIL with the lead-facing reason, index outages are retried, and a document claimed twice,
 * abandoned by its worker, or deleted mid-way ends in the right state with no stray chunks. The queue
 * runs in this process, and on BullMQ when TEST_REDIS_URL is set.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

import { KNOWLEDGE_MESSAGES } from '../../constants/messages.js';
import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import AgentDocument, { DOCUMENT_STATUSES } from '../../models/AgentDocument.js';
import { getCompanySettings } from '../../services/companySettings.js';
import { knowledgeFileStore } from '../../services/knowledge/fileStore.js';
import {
  closeKnowledgeIngestionQueue,
  dispatchDocumentIngestion,
  initKnowledgeIngestionQueue,
} from '../../services/knowledge/ingestionQueue.js';
import { runIngestion } from '../../services/knowledge/ingestionRunner.js';
import { requeueKnowledgeDocuments } from '../../services/knowledge/knowledgeBaseService.js';
import { buildDocx, buildPdf } from '../fixtures/knowledgeFiles.js';
import { startStandInKnowledgeIndex } from './standInKnowledgeIndex.js';
import { MONGO_BASE_URL, mongoUnavailableReason } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const redisSkipReason = process.env.TEST_REDIS_URL ? null : 'TEST_REDIS_URL is not set';
const API_KEY = randomBytes(32).toString('hex');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const POLL_INTERVAL_MS = 50;
const WAIT_LIMIT_MS = 30_000;

const HANDBOOK_MD = Buffer.from(
  ['# Handbook', '', 'Welcome to the team.', '', '## Leave', '', 'Everyone gets 24 days a year.', ''].join('\n'),
  'utf8',
);

/** The handbook with a line of its own, so each test's file is a different upload. */
const handbookVariant = (label) =>
  Buffer.concat([
    HANDBOOK_MD,
    Buffer.from(
      `
Note for ${label}.
`,
      'utf8',
    ),
  ]);

async function waitForStatus(documentId, statuses) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const document = await AgentDocument.findById(documentId).lean();
    if (document && statuses.includes(document.status)) return document;
    if (Date.now() > deadline) throw new Error(`document ${documentId} is still ${document?.status}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

describe('knowledge ingestion', { skip: mongoReason ?? false }, () => {
  let index;
  let config;
  let companyId;
  const departmentId = new mongoose.Types.ObjectId();
  const agentId = new mongoose.Types.ObjectId();
  const uploadedBy = new mongoose.Types.ObjectId();

  const context = (workerId = 'test-worker') => ({ config, workerId });

  async function uploadDocument(content, { originalName = 'Handbook.md', mimeType = 'text/markdown', ...fields } = {}) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const fileKey = await knowledgeFileStore.saveFile({
      content,
      fileName: originalName,
      contentType: mimeType,
      sha256,
    });
    return AgentDocument.create({
      departmentId,
      agentId,
      originalName,
      fileKey,
      mimeType,
      fileSize: content.length,
      contentSha256: sha256,
      uploadedBy,
      ...fields,
    });
  }

  before(async () => {
    await mongoose.connect(`${MONGO_BASE_URL}/nsk_test_ingest_${process.pid}_${randomBytes(4).toString('hex')}`);
    await AgentDocument.init();
    companyId = (await getCompanySettings())._id.toString();
    index = await startStandInKnowledgeIndex({ apiKey: API_KEY });
    config = { aiServiceUrl: index.url, aiServiceApiKey: API_KEY, aiServiceTimeoutMs: 5_000, redisUrl: null };
  });

  after(async () => {
    await index?.stop();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(() => {
    index.failNext(0);
  });

  it('makes a Markdown document READY, with every chunk and its metadata in the index', async () => {
    const document = await uploadDocument(HANDBOOK_MD);
    await runIngestion(document._id.toString(), context());

    const done = await AgentDocument.findById(document._id).lean();
    assert.equal(done.status, DOCUMENT_STATUSES.READY);
    assert.equal(done.errorMessage, null);
    assert.equal(done.attempts, 1);
    assert.deepEqual(done.lease, { owner: null, until: null });
    assert.ok(done.processedAt instanceof Date);

    const chunks = index.chunksOf(document._id);
    assert.equal(done.chunkCount, chunks.size);
    assert.deepEqual(
      [...chunks.values()].map((chunk) => [chunk.chunk_index, chunk.text, chunk.heading_path]),
      [
        [0, 'Welcome to the team.', ['Handbook']],
        [1, 'Everyone gets 24 days a year.', ['Handbook', 'Leave']],
      ],
    );
    for (const chunk of chunks.values()) {
      assert.equal(chunk.company_id, companyId);
      assert.equal(chunk.department_id, departmentId.toString());
      assert.equal(chunk.agent_id, agentId.toString());
      assert.equal(chunk.document_id, document._id.toString());
      assert.equal(chunk.access_level, 'DEPARTMENT');
    }
  });

  it('keeps the page of every PDF chunk, and reads Word documents', async () => {
    const pdf = await uploadDocument(buildPdf([['Page one policy.'], ['Page two policy.']]), {
      originalName: 'Policy.pdf',
      mimeType: 'application/pdf',
    });
    await runIngestion(pdf._id.toString(), context());
    assert.deepEqual(
      [...index.chunksOf(pdf._id).values()].map((chunk) => [chunk.text, chunk.page]),
      [
        ['Page one policy.', 1],
        ['Page two policy.', 2],
      ],
    );

    const docx = await uploadDocument(
      buildDocx([{ text: 'Travel', heading: 1 }, { text: 'Book through the portal.' }]),
      {
        originalName: 'Travel.docx',
        mimeType: DOCX,
      },
    );
    await runIngestion(docx._id.toString(), context());
    assert.equal((await AgentDocument.findById(docx._id)).status, DOCUMENT_STATUSES.READY);
    assert.deepEqual([...index.chunksOf(docx._id).values()][0].heading_path, ['Travel']);
  });

  it('fails a scanned PDF at once, saying why, with nothing indexed', async () => {
    const scan = await uploadDocument(buildPdf([[]]), { originalName: 'Scan.pdf', mimeType: 'application/pdf' });
    await runIngestion(scan._id.toString(), context());
    const failed = await AgentDocument.findById(scan._id).lean();
    assert.equal(failed.status, DOCUMENT_STATUSES.FAILED);
    assert.equal(failed.errorMessage, KNOWLEDGE_MESSAGES.PROCESSING_FAILURES.NO_TEXT);
    assert.equal(failed.chunkCount, 0);
    assert.equal(failed.attempts, 1);
    assert.equal(index.chunksOf(scan._id).size, 0);
  });

  it('fails a document whose stored file was changed, without reading it', async () => {
    const document = await uploadDocument(HANDBOOK_MD, { contentSha256: 'f'.repeat(64) });
    await runIngestion(document._id.toString(), context());
    const failed = await AgentDocument.findById(document._id).lean();
    assert.equal(failed.status, DOCUMENT_STATUSES.FAILED);
    assert.equal(failed.errorMessage, KNOWLEDGE_MESSAGES.PROCESSING_FAILURES.FILE_MISSING);
  });

  it('retries when the index is down, and finishes once it is back', async () => {
    const document = await uploadDocument(handbookVariant('retry'), { originalName: 'Retry.md' });
    index.failNext(1);
    await assert.rejects(runIngestion(document._id.toString(), context()));
    const waiting = await AgentDocument.findById(document._id).lean();
    assert.equal(waiting.status, DOCUMENT_STATUSES.PROCESSING);
    assert.equal(waiting.lease.owner, null, 'released for the retry');
    assert.equal(waiting.attempts, 1);

    await runIngestion(document._id.toString(), context());
    const done = await AgentDocument.findById(document._id).lean();
    assert.equal(done.status, DOCUMENT_STATUSES.READY);
    assert.equal(done.attempts, 2);
    assert.equal(index.chunksOf(document._id).size, done.chunkCount);
  });

  it('gives up after the last attempt, with the reason and no chunks', async () => {
    const document = await uploadDocument(Buffer.from('Only one fact.\n', 'utf8'), { originalName: 'Down.md' });
    index.failNext(Number.MAX_SAFE_INTEGER);
    for (let attempt = 1; attempt < KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS; attempt += 1) {
      await assert.rejects(runIngestion(document._id.toString(), context()));
    }
    await runIngestion(document._id.toString(), context());
    index.failNext(0);
    const failed = await AgentDocument.findById(document._id).lean();
    assert.equal(failed.status, DOCUMENT_STATUSES.FAILED);
    assert.equal(failed.attempts, KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS);
    assert.equal(failed.errorMessage, KNOWLEDGE_MESSAGES.PROCESSING_FAILURES.INDEX_UNAVAILABLE);
    await runIngestion(document._id.toString(), context());
    assert.equal((await AgentDocument.findById(document._id)).status, DOCUMENT_STATUSES.FAILED, 'stays failed');
  });

  it('processes a document handed to two workers at once only once', async () => {
    const document = await uploadDocument(Buffer.from('Twice handed.\n', 'utf8'), { originalName: 'Twice.md' });
    const indexingBefore = index.requests.filter((request) => request.path === '/ai/knowledge/chunks').length;
    await Promise.all([
      runIngestion(document._id.toString(), context('worker-a')),
      runIngestion(document._id.toString(), context('worker-b')),
    ]);
    const done = await AgentDocument.findById(document._id).lean();
    assert.equal(done.status, DOCUMENT_STATUSES.READY);
    assert.equal(done.attempts, 1);
    assert.equal(
      index.requests.filter((request) => request.path === '/ai/knowledge/chunks').length - indexingBefore,
      1,
    );
  });

  it('takes over from a worker that stopped, and fails a document whose attempts are used up', async () => {
    const stalled = await uploadDocument(Buffer.from('Abandoned.\n', 'utf8'), {
      originalName: 'Stalled.md',
      status: DOCUMENT_STATUSES.PROCESSING,
      attempts: 1,
      lease: { owner: 'gone-worker', until: new Date(Date.now() - 1_000) },
    });
    await runIngestion(stalled._id.toString(), context());
    assert.equal((await AgentDocument.findById(stalled._id)).status, DOCUMENT_STATUSES.READY);

    const exhausted = await uploadDocument(Buffer.from('Abandoned for good.\n', 'utf8'), {
      originalName: 'Exhausted.md',
      status: DOCUMENT_STATUSES.PROCESSING,
      attempts: KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS,
      lease: { owner: 'gone-worker', until: new Date(Date.now() - 1_000) },
    });
    await runIngestion(exhausted._id.toString(), context());
    const failed = await AgentDocument.findById(exhausted._id).lean();
    assert.equal(failed.status, DOCUMENT_STATUSES.FAILED);
    assert.equal(failed.errorMessage, KNOWLEDGE_MESSAGES.PROCESSING_FAILURES.INDEX_UNAVAILABLE);

    const held = await uploadDocument(Buffer.from('Still being worked on.\n', 'utf8'), {
      originalName: 'Held.md',
      status: DOCUMENT_STATUSES.PROCESSING,
      attempts: 1,
      lease: { owner: 'busy-worker', until: new Date(Date.now() + 60_000) },
    });
    await runIngestion(held._id.toString(), context());
    const untouched = await AgentDocument.findById(held._id).lean();
    assert.equal(untouched.lease.owner, 'busy-worker', 'a live lease is left alone');
    assert.equal(untouched.attempts, 1);
  });

  it('leaves no chunks behind when the document is deleted while it is being indexed', async () => {
    const document = await uploadDocument(handbookVariant('delete'), { originalName: 'Deleted.md' });
    const pause = index.pauseNextIndexing();
    const run = runIngestion(document._id.toString(), context());
    await pause.reached;
    await AgentDocument.updateOne({ _id: document._id }, { $set: { status: DOCUMENT_STATUSES.DELETING } });
    pause.release();
    await run;
    assert.equal(index.chunksOf(document._id).size, 0);
    assert.equal((await AgentDocument.findById(document._id)).status, DOCUMENT_STATUSES.DELETING, 'left to the delete');
  });

  it('lets a slow worker whose lease was taken over finish without touching the new worker’s document', async () => {
    const document = await uploadDocument(handbookVariant('takeover'), { originalName: 'Takeover.md' });
    const pause = index.pauseNextIndexing();
    const slowRun = runIngestion(document._id.toString(), context('slow-worker'));
    await pause.reached;
    // The slow worker's lease ran out and another worker claimed the document.
    await AgentDocument.updateOne(
      { _id: document._id },
      { $set: { lease: { owner: 'new-worker', until: new Date(Date.now() + 60_000) } } },
    );
    pause.release();
    await slowRun;
    const current = await AgentDocument.findById(document._id).lean();
    assert.equal(current.status, DOCUMENT_STATUSES.PROCESSING, 'not marked READY by the slow worker');
    assert.equal(current.lease.owner, 'new-worker');
  });

  it('replaces the chunks of an earlier run instead of adding to them', async () => {
    const document = await uploadDocument(handbookVariant('again'), { originalName: 'Again.md' });
    index.seedChunk(document._id, 999, { text: 'stale chunk from an earlier version' });
    await runIngestion(document._id.toString(), context());
    const chunks = index.chunksOf(document._id);
    assert.equal(chunks.has(999), false);
    assert.equal(chunks.size, (await AgentDocument.findById(document._id)).chunkCount);
  });

  it('indexes documents again after the index lost them, per department or everywhere, leaving work in progress alone', async () => {
    const ready = await uploadDocument(Buffer.from('Rebuilt after a loss.\n', 'utf8'), { originalName: 'Rebuild.md' });
    await runIngestion(ready._id.toString(), context());
    const otherDepartment = new mongoose.Types.ObjectId();
    const elsewhere = await uploadDocument(Buffer.from('Another department.\n', 'utf8'), {
      originalName: 'Elsewhere.md',
      departmentId: otherDepartment,
    });
    await runIngestion(elsewhere._id.toString(), context());
    const deleting = await uploadDocument(Buffer.from('On its way out.\n', 'utf8'), {
      originalName: 'Leaving.md',
      status: DOCUMENT_STATUSES.DELETING,
    });
    index.chunksOf(ready._id).clear();

    assert.ok((await requeueKnowledgeDocuments({ departmentId: departmentId.toString() })) >= 1);
    const requeued = await AgentDocument.findById(ready._id).lean();
    assert.equal(requeued.status, DOCUMENT_STATUSES.UPLOADED);
    assert.equal(requeued.attempts, 0);
    assert.equal(
      (await AgentDocument.findById(elsewhere._id)).status,
      DOCUMENT_STATUSES.READY,
      'other department untouched',
    );
    assert.equal(
      (await AgentDocument.findById(deleting._id)).status,
      DOCUMENT_STATUSES.DELETING,
      'a delete is never undone',
    );

    await runIngestion(ready._id.toString(), context());
    assert.equal((await AgentDocument.findById(ready._id)).status, DOCUMENT_STATUSES.READY);
    assert.equal(index.chunksOf(ready._id).size, 1, 'chunks rebuilt');

    await requeueKnowledgeDocuments();
    assert.equal((await AgentDocument.findById(elsewhere._id)).status, DOCUMENT_STATUSES.UPLOADED, 'every department');
    await runIngestion(elsewhere._id.toString(), context());
  });

  describe('the queue in this process', () => {
    after(() => closeKnowledgeIngestionQueue());

    it('processes a dispatched document, and the sweep picks up one uploaded before it started', async () => {
      const early = await uploadDocument(Buffer.from('Uploaded before a restart.\n', 'utf8'), {
        originalName: 'Early.md',
      });
      initKnowledgeIngestionQueue(config);
      const late = await uploadDocument(Buffer.from('Uploaded after.\n', 'utf8'), { originalName: 'Late.md' });
      await dispatchDocumentIngestion(late._id.toString());
      assert.equal((await waitForStatus(late._id, [DOCUMENT_STATUSES.READY])).chunkCount, 1);
      assert.equal((await waitForStatus(early._id, [DOCUMENT_STATUSES.READY])).chunkCount, 1);
    });
  });

  describe('the queue on BullMQ', { skip: redisSkipReason ?? false }, () => {
    after(() => closeKnowledgeIngestionQueue());

    it('processes a dispatched document through Redis', async () => {
      initKnowledgeIngestionQueue({ ...config, redisUrl: process.env.TEST_REDIS_URL });
      const document = await uploadDocument(Buffer.from('Through Redis.\n', 'utf8'), { originalName: 'Redis.md' });
      await dispatchDocumentIngestion(document._id.toString());
      const done = await waitForStatus(document._id, [DOCUMENT_STATUSES.READY]);
      assert.equal(done.attempts, 1);
      assert.equal(index.chunksOf(document._id).size, 1);
    });
  });
});
