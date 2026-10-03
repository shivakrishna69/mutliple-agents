/**
 * Input checks for the document vault: multipart form fields, file content sniffing, and file
 * name sanitising. Pure functions, no I/O.
 */

import { VAULT_FIELD_LIMITS } from '../constants/validation.js';
import { VAULT_MESSAGES } from '../constants/messages.js';
import { VAULT_DOCUMENT_TYPES, VAULT_FILE_TYPES, VAULT_GRANTABLE_ROLES } from '../models/DocumentVault.js';
import { isValidObjectIdString } from './conversationValidators.js';

/**
 * File signatures ("magic numbers") of the accepted types. The type is decided by the bytes, never
 * by the client-declared Content-Type or file extension, so a renamed executable or HTML file is
 * refused even if it claims to be a PDF.
 *   PDF   25 50 44 46 2D   "%PDF-"
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 */
const FILE_SIGNATURES = Object.freeze([
  { contentType: 'application/pdf', signatureBytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { contentType: 'image/png', signatureBytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { contentType: 'image/jpeg', signatureBytes: [0xff, 0xd8, 0xff] },
]);

/** Returns `{ contentType, extension }` for an accepted file, or null for anything else. */
export function detectVaultFileType(fileBuffer) {
  for (const { contentType, signatureBytes } of FILE_SIGNATURES) {
    if (fileBuffer.length >= signatureBytes.length && signatureBytes.every((signatureByte, byteIndex) => fileBuffer[byteIndex] === signatureByte)) {
      return { contentType, extension: VAULT_FILE_TYPES[contentType] };
    }
  }
  return null;
}

/**
 * Makes the uploader's file name safe to store and to use as a download name:
 *   - keeps only the last path segment (a name like "../../etc/passwd" or "C:\x\y.pdf" loses its path)
 *   - removes control characters and characters that are unsafe in file names on common systems
 *   - collapses whitespace, trims dots and spaces, caps the length
 *   - ends with the extension of the *detected* type, so the download opens in the right app
 * The name is display data only; it never becomes part of the S3 key.
 */
export function sanitizeOriginalFileName(rawFileName, detectedExtension) {
  const lastPathSegment = String(rawFileName ?? '').split(/[\\/]/).pop();
  let cleanedName = lastPathSegment
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');

  const expectedSuffixes = detectedExtension === 'jpg' ? ['.jpg', '.jpeg'] : [`.${detectedExtension}`];
  const hasExpectedSuffix = expectedSuffixes.some((suffix) => cleanedName.toLowerCase().endsWith(suffix));
  const requiredSuffix = hasExpectedSuffix ? '' : `.${detectedExtension}`;

  const maxStemLength = VAULT_FIELD_LIMITS.ORIGINAL_FILE_NAME_MAX_LENGTH - requiredSuffix.length;
  if (cleanedName.length > maxStemLength) cleanedName = cleanedName.slice(0, maxStemLength).trimEnd();
  if (cleanedName.length === 0 || /^\.[^.]*$/.test(cleanedName)) cleanedName = 'document';
  return `${cleanedName}${requiredSuffix}`;
}

/**
 * Validates the upload form fields (multipart text fields arrive as strings).
 *   employeeId       required, 24-hex ObjectId
 *   documentType     required, one of VAULT_DOCUMENT_TYPES
 *   accessibleRoles  optional, comma-separated list of grantable roles (admin, hr); each role once
 * Returns `{ isValid, validationErrors, sanitizedInput }`.
 */
export function validateVaultUploadFields(requestBody) {
  const formFields = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const validationErrors = [];

  const { employeeId, documentType, accessibleRoles: rawAccessibleRoles } = formFields;
  if (!isValidObjectIdString(employeeId)) {
    validationErrors.push({ field: 'employeeId', message: VAULT_MESSAGES.INVALID_EMPLOYEE_ID });
  }
  if (typeof documentType !== 'string' || !Object.values(VAULT_DOCUMENT_TYPES).includes(documentType)) {
    validationErrors.push({ field: 'documentType', message: VAULT_MESSAGES.INVALID_DOCUMENT_TYPE });
  }

  let accessibleRoles = null;
  if (rawAccessibleRoles !== undefined) {
    const roleList =
      typeof rawAccessibleRoles === 'string'
        ? rawAccessibleRoles
            .split(',')
            .map((roleName) => roleName.trim().toLowerCase())
            .filter(Boolean)
        : null;
    const isValidRoleList =
      roleList !== null && roleList.length > 0 && roleList.every((roleName) => VAULT_GRANTABLE_ROLES.includes(roleName)) && new Set(roleList).size === roleList.length;
    if (isValidRoleList) accessibleRoles = roleList;
    else validationErrors.push({ field: 'accessibleRoles', message: VAULT_MESSAGES.INVALID_ACCESSIBLE_ROLES });
  }

  if (validationErrors.length > 0) return { isValid: false, validationErrors, sanitizedInput: null };
  return { isValid: true, validationErrors: [], sanitizedInput: { employeeId: employeeId.toLowerCase(), documentType, accessibleRoles } };
}
