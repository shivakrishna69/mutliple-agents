/**
 * The knowledge base models' own rules (models/DepartmentAgent.js, models/AgentDocument.js),
 * checked with Mongoose validation alone: no database is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import AgentDocument, { DOCUMENT_STATUSES } from '../../models/AgentDocument.js';
import DepartmentAgent, { AGENT_STATUSES } from '../../models/DepartmentAgent.js';

const objectId = () => new mongoose.Types.ObjectId();
const errorPaths = (document) => Object.keys(document.validateSync()?.errors ?? {}).sort();

const validAgent = (overrides = {}) =>
  new DepartmentAgent({
    departmentId: objectId(),
    name: 'Engineering Department Agent',
    createdByUserId: objectId(),
    ...overrides,
  });

const validDocument = (overrides = {}) =>
  new AgentDocument({
    departmentId: objectId(),
    agentId: objectId(),
    originalName: 'Handbook.pdf',
    fileKey: objectId().toString(),
    mimeType: 'application/pdf',
    fileSize: 1_024,
    contentSha256: 'a'.repeat(64),
    uploadedBy: objectId(),
    ...overrides,
  });

describe('DepartmentAgent', () => {
  it('starts active, with no instructions and no lead', () => {
    const agent = validAgent();
    assert.deepEqual(errorPaths(agent), []);
    assert.equal(agent.status, AGENT_STATUSES.ACTIVE);
    assert.equal(agent.systemPrompt, '');
    assert.equal(agent.managedBy, null);
  });

  it('requires its department, a name and who created it', () => {
    const agent = new DepartmentAgent({});
    assert.deepEqual(errorPaths(agent), ['createdByUserId', 'departmentId', 'name']);
  });

  it('keeps the name and instructions within their limits, and the status to its two values', () => {
    const agent = validAgent({
      name: 'n'.repeat(KNOWLEDGE_BASE_SETTINGS.AGENT_NAME_MAX_LENGTH + 1),
      systemPrompt: 'p'.repeat(KNOWLEDGE_BASE_SETTINGS.SYSTEM_PROMPT_MAX_LENGTH + 1),
      status: 'DELETED',
    });
    assert.deepEqual(errorPaths(agent), ['name', 'status', 'systemPrompt']);
    assert.deepEqual(
      errorPaths(
        validAgent({
          name: 'n'.repeat(KNOWLEDGE_BASE_SETTINGS.AGENT_NAME_MAX_LENGTH),
          systemPrompt: 'p'.repeat(KNOWLEDGE_BASE_SETTINGS.SYSTEM_PROMPT_MAX_LENGTH),
          status: AGENT_STATUSES.PAUSED,
        }),
      ),
      [],
    );
  });

  it('is one per department, and versions every change', () => {
    const departmentIndex = DepartmentAgent.schema
      .indexes()
      .find(([fields]) => Object.keys(fields).join() === 'departmentId');
    assert.equal(departmentIndex?.[1].unique, true);
    assert.equal(DepartmentAgent.schema.options.optimisticConcurrency, true);
  });

  it('never moves to another department', () => {
    const agent = validAgent();
    agent.isNew = false;
    const original = agent.departmentId;
    agent.departmentId = objectId();
    assert.equal(agent.departmentId.toString(), original.toString());
  });
});

describe('AgentDocument', () => {
  it('starts uploaded, with no chunks, no error and no lease', () => {
    const document = validDocument();
    assert.deepEqual(errorPaths(document), []);
    assert.equal(document.status, DOCUMENT_STATUSES.UPLOADED);
    assert.equal(document.chunkCount, 0);
    assert.equal(document.errorMessage, null);
    assert.equal(document.lease.owner, null);
    assert.equal(document.attempts, 0);
  });

  it('accepts only the knowledge base file types', () => {
    for (const mimeType of Object.keys(KNOWLEDGE_BASE_SETTINGS.FILE_TYPES)) {
      assert.deepEqual(errorPaths(validDocument({ mimeType })), [], mimeType);
    }
    for (const mimeType of ['image/png', 'application/zip', 'application/msword', 'text/html']) {
      assert.deepEqual(errorPaths(validDocument({ mimeType })), ['mimeType'], mimeType);
    }
  });

  it('keeps the size, the chunk count and the error message within their limits', () => {
    assert.deepEqual(errorPaths(validDocument({ fileSize: 0 })), ['fileSize']);
    assert.deepEqual(errorPaths(validDocument({ fileSize: 1.5 })), ['fileSize']);
    assert.deepEqual(errorPaths(validDocument({ fileSize: KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES + 1 })), ['fileSize']);
    assert.deepEqual(errorPaths(validDocument({ fileSize: KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES })), []);
    assert.deepEqual(errorPaths(validDocument({ chunkCount: -1 })), ['chunkCount']);
    assert.deepEqual(errorPaths(validDocument({ chunkCount: KNOWLEDGE_BASE_SETTINGS.MAX_CHUNKS_PER_DOCUMENT + 1 })), [
      'chunkCount',
    ]);
    assert.deepEqual(
      errorPaths(validDocument({ errorMessage: 'e'.repeat(KNOWLEDGE_BASE_SETTINGS.ERROR_MESSAGE_MAX_LENGTH + 1) })),
      ['errorMessage'],
    );
  });

  it('requires a SHA-256 of the content and a known status', () => {
    assert.deepEqual(errorPaths(validDocument({ contentSha256: 'not-a-hash' })), ['contentSha256']);
    assert.deepEqual(errorPaths(validDocument({ contentSha256: 'A'.repeat(64) })), ['contentSha256']);
    assert.deepEqual(errorPaths(validDocument({ status: 'ARCHIVED' })), ['status']);
  });

  it('holds one copy of a file per department', () => {
    const duplicateIndex = AgentDocument.schema
      .indexes()
      .find(([fields]) => Object.keys(fields).join() === 'departmentId,contentSha256');
    assert.equal(duplicateIndex?.[1].unique, true);
  });

  it('never changes what was uploaded, or by whom', () => {
    const document = validDocument();
    document.isNew = false;
    const before = document.toObject();
    Object.assign(document, {
      departmentId: objectId(),
      agentId: objectId(),
      fileKey: 'elsewhere',
      mimeType: 'text/plain',
      fileSize: 2,
      contentSha256: 'b'.repeat(64),
      uploadedBy: objectId(),
    });
    for (const path of ['departmentId', 'agentId', 'fileKey', 'mimeType', 'fileSize', 'contentSha256', 'uploadedBy']) {
      assert.equal(String(document[path]), String(before[path]), path);
    }
  });
});
