/**
 * AgentDocument: one file in a department's knowledge base, and where its processing stands.
 *
 *   UPLOADED ──worker claims it──► PROCESSING ──► READY   (chunks are in the vector index)
 *                                       │    └──► FAILED  (errorMessage says why; no chunks kept)
 *                                       └── worker stopped: the lease runs out, the sweep hands it
 *                                           out again, up to KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS
 *   any status ──delete──► DELETING ──► removed (chunks evicted, then the file, then this record)
 *
 * DELETING makes a delete during processing safe: the worker checks the status before and after it
 * indexes, and evicting a document's chunks is safe to repeat.
 *
 *   fileKey         where the original file is stored (services/knowledge/fileStore.js); never
 *                   returned to clients
 *   mimeType        the type detected from the file's content, one of KNOWLEDGE_BASE_SETTINGS.FILE_TYPES
 *   contentSha256   the same file cannot be in one department's knowledge base twice
 *   lease           the worker processing it, and until when
 */

import mongoose from 'mongoose';
import { KNOWLEDGE_BASE_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const DOCUMENT_SOURCES = Object.freeze({ UPLOAD: 'UPLOAD', FAQ: 'FAQ' });

export const DOCUMENT_STATUSES = Object.freeze({
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
  DELETING: 'DELETING',
});

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const agentDocumentSchema = new mongoose.Schema(
  {
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    agentId: { type: ObjectId, ref: 'DepartmentAgent', required: true, immutable: true },
    originalName: {
      type: String,
      required: [true, 'File name is required'],
      trim: true,
      minlength: 1,
      maxlength: KNOWLEDGE_BASE_SETTINGS.ORIGINAL_NAME_MAX_LENGTH,
    },
    fileKey: { type: String, required: true, immutable: true },
    mimeType: {
      type: String,
      required: true,
      immutable: true,
      enum: Object.keys(KNOWLEDGE_BASE_SETTINGS.FILE_TYPES),
    },
    fileSize: {
      type: Number,
      required: true,
      immutable: true,
      min: 1,
      max: KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES,
      validate: { validator: Number.isInteger, message: 'File size must be a whole number of bytes' },
    },
    contentSha256: { type: String, required: true, immutable: true, match: SHA256_HEX_PATTERN },
    status: {
      type: String,
      enum: Object.values(DOCUMENT_STATUSES),
      default: DOCUMENT_STATUSES.UPLOADED,
      required: true,
    },
    errorMessage: { type: String, default: null, maxlength: KNOWLEDGE_BASE_SETTINGS.ERROR_MESSAGE_MAX_LENGTH },
    uploadedBy: { type: ObjectId, ref: 'User', required: true, immutable: true },
    // UPLOAD: a file a lead added. FAQ: an answer from the Questions Inbox saved for the agent
    // (sourceQuestionId names the question); processed and indexed like any other document.
    source: { type: String, enum: Object.values(DOCUMENT_SOURCES), default: DOCUMENT_SOURCES.UPLOAD, immutable: true },
    sourceQuestionId: { type: ObjectId, ref: 'AgentQuestion', default: null, immutable: true },
    chunkCount: {
      type: Number,
      default: 0,
      min: 0,
      max: KNOWLEDGE_BASE_SETTINGS.MAX_CHUNKS_PER_DOCUMENT,
      validate: { validator: Number.isInteger, message: 'Chunk count must be a whole number' },
    },
    lease: {
      owner: { type: String, default: null },
      until: { type: Date, default: null },
    },
    attempts: { type: Number, default: 0, min: 0 },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The department's documents, newest first.
agentDocumentSchema.index({ departmentId: 1, createdAt: -1 });
// One copy of a file per department.
agentDocumentSchema.index({ departmentId: 1, contentSha256: 1 }, { unique: true });
// The sweep: documents waiting, and documents whose worker stopped.
agentDocumentSchema.index({ status: 1, 'lease.until': 1 });

export default mongoose.model('AgentDocument', agentDocumentSchema);
