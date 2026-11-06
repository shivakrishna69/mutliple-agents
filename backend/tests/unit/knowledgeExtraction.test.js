/**
 * Reading the text of knowledge base files (services/knowledge/textExtraction.js), and doing it in a
 * thread with time and memory limits (services/knowledge/extractionThread.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import { MIN_THREAD_HEAP_MB, extractBlocksInThread } from '../../services/knowledge/extractionThread.js';
import { isQpdfAvailable, protectPdfWithPassword } from '../../services/pdfProtection.js';
import { EXTRACTION_FAILURES, TextExtractionError, extractBlocks } from '../../services/knowledge/textExtraction.js';
import { buildDocx, buildPdf } from '../fixtures/knowledgeFiles.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const qpdfPath = process.env.QPDF_PATH || 'qpdf';
const qpdfMissing = !(await isQpdfAvailable(qpdfPath));
const failsWith = (code) => (extractionError) =>
  extractionError instanceof TextExtractionError && extractionError.code === code;

describe('extractBlocks', () => {
  it('reads a PDF page by page, keeping each page number', async () => {
    const blocks = await extractBlocks(
      buildPdf([['Leave policy (2026)', 'Everyone gets 24 days.'], ['Carry forward up to 10 days.']]),
      'application/pdf',
    );
    assert.deepEqual(
      blocks.map(({ text, page }) => [text, page]),
      [
        ['Leave policy (2026) Everyone gets 24 days.', 1],
        ['Carry forward up to 10 days.', 2],
      ],
    );
  });

  it('refuses a PDF with no text layer, as a scan would be', async () => {
    await assert.rejects(extractBlocks(buildPdf([[]]), 'application/pdf'), failsWith(EXTRACTION_FAILURES.NO_TEXT));
  });

  it('refuses a password-protected PDF (made with qpdf)', { skip: qpdfMissing }, async () => {
    const locked = await protectPdfWithPassword(buildPdf([['Secret salary bands']]), '15061995', { qpdfPath });
    await assert.rejects(extractBlocks(locked, 'application/pdf'), failsWith(EXTRACTION_FAILURES.ENCRYPTED));
  });

  it('refuses a damaged PDF', async () => {
    const damaged = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('garbage '.repeat(50))]);
    await assert.rejects(extractBlocks(damaged, 'application/pdf'), failsWith(EXTRACTION_FAILURES.CORRUPT));
  });

  it('reads a Word document with its headings, paragraphs and special characters', async () => {
    const blocks = await extractBlocks(
      buildDocx([
        { text: 'Employee handbook', heading: 1 },
        { text: 'Be kind & keep <data> safe.' },
        { text: 'Leave', heading: 2 },
        { text: 'Everyone gets 24 days.' },
      ]),
      DOCX,
    );
    assert.deepEqual(blocks, [
      { type: 'heading', level: 1, text: 'Employee handbook' },
      { type: 'paragraph', text: 'Be kind & keep <data> safe.', page: null },
      { type: 'heading', level: 2, text: 'Leave' },
      { type: 'paragraph', text: 'Everyone gets 24 days.', page: null },
    ]);
  });

  it('reads Markdown headings of both kinds, and keeps fenced code together', async () => {
    const markdown = [
      'Handbook',
      '========',
      '',
      'Welcome to the team.',
      'Read this first.',
      '',
      '## Leave ##',
      '',
      '```',
      '# not a heading',
      'still code',
      '```',
      '',
      'Travel',
      '------',
      'Book through the portal.',
    ].join('\r\n');
    const blocks = await extractBlocks(Buffer.from(`\uFEFF${markdown}`, 'utf8'), 'text/markdown');
    assert.deepEqual(blocks, [
      { type: 'heading', level: 1, text: 'Handbook' },
      { type: 'paragraph', text: 'Welcome to the team. Read this first.', page: null },
      { type: 'heading', level: 2, text: 'Leave' },
      { type: 'paragraph', text: '```\n# not a heading\nstill code\n```', page: null },
      { type: 'heading', level: 2, text: 'Travel' },
      { type: 'paragraph', text: 'Book through the portal.', page: null },
    ]);
  });

  it('reads plain text as paragraphs separated by blank lines', async () => {
    const blocks = await extractBlocks(
      Buffer.from('First line\nstill first.\n\n\nSecond   paragraph.\t', 'utf8'),
      'text/plain',
    );
    assert.deepEqual(
      blocks.map((block) => block.text),
      ['First line still first.', 'Second paragraph.'],
    );
  });

  it('refuses a file with no text, and a file with more text than the limit', async () => {
    await assert.rejects(
      extractBlocks(Buffer.from(' \n\n \n', 'utf8'), 'text/plain'),
      failsWith(EXTRACTION_FAILURES.NO_TEXT),
    );
    const huge = Buffer.from(`${'word '.repeat(KNOWLEDGE_BASE_SETTINGS.EXTRACTED_TEXT_MAX_CHARS / 5)}more`, 'utf8');
    await assert.rejects(extractBlocks(huge, 'text/plain'), failsWith(EXTRACTION_FAILURES.TOO_MUCH_TEXT));
  });
});

describe('extractBlocksInThread', () => {
  it('gives the same blocks as reading in place', async () => {
    const pdf = buildPdf([['Leave policy'], ['Page two']]);
    assert.deepEqual(await extractBlocksInThread(pdf, 'application/pdf'), await extractBlocks(pdf, 'application/pdf'));
  });

  it('passes on why a file could not be read', async () => {
    await assert.rejects(
      extractBlocksInThread(buildPdf([[]]), 'application/pdf'),
      failsWith(EXTRACTION_FAILURES.NO_TEXT),
    );
  });

  it('stops a file that takes too long', async () => {
    await assert.rejects(
      extractBlocksInThread(buildPdf([['Leave policy']]), 'application/pdf', { timeoutMs: 1 }),
      failsWith(EXTRACTION_FAILURES.TIMED_OUT),
    );
  });

  it('stops a file that needs more memory than allowed, ending only its thread', async () => {
    // 400 pages of dense text need far more than 32 MB to read (checked: about 1.6 s to fail).
    const pages = Array.from({ length: 400 }, (unused, page) =>
      Array.from({ length: 40 }, (unusedLine, line) => `Page ${page} line ${line} `.repeat(6)),
    );
    await assert.rejects(
      extractBlocksInThread(buildPdf(pages), 'application/pdf', { maxHeapMb: 32 }),
      failsWith(EXTRACTION_FAILURES.OUT_OF_MEMORY),
    );
    // This process is unharmed and reads the next file.
    assert.equal((await extractBlocksInThread(buildPdf([['Still here']]), 'application/pdf')).length, 1);
  });

  it('refuses a memory limit too small for a thread to start, which would abort the process', () => {
    assert.throws(
      () => extractBlocksInThread(buildPdf([['x']]), 'application/pdf', { maxHeapMb: MIN_THREAD_HEAP_MB - 1 }),
      RangeError,
    );
  });
});
