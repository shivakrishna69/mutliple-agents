/**
 * Where the original files of department knowledge bases are kept: MongoDB GridFS, in the bucket
 * KNOWLEDGE_FILE_BUCKET of the app's own database. No other service is needed, and the database
 * backup (deploy/backup-mongo.sh) covers the files too.
 *
 * Callers only see this interface, so another store (an S3 bucket, for instance) can replace it
 * without touching them:
 *
 *   saveFile({ content, fileName, contentType, sha256, metadata })   → fileKey (string)
 *   readFile(fileKey, { expectedSha256 })                            → Buffer
 *   deleteFile(fileKey)                                              → true if removed, false if
 *                                                                      it was already gone
 *
 * A file key is opaque: it is stored on the document record (AgentDocument.fileKey) and never
 * returned to clients. Reading checks the bytes against the SHA-256 recorded at upload, so a damaged
 * or swapped file is never processed. Deleting is safe to repeat.
 */

import { createHash } from 'node:crypto';
import mongoose from 'mongoose';

export const KNOWLEDGE_FILE_BUCKET = 'knowledgeFiles';

/** The file does not exist, could not be read whole, or its content is not what was uploaded. */
export class FileStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FileStoreError';
    this.code = code;
  }
}

export const FILE_STORE_ERRORS = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  INVALID_KEY: 'INVALID_KEY',
});

function parseFileKey(fileKey) {
  if (typeof fileKey !== 'string' || !mongoose.isObjectIdOrHexString(fileKey)) {
    throw new FileStoreError(FILE_STORE_ERRORS.INVALID_KEY, 'Invalid file key');
  }
  return new mongoose.Types.ObjectId(fileKey);
}

/**
 * A file store on one Mongoose connection (the app's default connection unless given), so tests
 * can point it at a throwaway database.
 * @param {import('mongoose').Connection} [connection]
 */
export function createFileStore(connection = mongoose.connection) {
  const bucket = () => new mongoose.mongo.GridFSBucket(connection.db, { bucketName: KNOWLEDGE_FILE_BUCKET });
  const fileExists = async (fileId) =>
    (await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.files`).countDocuments({ _id: fileId }, { limit: 1 })) >
    0;

  async function saveFile({ content, fileName, contentType, sha256, metadata = {} }) {
    const uploadStream = bucket().openUploadStream(fileName, { metadata: { ...metadata, contentType, sha256 } });
    await new Promise((resolve, reject) => {
      uploadStream.once('finish', resolve);
      uploadStream.once('error', reject);
      uploadStream.end(content);
    });
    return uploadStream.id.toString();
  }

  async function readFile(fileKey, { expectedSha256 }) {
    const fileId = parseFileKey(fileKey);
    const chunks = [];
    try {
      for await (const chunk of bucket().openDownloadStream(fileId)) chunks.push(chunk);
    } catch (downloadError) {
      // The driver marks a missing file with code ENOENT (mongodb/lib/gridfs/download.js).
      if (downloadError.code === 'ENOENT') throw new FileStoreError(FILE_STORE_ERRORS.NOT_FOUND, 'File not found');
      throw downloadError;
    }
    const content = Buffer.concat(chunks);
    if (createHash('sha256').update(content).digest('hex') !== expectedSha256) {
      throw new FileStoreError(FILE_STORE_ERRORS.CHECKSUM_MISMATCH, 'File content does not match its checksum');
    }
    return content;
  }

  async function deleteFile(fileKey) {
    const fileId = parseFileKey(fileKey);
    if (!(await fileExists(fileId))) {
      // Already gone; a delete that stopped half way may have left chunks behind.
      await connection.db.collection(`${KNOWLEDGE_FILE_BUCKET}.chunks`).deleteMany({ files_id: fileId });
      return false;
    }
    try {
      await bucket().delete(fileId);
      return true;
    } catch (deleteError) {
      // Another delete of the same file finished first.
      if (!(await fileExists(fileId))) return false;
      throw deleteError;
    }
  }

  return { saveFile, readFile, deleteFile };
}

/** The app's file store, on its default database connection. */
export const knowledgeFileStore = createFileStore();
