/**
 * Multipart intake for vault uploads (middleware/singleFileUpload.js): one file of at most
 * VAULT_FIELD_LIMITS.MAX_FILE_BYTES, which the controller checks and streams to S3.
 */

import { VAULT_MESSAGES } from '../constants/messages.js';
import { VAULT_FIELD_LIMITS } from '../constants/validation.js';
import { createSingleFileUpload } from './singleFileUpload.js';

export const receiveVaultUpload = createSingleFileUpload({
  maxFileBytes: VAULT_FIELD_LIMITS.MAX_FILE_BYTES,
  logLabel: 'Vault',
  messages: {
    fileTooLarge: VAULT_MESSAGES.FILE_TOO_LARGE,
    fileRequired: VAULT_MESSAGES.FILE_REQUIRED,
    malformedUpload: VAULT_MESSAGES.MALFORMED_UPLOAD,
    multipartRequired: VAULT_MESSAGES.MULTIPART_REQUIRED,
  },
});
