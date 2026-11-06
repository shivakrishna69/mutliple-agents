/**
 * A department's knowledge base, as the API sees it: its agent's settings and its documents. This
 * is the one place that reaches the knowledge internals (file store, file types, ingestion queue,
 * vector index); controllers and other features go through these functions only, and never see
 * file keys, chunks or vectors.
 *
 *   loadKnowledgeScope(user, departmentId)   the department, its agent (created on first use by
 *                                            someone allowed to manage it) and what the user may do;
 *                                            404 / 403 (refused) / 409 (inactive department)
 *   toSettingsSummary(scope)                 GET /settings
 *   updateKnowledgeSettings(scope, ...)      PATCH /settings (only an admin or the head changes the lead)
 *   listKnowledgeDocuments(scope)            GET /documents, newest first
 *   uploadKnowledgeDocument(scope, ...)      POST /documents: checks, stores, queues; 202
 *   deleteKnowledgeDocument(scope, ...)      DELETE /documents/:docId: chunks evicted, then the
 *                                            file, then the record; safe to repeat
 */

import { createHash } from 'node:crypto';

import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { KNOWLEDGE_MESSAGES } from '../../constants/messages.js';
import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import AgentDocument, { DOCUMENT_STATUSES } from '../../models/AgentDocument.js';
import Department from '../../models/Department.js';
import DepartmentAgent, { AGENT_STATUSES } from '../../models/DepartmentAgent.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';
import User, { ACCOUNT_STATUSES } from '../../models/User.js';
import { logger } from '../../utils/logger.js';
import { isDuplicateKeyError } from '../../utils/mongoErrors.js';
import { sanitizeOriginalFileName } from '../../validators/vaultValidators.js';
import { AiServiceError } from '../aiServiceClient.js';
import { ServiceError, assertCurrentVersion, saveVersioned } from '../serviceError.js';
import { findOwnEmployeeProfileId } from '../workforceAccess.js';
import { knowledgeFileStore } from './fileStore.js';
import { FILE_TYPE_REJECTIONS, detectKnowledgeFileType } from './fileTypes.js';
import { dispatchDocumentIngestion } from './ingestionQueue.js';
import { decideKnowledgeAccess } from './knowledgeAccess.js';
import { removeDocumentChunks } from './knowledgeIndexClient.js';

const refusal = (httpStatus, code) => new ServiceError(httpStatus, code, KNOWLEDGE_MESSAGES[code]);

// How each content check failure is answered.
const UPLOAD_REJECTIONS = Object.freeze({
  [FILE_TYPE_REJECTIONS.EMPTY]: { httpStatus: HTTP_STATUS.BAD_REQUEST, code: 'EMPTY_FILE' },
  [FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE]: {
    httpStatus: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
    code: 'UNSUPPORTED_FILE_TYPE',
  },
  [FILE_TYPE_REJECTIONS.EXTENSION_MISMATCH]: {
    httpStatus: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
    code: 'EXTENSION_MISMATCH',
  },
  [FILE_TYPE_REJECTIONS.DOCX_TOO_LARGE_UNPACKED]: {
    httpStatus: HTTP_STATUS.PAYLOAD_TOO_LARGE,
    code: 'DOCX_TOO_LARGE_UNPACKED',
  },
});

async function userIdOfProfile(profileId) {
  if (!profileId) return null;
  const profile = await EmployeeProfile.findById(profileId).select('userId').lean();
  return profile?.userId ?? null;
}

/** The department's agent, created with its defaults the first time it is needed (once, even if two requests race). */
async function ensureAgent(department, actorUserId) {
  const existing = await DepartmentAgent.findOne({ departmentId: department._id });
  if (existing) return existing;
  try {
    return await DepartmentAgent.create({
      departmentId: department._id,
      name: `${department.name} ${KNOWLEDGE_MESSAGES.DEFAULT_AGENT_NAME_SUFFIX}`.slice(
        0,
        KNOWLEDGE_BASE_SETTINGS.AGENT_NAME_MAX_LENGTH,
      ),
      managedBy: await userIdOfProfile(department.departmentHeadId),
      createdByUserId: actorUserId,
    });
  } catch (createError) {
    if (!isDuplicateKeyError(createError)) throw createError;
    return DepartmentAgent.findOne({ departmentId: department._id });
  }
}

/**
 * @param {{ id: string, role: string }} user
 * @param {string} departmentId  a valid id (checked by the route)
 * @returns {Promise<{ department: object, agent: import('mongoose').Document, access: object }>}
 */
