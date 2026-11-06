/**
 * Multipart intake for knowledge base uploads (middleware/singleFileUpload.js): one file of at most
 * KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES, held in memory. Its type is decided from its content
 * afterwards (services/knowledge/fileTypes.js).
 */

import { KNOWLEDGE_MESSAGES } from '../constants/messages.js';
import { KNOWLEDGE_BASE_SETTINGS } from '../constants/validation.js';
import { createSingleFileUpload } from './singleFileUpload.js';

export const receiveKnowledgeUpload = createSingleFileUpload({
  maxFileBytes: KNOWLEDGE_BASE_SETTINGS.MAX_FILE_BYTES,
  logLabel: 'Knowledge base',
  messages: {
    fileTooLarge: KNOWLEDGE_MESSAGES.FILE_TOO_LARGE,
    fileRequired: KNOWLEDGE_MESSAGES.FILE_REQUIRED,
    malformedUpload: KNOWLEDGE_MESSAGES.MALFORMED_UPLOAD,
    multipartRequired: KNOWLEDGE_MESSAGES.MULTIPART_REQUIRED,
  },
});
