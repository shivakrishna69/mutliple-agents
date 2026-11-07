/**
 * A department's knowledge base (routes/departmentKnowledgeRoutes.js; rules in
 * services/knowledge/knowledgeBaseService.js). Who may use it is settled before these run, by
 * middleware/departmentKnowledgeScope.js, which also hands over the department: handlers only act on
 * req.knowledgeScope. Every change is audited (category "knowledge") with the department and
 * document ids, never file contents.
 *
 *   GET    /api/knowledge-bases the departments this user manages (no scope: any signed-in user, who
 *                               sees only theirs, possibly none)
 *   GET    /settings            the agent's name, instructions, status and lead
 *   GET    /lead-candidates     who may become the lead (?search= part of a name or email)
 *   PATCH  /settings            change them { name?, systemPrompt?, status?, managedBy?, version }
 *   GET    /documents           the documents, newest first, with their processing status
 *   POST   /documents           upload one file (multipart, field "file"): 202, processed in the background
 *   DELETE /documents/:docId    remove one: its chunks, its stored file, its record
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { KNOWLEDGE_MESSAGES } from '../constants/messages.js';
import { KNOWLEDGE_AUDIT_CATEGORY } from '../middleware/departmentKnowledgeScope.js';
import {
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  listLeadCandidates,
  listManageableKnowledgeBases,
  toSettingsSummary,
  updateKnowledgeSettings,
  uploadKnowledgeDocument,
} from '../services/knowledge/knowledgeBaseService.js';
import {
  documentIdErrors,
  validateKnowledgeSettingsChanges,
  validateLeadCandidateQuery,
} from '../validators/knowledgeValidators.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

const knowledgeHandler = createWorkforceHandlerFactory({
  auditCategory: KNOWLEDGE_AUDIT_CATEGORY,
  restrictedMessage: KNOWLEDGE_MESSAGES.ACCESS_DENIED,
  inputInvalidMessage: KNOWLEDGE_MESSAGES.INPUT_INVALID,
});
// Access is decided per department by the scope middleware, not by role.
const SCOPED_READ = Object.freeze({ requiresWorkforceAdmin: false, isWrite: false });
const SCOPED_WRITE = Object.freeze({ requiresWorkforceAdmin: false, isWrite: true });

const auditScope = (req) => ({
  departmentId: req.knowledgeScope.department._id.toString(),
  accessBasis: req.knowledgeScope.access.basis,
});

export const getKnowledgeBases = knowledgeHandler('list_knowledge_bases', SCOPED_READ, async (req) => ({
  message: KNOWLEDGE_MESSAGES.KNOWLEDGE_BASES_RETRIEVED,
  data: { knowledgeBases: await listManageableKnowledgeBases(req.user) },
}));

export const getLeadCandidates = knowledgeHandler('list_knowledge_lead_candidates', SCOPED_READ, async (req) => {
  const validation = validateLeadCandidateQuery(req.query);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  return {
    message: KNOWLEDGE_MESSAGES.LEAD_CANDIDATES_RETRIEVED,
    data: await listLeadCandidates(req.knowledgeScope, validation.sanitizedInput),
  };
});

export const getKnowledgeSettings = knowledgeHandler('view_knowledge_settings', SCOPED_READ, async (req) => ({
  message: KNOWLEDGE_MESSAGES.SETTINGS_RETRIEVED,
  data: { settings: await toSettingsSummary(req.knowledgeScope) },
}));

export const patchKnowledgeSettings = knowledgeHandler('update_knowledge_settings', SCOPED_WRITE, async (req) => {
  const validation = validateKnowledgeSettingsChanges(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const settings = await updateKnowledgeSettings(req.knowledgeScope, validation.sanitizedInput, req.user.id);
  return {
    message: KNOWLEDGE_MESSAGES.SETTINGS_UPDATED,
    data: { settings },
    auditDetails: { ...auditScope(req), fields: Object.keys(validation.sanitizedInput.changes) },
  };
});

export const getKnowledgeDocuments = knowledgeHandler('list_knowledge_documents', SCOPED_READ, async (req) => ({
  message: KNOWLEDGE_MESSAGES.DOCUMENTS_RETRIEVED,
  data: { documents: await listKnowledgeDocuments(req.knowledgeScope) },
}));

export const postKnowledgeDocument = knowledgeHandler('upload_knowledge_document', SCOPED_WRITE, async (req) => {
  const document = await uploadKnowledgeDocument(req.knowledgeScope, req.file, req.user.id);
  return {
    httpStatus: HTTP_STATUS.ACCEPTED,
    message: KNOWLEDGE_MESSAGES.DOCUMENT_UPLOADED,
    data: { document },
    auditDetails: {
      ...auditScope(req),
      documentId: document.id,
      mimeType: document.mimeType,
      fileSize: document.fileSize,
    },
  };
});

export const deleteKnowledgeDocumentHandler = knowledgeHandler(
  'delete_knowledge_document',
  SCOPED_WRITE,
  async (req) => {
    const validationErrors = documentIdErrors(req.params);
    if (validationErrors) return { validationErrors };
    const removed = await deleteKnowledgeDocument(req.knowledgeScope, req.params.docId, {
      config: req.app.locals.config,
      requestId: req.id,
    });
    return {
      message: KNOWLEDGE_MESSAGES.DOCUMENT_DELETED,
      data: { document: removed },
      auditDetails: { ...auditScope(req), documentId: removed.id, chunksRemoved: removed.chunksRemoved },
    };
  },
);