export async function loadKnowledgeScope(user, departmentId) {
  const department = await Department.findById(departmentId).lean();
  if (!department) throw refusal(HTTP_STATUS.NOT_FOUND, 'DEPARTMENT_NOT_FOUND');
  const existingAgent = await DepartmentAgent.findOne({ departmentId: department._id }).select('managedBy').lean();
  const access = decideKnowledgeAccess({
    role: user.role,
    userId: user.id,
    ownProfileId: await findOwnEmployeeProfileId(user.id),
    departmentHeadId: department.departmentHeadId,
    managedBy: existingAgent?.managedBy ?? null,
  });
  if (!access.canManage) throw refusal(HTTP_STATUS.FORBIDDEN, 'ACCESS_DENIED');
  if (!department.isActive) throw refusal(HTTP_STATUS.CONFLICT, 'DEPARTMENT_INACTIVE');
  return { department, agent: await ensureAgent(department, user.id), access };
}

async function userSummaries(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } })
    .select('name email')
    .lean();
  return new Map(
    users.map((user) => [user._id.toString(), { id: user._id.toString(), name: user.name, email: user.email }]),
  );
}

export async function toSettingsSummary({ department, agent, access }) {
  const users = await userSummaries([agent.managedBy]);
  return {
    id: agent._id.toString(),
    department: { id: department._id.toString(), name: department.name, code: department.code },
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    status: agent.status,
    lead: agent.managedBy ? (users.get(agent.managedBy.toString()) ?? null) : null,
    limits: {
      systemPromptMaxLength: KNOWLEDGE_BASE_SETTINGS.SYSTEM_PROMPT_MAX_LENGTH,
      nameMaxLength: KNOWLEDGE_BASE_SETTINGS.AGENT_NAME_MAX_LENGTH,
      maxFileBytes: KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES,
      maxDocuments: KNOWLEDGE_BASE_SETTINGS.MAX_DOCUMENTS_PER_DEPARTMENT,
      fileTypes: Object.keys(KNOWLEDGE_BASE_SETTINGS.FILE_TYPES),
    },
    permissions: { canAssignLead: access.canAssignLead },
    version: agent.__v,
    updatedAt: agent.updatedAt,
  };
}

/** The lead must be an active account whose employee profile is in this department. */
async function assertEligibleLead(userId, department) {
  const [account, profile] = await Promise.all([
    User.findById(userId).select('status').lean(),
    EmployeeProfile.findOne({ userId, 'organizationData.departmentId': department._id }).select('_id').lean(),
  ]);
  if (!account || account.status !== ACCOUNT_STATUSES.ACTIVE || !profile) {
    throw refusal(HTTP_STATUS.BAD_REQUEST, 'LEAD_NOT_ELIGIBLE');
  }
}

export async function updateKnowledgeSettings(scope, { changes, version }, actorUserId) {
  const { agent, access, department } = scope;
  assertCurrentVersion(agent, version);
  if (changes.managedBy !== undefined) {
    if (!access.canAssignLead) throw refusal(HTTP_STATUS.FORBIDDEN, 'LEAD_CHANGE_NOT_ALLOWED');
    if (changes.managedBy !== null) await assertEligibleLead(changes.managedBy, department);
    agent.managedBy = changes.managedBy;
  }
  for (const field of ['name', 'systemPrompt', 'status']) {
    if (changes[field] !== undefined) agent[field] = changes[field];
  }
  agent.updatedByUserId = actorUserId;
  await saveVersioned(agent);
  return toSettingsSummary(scope);
}

function toDocumentSummary(document, users) {
  return {
    id: document._id.toString(),
    originalName: document.originalName,
    mimeType: document.mimeType,
    fileSize: document.fileSize,
    status: document.status,
    errorMessage: document.errorMessage,
    chunkCount: document.chunkCount,
    uploadedBy: users.get(document.uploadedBy.toString()) ?? {
      id: document.uploadedBy.toString(),
      name: null,
      email: null,
    },
    createdAt: document.createdAt,
    processedAt: document.processedAt,
  };
}

export async function listKnowledgeDocuments({ department }) {
  const documents = await AgentDocument.find({ departmentId: department._id })
    .sort({ createdAt: -1 })
    .limit(KNOWLEDGE_BASE_SETTINGS.MAX_DOCUMENTS_PER_DEPARTMENT)
    .lean();
  const users = await userSummaries(documents.map((document) => document.uploadedBy));
  return documents.map((document) => toDocumentSummary(document, users));
}

