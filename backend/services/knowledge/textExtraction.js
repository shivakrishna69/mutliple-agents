/**
 * The text of a knowledge base file, as a list of blocks every format shares, so one chunker
 * (services/knowledge/chunking.js) handles them all:
 *
 *   { type: 'heading', level: 1-6, text }
 *   { type: 'paragraph', text, page }     page: the PDF page (1-based), null for other formats
 *
 *   PDF    pdfjs-dist (Mozilla): lines from the text layer, paragraphs split where the gap between
 *          lines is wider than usual. PDFs carry no reliable headings. Fonts are never loaded or
 *          evaluated (isEvalSupported: false). A password-protected PDF, or one with no text layer
 *          (a scan), is refused: there is no OCR.
 *   DOCX   mammoth: Word's heading styles become headings; paragraphs, list items and table cells
 *          become paragraphs.
 *   MD     ATX ("# Title") and setext (underlined) headings; fenced code stays one paragraph.
 *   TXT    paragraphs separated by blank lines.
 *
 * Runs inside services/knowledge/extractionThread.js, never on the API's own thread. Throws
 * TextExtractionError with one of EXTRACTION_FAILURES.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mammoth from 'mammoth';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';

export const EXTRACTION_FAILURES = Object.freeze({
  ENCRYPTED: 'ENCRYPTED',
  CORRUPT: 'CORRUPT',
  NO_TEXT: 'NO_TEXT',
  TOO_MANY_PAGES: 'TOO_MANY_PAGES',
  TOO_MUCH_TEXT: 'TOO_MUCH_TEXT',
  TIMED_OUT: 'TIMED_OUT',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
});

export class TextExtractionError extends Error {
  constructor(code, detail = null) {
    super(`Text extraction failed: ${code}`);
    this.name = 'TextExtractionError';
    this.code = code;
    this.detail = detail;
  }
}

// pdf.js reads the standard fonts' metrics from its own package, never from the network.
const STANDARD_FONT_DATA_URL = `${
  pathToFileURL(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))).href
}/standard_fonts/`;
// A gap between two lines this many times the text height starts a new paragraph.
const PARAGRAPH_GAP_FACTOR = 1.8;

const normalizeText = (text) =>
  text
    .normalize('NFC')
    .replace(/[\t\f\v\u00a0]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

function boundedBlocks(blocks) {
  let characters = 0;
  const kept = [];
  for (const block of blocks) {
    const text = normalizeText(block.text);
    if (!text) continue;
    characters += text.length;
    if (characters > KNOWLEDGE_BASE_SETTINGS.EXTRACTED_TEXT_MAX_CHARS) {
      throw new TextExtractionError(EXTRACTION_FAILURES.TOO_MUCH_TEXT);
    }
    kept.push({ ...block, text });
  }
  if (kept.length === 0) throw new TextExtractionError(EXTRACTION_FAILURES.NO_TEXT);
  return kept;
}

// --- PDF ------------------------------------------------------------------------------------------

function pageParagraphs(textItems, page) {
  const paragraphs = [];
  let lines = [];
  let currentLine = '';
  let previousY = null;
  const endLine = () => {
    if (currentLine.trim()) lines.push(currentLine.trim());
    currentLine = '';
  };
  const endParagraph = () => {
    endLine();
    if (lines.length) paragraphs.push({ type: 'paragraph', text: lines.join(' '), page });
    lines = [];
  };
  for (const item of textItems) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform[5];
    const height = Math.max(Math.abs(item.height) || 0, 1);
    if (previousY !== null && Math.abs(previousY - y) > height * PARAGRAPH_GAP_FACTOR) endParagraph();
    else if (previousY !== null && previousY !== y && currentLine) endLine();
    currentLine += item.str;
    if (item.hasEOL) endLine();
    previousY = y;
  }
  endParagraph();
  return paragraphs;
}

async function pdfBlocks(content) {
  // The loading task owns the document and its resources; destroying it releases them.
  let loadingTask;
  let pdf;
  try {
    loadingTask = getDocument({
      // pdf.js takes ownership of the bytes it is given, so it gets a copy.
      data: new Uint8Array(content),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      verbosity: VerbosityLevel.ERRORS,
    });
    pdf = await loadingTask.promise;
  } catch (openError) {
    await loadingTask?.destroy();
    if (openError?.name === 'PasswordException') throw new TextExtractionError(EXTRACTION_FAILURES.ENCRYPTED);
    throw new TextExtractionError(EXTRACTION_FAILURES.CORRUPT, openError?.name ?? null);
  }
  try {
    if (pdf.numPages > KNOWLEDGE_BASE_SETTINGS.PDF_MAX_PAGES) {
      throw new TextExtractionError(EXTRACTION_FAILURES.TOO_MANY_PAGES);
    }
    const blocks = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const { items } = await page.getTextContent();
      blocks.push(...pageParagraphs(items, pageNumber));
      page.cleanup();
    }
    return blocks;
  } catch (readError) {
    if (readError instanceof TextExtractionError) throw readError;
    throw new TextExtractionError(EXTRACTION_FAILURES.CORRUPT, readError?.name ?? null);
  } finally {
    await loadingTask.destroy();
  }
}

// --- DOCX -----------------------------------------------------------------------------------------

const HTML_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
const decodeEntities = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') {
      const codePoint = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? entity;
  });
const BLOCK_TAGS = new Set(['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'ul', 'ol']);

/** Blocks from mammoth's HTML: a heading or paragraph ends at the next block tag, open or close. */
function htmlBlocks(html) {
  const blocks = [];
  let text = '';
  let headingLevel = null;
  const flush = () => {
    const blockText = decodeEntities(text);
    if (blockText.trim()) {
      blocks.push(
        headingLevel
          ? { type: 'heading', level: headingLevel, text: blockText }
          : { type: 'paragraph', text: blockText, page: null },
      );
    }
    text = '';
    headingLevel = null;
  };
  for (const [, textPart, closing, tagName] of html.matchAll(/([^<]+)|<(\/?)([a-z0-9]+)[^>]*>/gi)) {
    if (textPart !== undefined) {
      text += textPart;
      continue;
    }
    const tag = tagName.toLowerCase();
    if (tag === 'br') {
      text += ' ';
    } else if (BLOCK_TAGS.has(tag)) {
      flush();
      if (!closing && /^h[1-6]$/.test(tag)) headingLevel = Number(tag[1]);
    }
  }
  flush();
  return blocks;
}

