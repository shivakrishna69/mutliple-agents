/**
 * Splits a document's blocks (services/knowledge/textExtraction.js) into chunks for the vector index.
 * Deterministic: the same blocks always give the same chunks, so a retried document overwrites its
 * own chunks instead of adding new ones.
 *
 *   - A chunk belongs to one section: it never spans a heading or a PDF page, so every chunk can say
 *     where it came from (headingPath, page).
 *   - Paragraphs are packed together up to targetChars. A longer paragraph is split between its
 *     sentences, a sentence longer than maxChars between words, and a word longer than maxChars
 *     (a URL, a hash) is cut. No chunk is longer than maxChars.
 *   - A chunk starts with the end of the previous chunk of its section (whole sentences up to
 *     overlapChars, else its last words), so text cut at a boundary is still found together.
 *
 * chunkBlocks(blocks, settings?) → [{ chunkIndex, text, headingPath: string[], page: number|null }]
 */

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';

const DEFAULT_SETTINGS = Object.freeze({
  targetChars: KNOWLEDGE_BASE_SETTINGS.CHUNK_TARGET_CHARS,
  maxChars: KNOWLEDGE_BASE_SETTINGS.CHUNK_MAX_CHARS,
  overlapChars: KNOWLEDGE_BASE_SETTINGS.CHUNK_OVERLAP_CHARS,
});
const PARAGRAPH_JOINER = '\n\n';
const SENTENCE_JOINER = ' ';

const splitSentences = (text) => text.split(/(?<=[.!?…])\s+/u).filter(Boolean);

/** Pieces of at most maxChars: whole words where possible, cut only inside a word longer than that. */
function splitWords(text, maxChars) {
  const pieces = [];
  let current = '';
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    for (let start = 0; start < word.length; start += maxChars) {
      const part = word.slice(start, start + maxChars);
      if (!current) current = part;
      else if (current.length + 1 + part.length <= maxChars) current += ` ${part}`;
      else {
        pieces.push(current);
        current = part;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** A paragraph as pieces of at most maxChars, each with the joiner that goes before it. */
function paragraphPieces(text, maxChars) {
  if (text.length <= maxChars) return [{ text, joiner: PARAGRAPH_JOINER }];
  return splitSentences(text)
    .flatMap((sentence) => (sentence.length <= maxChars ? [sentence] : splitWords(sentence, maxChars)))
    .map((piece, index) => ({ text: piece, joiner: index === 0 ? PARAGRAPH_JOINER : SENTENCE_JOINER }));
}

/** The end of a chunk to repeat at the start of the next: whole sentences, else the last words. */
function overlapOf(text, overlapChars) {
  if (overlapChars <= 0) return '';
  const sentences = splitSentences(text.replaceAll(PARAGRAPH_JOINER, ' '));
  let overlap = '';
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const candidate = overlap ? `${sentences[index]} ${overlap}` : sentences[index];
    if (candidate.length > overlapChars) break;
    overlap = candidate;
  }
  if (overlap && overlap !== text) return overlap;
  const words = text.split(/\s+/u).filter(Boolean);
  overlap = '';
  for (let index = words.length - 1; index > 0; index -= 1) {
    const candidate = overlap ? `${words[index]} ${overlap}` : words[index];
    if (candidate.length > overlapChars) break;
    overlap = candidate;
  }
  return overlap;
}

/** Consecutive paragraphs under the same headings and on the same page. */
function sectionsOf(blocks) {
  const sections = [];
  const headings = [];
  let current = null;
  for (const block of blocks) {
    if (block.type === 'heading') {
      while (headings.length && headings[headings.length - 1].level >= block.level) headings.pop();
      headings.push({ level: block.level, text: block.text });
      current = null;
      continue;
    }
    const page = block.page ?? null;
    if (!current || current.page !== page) {
      current = { headingPath: headings.map((heading) => heading.text), page, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(block.text);
  }
  return sections;
}

/**
 * @param {object[]} blocks
 * @param {{ targetChars?: number, maxChars?: number, overlapChars?: number }} [settings]
 */
export function chunkBlocks(blocks, settings = {}) {
  const { targetChars, maxChars, overlapChars } = { ...DEFAULT_SETTINGS, ...settings };
  const chunks = [];
  for (const { headingPath, page, paragraphs } of sectionsOf(blocks)) {
    let text = '';
    let hasNewText = false;
    const emit = () => {
      if (!hasNewText) return;
      chunks.push({ chunkIndex: chunks.length, text, headingPath, page });
      text = overlapOf(text, overlapChars);
      hasNewText = false;
    };
    for (const paragraph of paragraphs) {
      for (const piece of paragraphPieces(paragraph, maxChars)) {
        const joiner = text ? piece.joiner : '';
        if (hasNewText && text.length + joiner.length + piece.text.length > targetChars) emit();
        // The overlap gives way when it would push the chunk past maxChars.
        if (text && text.length + piece.joiner.length + piece.text.length > maxChars) text = '';
        text = text ? `${text}${piece.joiner}${piece.text}` : piece.text;
        hasNewText = true;
      }
    }
    emit();
  }
  return chunks;
}
