/**
 * Which uploads a knowledge base accepts (services/knowledge/fileTypes.js): decided from the bytes,
 * with the file name's extension required to agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import { FILE_TYPE_REJECTIONS, detectKnowledgeFileType } from '../../services/knowledge/fileTypes.js';
import { buildDocx, buildPdf, buildZip, docxEntries } from '../fixtures/knowledgeFiles.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_FILE = buildPdf([['Leave policy']]);
const DOCX_FILE = buildDocx([{ text: 'Leave policy' }]);
const TEXT_FILE = Buffer.from('# Leave policy\n\nEveryone gets 24 days.\n', 'utf8');
const PNG_FILE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const EXECUTABLE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);

const rejectionOf = (content, name) => detectKnowledgeFileType(content, name).rejection;

describe('detectKnowledgeFileType', () => {
  it('accepts a PDF, a Word document, Markdown and plain text', () => {
    assert.deepEqual(detectKnowledgeFileType(PDF_FILE, 'Policy.pdf'), {
      mimeType: 'application/pdf',
      extension: 'pdf',
    });
    assert.deepEqual(detectKnowledgeFileType(DOCX_FILE, 'Policy.docx'), { mimeType: DOCX, extension: 'docx' });
    assert.deepEqual(detectKnowledgeFileType(TEXT_FILE, 'Policy.md'), { mimeType: 'text/markdown', extension: 'md' });
    assert.deepEqual(detectKnowledgeFileType(TEXT_FILE, 'notes.markdown'), {
      mimeType: 'text/markdown',
      extension: 'md',
    });
    assert.deepEqual(detectKnowledgeFileType(TEXT_FILE, 'Policy.TXT'), { mimeType: 'text/plain', extension: 'txt' });
  });

  it('returns only types the knowledge base supports', () => {
    for (const [content, name] of [
      [PDF_FILE, 'a.pdf'],
      [DOCX_FILE, 'a.docx'],
      [TEXT_FILE, 'a.md'],
      [TEXT_FILE, 'a.txt'],
    ]) {
      assert.ok(KNOWLEDGE_BASE_SETTINGS.FILE_TYPES[detectKnowledgeFileType(content, name).mimeType], name);
    }
  });

  it('refuses programs and images, whatever they are called', () => {
    assert.equal(rejectionOf(EXECUTABLE, 'setup.pdf'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
    assert.equal(rejectionOf(PNG_FILE, 'photo.pdf'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
    assert.equal(rejectionOf(PNG_FILE, 'photo.txt'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
  });

  it('refuses a file whose name says another supported type than its content', () => {
    assert.equal(rejectionOf(PDF_FILE, 'Policy.txt'), FILE_TYPE_REJECTIONS.EXTENSION_MISMATCH);
    assert.equal(rejectionOf(PDF_FILE, 'Policy.docx'), FILE_TYPE_REJECTIONS.EXTENSION_MISMATCH);
    assert.equal(rejectionOf(DOCX_FILE, 'Policy.pdf'), FILE_TYPE_REJECTIONS.EXTENSION_MISMATCH);
    assert.equal(rejectionOf(TEXT_FILE, 'Policy.pdf'), FILE_TYPE_REJECTIONS.EXTENSION_MISMATCH);
  });

  it('refuses supported content with an unsupported or missing extension', () => {
    assert.equal(rejectionOf(PDF_FILE, 'Policy.exe'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
    assert.equal(rejectionOf(TEXT_FILE, 'Policy'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
    assert.equal(rejectionOf(TEXT_FILE, 'Policy.html'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
  });

  it('refuses an empty file', () => {
    assert.equal(rejectionOf(Buffer.alloc(0), 'empty.txt'), FILE_TYPE_REJECTIONS.EMPTY);
  });

  it('treats text that mentions "%PDF-" as text, and only a PDF header at the start as a PDF', () => {
    const mentionsPdf = Buffer.from('Notes on the %PDF-1.7 format.', 'utf8');
    assert.equal(detectKnowledgeFileType(mentionsPdf, 'notes.txt').mimeType, 'text/plain');
  });

  it('refuses text that is not UTF-8 or holds NUL bytes', () => {
    assert.equal(
      rejectionOf(Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x21]), 'a.txt'),
      FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE,
    );
    assert.equal(rejectionOf(Buffer.from('Hello\u0000world', 'utf8'), 'a.txt'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
    assert.equal(detectKnowledgeFileType(Buffer.from('﻿Hello', 'utf8'), 'a.txt').mimeType, 'text/plain');
  });

  it('refuses zips that are not Word documents (a spreadsheet, a plain zip)', () => {
    const spreadsheet = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'xl/workbook.xml', content: '<workbook/>' },
    ]);
    assert.equal(rejectionOf(spreadsheet, 'Report.docx'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
    assert.equal(
      rejectionOf(buildZip([{ name: 'a.txt', content: 'a' }]), 'a.docx'),
      FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE,
    );
  });

  it('refuses a Word document that would unpack too large, or holds too many parts', () => {
    const bomb = buildZip(
      docxEntries(
        [{ text: 'x' }],
        [{ name: 'word/media/huge.bin', content: 'x', unpackedSize: KNOWLEDGE_BASE_SETTINGS.DOCX_MAX_UNPACKED_BYTES }],
      ),
    );
    assert.equal(rejectionOf(bomb, 'Bomb.docx'), FILE_TYPE_REJECTIONS.DOCX_TOO_LARGE_UNPACKED);
    const manyParts = buildZip(
      docxEntries(
        [{ text: 'x' }],
        Array.from({ length: KNOWLEDGE_BASE_SETTINGS.DOCX_MAX_ENTRIES }, (unused, index) => ({
          name: `word/p${index}.xml`,
          content: '',
        })),
      ),
    );
    assert.equal(rejectionOf(manyParts, 'Many.docx'), FILE_TYPE_REJECTIONS.DOCX_TOO_LARGE_UNPACKED);
  });

  it('refuses a damaged zip instead of reading past its end', () => {
    const truncated = DOCX_FILE.subarray(0, DOCX_FILE.length - 10);
    assert.equal(rejectionOf(truncated, 'Broken.docx'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
    const lyingDirectory = Buffer.from(DOCX_FILE);
    lyingDirectory.writeUInt16LE(60_000, lyingDirectory.length - 12);
    assert.equal(rejectionOf(lyingDirectory, 'Broken.docx'), FILE_TYPE_REJECTIONS.UNSUPPORTED_TYPE);
  });
});
