/**
 * What kind of file an upload really is, decided from its bytes; the type the browser declared is
 * never trusted. The file name's extension must agree with the content, so a PDF renamed to .txt,
 * or a program renamed to .pdf, is refused.
 *
 *   PDF    starts with "%PDF-" (only at the very start, so text that mentions it is still text)
 *   DOCX   a zip whose central directory lists [Content_Types].xml and word/document.xml, with at
 *          most DOCX_MAX_ENTRIES entries and DOCX_MAX_UNPACKED_BYTES once unpacked (no zip bombs;
 *          ZIP64 archives are refused, since no Word document needs one at these sizes)
 *   MD/TXT strict UTF-8 (an initial BOM is allowed) with no NUL bytes; the extension decides which
 *
 * detectKnowledgeFileType(content, originalName) → { mimeType, extension } or { rejection }, where
 * rejection is one of FILE_TYPE_REJECTIONS.
 */

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';

export const FILE_TYPE_REJECTIONS = Object.freeze({
  EMPTY: 'EMPTY',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  EXTENSION_MISMATCH: 'EXTENSION_MISMATCH',
  DOCX_TOO_LARGE_UNPACKED: 'DOCX_TOO_LARGE_UNPACKED',
});

const MIME_BY_EXTENSION = Object.freeze(
  Object.fromEntries(
    Object.entries(KNOWLEDGE_BASE_SETTINGS.FILE_TYPES).map(([mimeType, extension]) => [extension, mimeType]),
  ),
);
// Other spellings people use for the same types.
const EXTENSION_ALIASES = Object.freeze({ markdown: 'md', text: 'txt' });
const TEXT_EXTENSIONS = Object.freeze(['md', 'txt']);

const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_END_RECORD_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_CENTRAL_ENTRY_BYTES = 46;
const ZIP64_MARKER = 0xffffffff;
const DOCX_REQUIRED_PARTS = Object.freeze(['[Content_Types].xml', 'word/document.xml']);

const utf8 = new TextDecoder('utf-8', { fatal: true });

function extensionOf(originalName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(originalName ?? '').trim());
  if (!match) return null;
  const extension = match[1].toLowerCase();
  return EXTENSION_ALIASES[extension] ?? extension;
}

function isPdf(content) {
  return content.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
}

/**
 * The entries of a zip's central directory: { names, unpackedBytes }, or null when the bytes are
 * not a zip this module can read safely.
 */
function readZipDirectory(content) {
  if (content.length < ZIP_END_RECORD_BYTES || content.readUInt32LE(0) !== ZIP_LOCAL_HEADER) return null;
  const searchFrom = Math.max(0, content.length - ZIP_END_RECORD_BYTES - ZIP_MAX_COMMENT_BYTES);
  let endOffset = -1;
  for (let offset = content.length - ZIP_END_RECORD_BYTES; offset >= searchFrom; offset -= 1) {
    if (content.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) return null;

  const entryCount = content.readUInt16LE(endOffset + 10);
  const directoryBytes = content.readUInt32LE(endOffset + 12);
  const directoryOffset = content.readUInt32LE(endOffset + 16);
  if (directoryOffset === ZIP64_MARKER || directoryBytes === ZIP64_MARKER) return null;
  if (directoryOffset + directoryBytes > endOffset) return null;

  const names = [];
  let unpackedBytes = 0;
  let offset = directoryOffset;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + ZIP_CENTRAL_ENTRY_BYTES > endOffset || content.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
      return null;
    }
    const unpackedSize = content.readUInt32LE(offset + 24);
    if (unpackedSize === ZIP64_MARKER) return null;
    const nameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const nameEnd = offset + ZIP_CENTRAL_ENTRY_BYTES + nameLength;
    if (nameEnd > endOffset) return null;
    names.push(content.subarray(offset + ZIP_CENTRAL_ENTRY_BYTES, nameEnd).toString('utf8'));
    unpackedBytes += unpackedSize;
    offset = nameEnd + extraLength + commentLength;
  }
  return { names, unpackedBytes };
}

function isUtf8Text(content) {
  if (content.includes(0)) return false;
  try {
    utf8.decode(content);
    return true;
  } catch {
    return false;
  }
}

/** The type the content shows, ignoring the name: 'pdf', 'docx', 'text', or a rejection. */
function contentKind(content) {
  if (isPdf(content)) return { kind: 'pdf' };
  const zipDirectory = readZipDirectory(content);
  if (zipDirectory) {
    const isWordDocument = DOCX_REQUIRED_PARTS.every((part) => zipDirectory.names.includes(part));
    if (!isWordDocument) return { rejection: FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE };
    if (
      zipDirectory.names.length > KNOWLEDGE_BASE_SETTINGS.DOCX_MAX_ENTRIES ||
      zipDirectory.unpackedBytes > KNOWLEDGE_BASE_SETTINGS.DOCX_MAX_UNPACKED_BYTES
    ) {
      return { rejection: FILE_TYPE_REJECTIONS.DOCX_TOO_LARGE_UNPACKED };
    }
    return { kind: 'docx' };
  }
  if (isUtf8Text(content)) return { kind: 'text' };
  return { rejection: FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE };
}

/**
 * @param {Buffer} content
 * @param {string} originalName  the uploader's file name; only its extension is used
 * @returns {{ mimeType: string, extension: string } | { rejection: string }}
 */
export function detectKnowledgeFileType(content, originalName) {
  if (!content?.length) return { rejection: FILE_TYPE_REJECTIONS.EMPTY };
  const detected = contentKind(content);
  if (detected.rejection) return detected;

  const extension = extensionOf(originalName);
  const extensionMatches = detected.kind === 'text' ? TEXT_EXTENSIONS.includes(extension) : extension === detected.kind;
  if (!extensionMatches) {
    return {
      rejection: MIME_BY_EXTENSION[extension]
        ? FILE_TYPE_REJECTIONS.EXTENSION_MISMATCH
        : FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE,
    };
  }
  return { mimeType: MIME_BY_EXTENSION[extension], extension };
}