async function docxBlocks(content) {
  let converted;
  try {
    converted = await mammoth.convertToHtml({ buffer: content }, { ignoreEmptyParagraphs: true });
  } catch (convertError) {
    throw new TextExtractionError(EXTRACTION_FAILURES.CORRUPT, convertError?.name ?? null);
  }
  return htmlBlocks(converted.value);
}

// --- Markdown and plain text ----------------------------------------------------------------------

const decodeUtf8 = (content) =>
  content
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

function markdownBlocks(source) {
  const blocks = [];
  let paragraph = [];
  let fence = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(fence ? '\n' : ' '), page: null });
    paragraph = [];
  };
  for (const line of source.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      paragraph.push(line);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        flush();
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      paragraph.push(line);
      continue;
    }
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      flush();
      blocks.push({ type: 'heading', level: atx[1].length, text: atx[2] });
      continue;
    }
    const setext = /^\s{0,3}(=+|-+)\s*$/.exec(line);
    if (setext && paragraph.length === 1) {
      blocks.push({ type: 'heading', level: setext[1][0] === '=' ? 1 : 2, text: paragraph[0] });
      paragraph = [];
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  fence = null;
  flush();
  return blocks;
}

const plainTextBlocks = (source) =>
  source
    .split(/\n\s*\n/)
    .map((paragraph) => ({ type: 'paragraph', text: paragraph.replace(/\s*\n\s*/g, ' '), page: null }));

// ---------------------------------------------------------------------------------------------------

const EXTRACTORS = Object.freeze({
  pdf: pdfBlocks,
  docx: docxBlocks,
  md: async (content) => markdownBlocks(decodeUtf8(content)),
  txt: async (content) => plainTextBlocks(decodeUtf8(content)),
});

/**
 * @param {Buffer} content
 * @param {string} mimeType  one of KNOWLEDGE_BASE_SETTINGS.FILE_TYPES (already detected from the content)
 * @returns {Promise<object[]>} the blocks, normalized and within EXTRACTED_TEXT_MAX_CHARS
 */
export async function extractBlocks(content, mimeType) {
  const extractor = EXTRACTORS[KNOWLEDGE_BASE_SETTINGS.FILE_TYPES[mimeType]];
  if (!extractor) throw new TextExtractionError(EXTRACTION_FAILURES.CORRUPT, 'unsupported type');
  return boundedBlocks(await extractor(Buffer.from(content)));
}
