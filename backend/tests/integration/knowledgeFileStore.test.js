/**
 * The knowledge base file store (services/knowledge/fileStore.js) on a real MongoDB: files go in and
 * come back byte for byte, damaged or missing files are refused, and deleting is safe to repeat.
 * Runs on its own throwaway database, dropped at the end.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

import {
  FILE_STORE_ERRORS,
  FileStoreError,
  KNOWLEDGE_FILE_BUCKET,
  createFileStore,
} from '../../services/knowledge/fileStore.js';
import { MONGO_BASE_URL, mongoUnavailableReason } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const sha256 = (content) => createHash('sha256').update(content).digest('hex');
// Larger than one GridFS chunk (255 KiB), so files are stored in several pieces.
const MULTI_CHUNK_BYTES = 600 * 1024;

describe('knowledge file store', { skip: mongoReason ?? false }, () => {
  let connection;
  let store;

  before(async () => {
    connection = await mongoose
      .createConnection(`${MONGO_BASE_URL}/nsk_test_files_${process.pid}_${randomBytes(4).toString('hex')}`)
      .asPromise();
    store = createFileStore(connection);
  });

  after(async () => {
    await connection?.dropDatabase();
    await connection?.close();
  });

  const save = (content, metadata = {}) =>
    store.saveFile({
      content,
      fileName: 'Handbook.pdf',
      contentType: 'application/pdf',
      sha256: sha256(content),
      metadata,
    });

  it('gives back exactly what was stored, across several GridFS chunks, with its details', async () => {
    const content = randomBytes(MULTI_CHUNK_BYTES);
    const departmentId = new mongoose.Types.ObjectId().toString();
    const fileKey = await save(content, { departmentId });
    assert.ok(mongoose.isObjectIdOrHexString(fileKey));

    const read = await store.readFile(fileKey, { expectedSha256: sha256(content) });
    assert.equal(Buffer.compare(read, content), 0);

    const stored = await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.files`).findOne();
    assert.equal(stored.length, MULTI_CHUNK_BYTES);
    assert.equal(stored.filename, 'Handbook.pdf');
    assert.deepEqual(stored.metadata, { departmentId, contentType: 'application/pdf', sha256: sha256(content) });
    assert.ok((await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.chunks`).countDocuments()) >= 3);
  });

  it('refuses a file whose bytes changed after upload', async () => {
    const content = Buffer.from('Leave policy: 24 days a year.');
    const fileKey = await save(content);
    await connection.db
      .collection(`${KNOWLEDGE_FILE_BUCKET}.chunks`)
      .updateOne(
        { files_id: new mongoose.Types.ObjectId(fileKey) },
        { $set: { data: new mongoose.mongo.Binary(Buffer.from('Leave policy: 99 days a year.')) } },
      );
    await assert.rejects(
      store.readFile(fileKey, { expectedSha256: sha256(content) }),
      (readError) => readError instanceof FileStoreError && readError.code === FILE_STORE_ERRORS.CHECKSUM_MISMATCH,
    );
  });

  it('says when a file does not exist, and refuses keys that are not file keys', async () => {
    await assert.rejects(
      store.readFile(new mongoose.Types.ObjectId().toString(), { expectedSha256: sha256(Buffer.alloc(0)) }),
      (readError) => readError instanceof FileStoreError && readError.code === FILE_STORE_ERRORS.NOT_FOUND,
    );
    for (const badKey of ['../../etc/passwd', '', { $ne: null }, null]) {
      await assert.rejects(
        store.readFile(badKey, { expectedSha256: 'x' }),
        (readError) => readError instanceof FileStoreError && readError.code === FILE_STORE_ERRORS.INVALID_KEY,
      );
      await assert.rejects(
        store.deleteFile(badKey),
        (deleteError) => deleteError.code === FILE_STORE_ERRORS.INVALID_KEY,
      );
    }
  });

  it('deletes a file and all its pieces, and a second delete is harmless', async () => {
    const fileKey = await save(randomBytes(MULTI_CHUNK_BYTES));
    const fileId = new mongoose.Types.ObjectId(fileKey);
    assert.equal(await store.deleteFile(fileKey), true);
    assert.equal(await store.deleteFile(fileKey), false);
    assert.equal(await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.files`).countDocuments({ _id: fileId }), 0);
    assert.equal(
      await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.chunks`).countDocuments({ files_id: fileId }),
      0,
    );
  });

  it('cleans up pieces left by a delete that stopped half way', async () => {
    const fileKey = await save(randomBytes(MULTI_CHUNK_BYTES));
    const fileId = new mongoose.Types.ObjectId(fileKey);
    await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.files`).deleteOne({ _id: fileId });
    assert.equal(await store.deleteFile(fileKey), false);
    assert.equal(
      await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.chunks`).countDocuments({ files_id: fileId }),
      0,
    );
  });

  it('lets two deletes of the same file race: one removes it, the other finds it gone', async () => {
    const fileKey = await save(randomBytes(MULTI_CHUNK_BYTES));
    const outcomes = await Promise.all([store.deleteFile(fileKey), store.deleteFile(fileKey)]);
    assert.deepEqual(outcomes.sort(), [false, true], 'exactly one delete removes the file');
    assert.equal(
      await connection.db
        .collection(`${KNOWLEDGE_FILE_BUCKET}.chunks`)
        .countDocuments({ files_id: new mongoose.Types.ObjectId(fileKey) }),
      0,
    );
  });
});