async function deleteStoredFileQuietly(fileKey) {
  try {
    await knowledgeFileStore.deleteFile(fileKey);
  } catch (deleteError) {
    logger.error('Knowledge file could not be removed after a failed upload', { error: deleteError.message });
  }
}

/**
 * @param {object} scope
 * @param {{ buffer: Buffer, originalname: string }} file  from middleware/knowledgeUpload.js
 * @param {string} actorUserId
 */
export async function uploadKnowledgeDocument({ department, agent }, file, actorUserId) {
  if (agent.status !== AGENT_STATUSES.ACTIVE) throw refusal(HTTP_STATUS.CONFLICT, 'AGENT_PAUSED');
  const documentCount = await AgentDocument.countDocuments({ departmentId: department._id });
  if (documentCount >= KNOWLEDGE_BASE_SETTINGS.MAX_DOCUMENTS_PER_DEPARTMENT) {
    throw refusal(HTTP_STATUS.CONFLICT, 'DOCUMENT_LIMIT_REACHED');
  }

  const detected = detectKnowledgeFileType(file.buffer, file.originalname);
  if (detected.rejection) {
    const { httpStatus, code } = UPLOAD_REJECTIONS[detected.rejection];
    throw refusal(httpStatus, code);
  }
  const contentSha256 = createHash('sha256').update(file.buffer).digest('hex');
  if (await AgentDocument.exists({ departmentId: department._id, contentSha256 })) {
    throw refusal(HTTP_STATUS.CONFLICT, 'DUPLICATE_DOCUMENT');
  }

  const originalName = sanitizeOriginalFileName(file.originalname, detected.extension).slice(
    0,
    KNOWLEDGE_BASE_SETTINGS.ORIGINAL_NAME_MAX_LENGTH,
  );
  const fileKey = await knowledgeFileStore.saveFile({
    content: file.buffer,
    fileName: originalName,
    contentType: detected.mimeType,
    sha256: contentSha256,
    metadata: { departmentId: department._id.toString(), agentId: agent._id.toString() },
  });
  let document;
  try {
    document = await AgentDocument.create({
      departmentId: department._id,
      agentId: agent._id,
      originalName,
      fileKey,
      mimeType: detected.mimeType,
      fileSize: file.buffer.length,
      contentSha256,
      uploadedBy: actorUserId,
    });
  } catch (createError) {
    await deleteStoredFileQuietly(fileKey);
    if (isDuplicateKeyError(createError)) throw refusal(HTTP_STATUS.CONFLICT, 'DUPLICATE_DOCUMENT');
    throw createError;
  }

  try {
    await dispatchDocumentIngestion(document._id.toString());
  } catch (dispatchError) {
    // The document is saved as UPLOADED; the queue's sweep hands it out once the queue is back.
    logger.warn('Knowledge document queued for the sweep', {
      documentId: document._id.toString(),
      error: dispatchError.message,
    });
  }
  const users = await userSummaries([actorUserId]);
  return toDocumentSummary(document.toObject(), users);
}

/**
 * @param {object} scope
 * @param {string} documentId
 * @param {{ config: object, requestId: string }} callContext  for the AI service
 */
export async function deleteKnowledgeDocument({ department }, documentId, callContext) {
  const document = await AgentDocument.findOneAndUpdate(
    { _id: documentId, departmentId: department._id },
    { $set: { status: DOCUMENT_STATUSES.DELETING } },
    { new: true },
  ).lean();
  if (!document) throw refusal(HTTP_STATUS.NOT_FOUND, 'DOCUMENT_NOT_FOUND');
  try {
    await removeDocumentChunks(document._id, callContext);
  } catch (evictError) {
    if (!(evictError instanceof AiServiceError)) throw evictError;
    // Left DELETING: the lead sees it and deletes again once the index is back.
    logger.warn('Knowledge document delete waiting for the index', { documentId, reason: evictError.failureKind });
    throw refusal(HTTP_STATUS.SERVICE_UNAVAILABLE, 'INDEX_UNAVAILABLE');
  }
  await knowledgeFileStore.deleteFile(document.fileKey);
  await AgentDocument.deleteOne({ _id: document._id });
  return { id: document._id.toString(), chunksRemoved: document.chunkCount };
}
