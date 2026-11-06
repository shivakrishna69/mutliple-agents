/**
 * Splitting a document into chunks (services/knowledge/chunking.js): sections, sizes, overlap,
 * determinism, and nothing lost.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import { chunkBlocks } from '../../services/knowledge/chunking.js';

const heading = (level, text) => ({ type: 'heading', level, text });
const paragraph = (text, page = null) => ({ type: 'paragraph', text, page });
const SMALL = Object.freeze({ targetChars: 100, maxChars: 150, overlapChars: 40 });

/** A seeded generator, so the random documents are the same on every run. */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const wordsOf = (text) => text.split(/\s+/).filter(Boolean);

describe('chunkBlocks', () => {
  it('keeps the headings each chunk sits under, and starts afresh at each heading', () => {
    const chunks = chunkBlocks([
      heading(1, 'Handbook'),
      paragraph('Welcome.'),
      heading(2, 'Leave'),
      paragraph('Everyone gets 24 days.'),
      heading(3, 'Carry forward'),
      paragraph('Up to 10 days.'),
      heading(2, 'Travel'),
      paragraph('Book through the portal.'),
      heading(1, 'Appendix'),
      paragraph('Forms.'),
    ]);
    assert.deepEqual(
      chunks.map(({ chunkIndex, text, headingPath }) => [chunkIndex, text, headingPath]),
      [
        [0, 'Welcome.', ['Handbook']],
        [1, 'Everyone gets 24 days.', ['Handbook', 'Leave']],
        [2, 'Up to 10 days.', ['Handbook', 'Leave', 'Carry forward']],
        [3, 'Book through the portal.', ['Handbook', 'Travel']],
        [4, 'Forms.', ['Appendix']],
      ],
    );
  });

  it('never spans two PDF pages, and says which page each chunk is from', () => {
    const chunks = chunkBlocks([
      paragraph('On page one.', 1),
      paragraph('Also page one.', 1),
      paragraph('Page two.', 2),
    ]);
    assert.deepEqual(
      chunks.map(({ text, page }) => [text, page]),
      [
        ['On page one.\n\nAlso page one.', 1],
        ['Page two.', 2],
      ],
    );
  });

  it('packs short paragraphs together up to the target', () => {
    const chunks = chunkBlocks(
      Array.from({ length: 6 }, (unused, index) => paragraph(`Paragraph ${index} has some words.`)),
      SMALL,
    );
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) assert.ok(chunk.text.length <= SMALL.maxChars, chunk.text);
    assert.match(chunks[0].text, /Paragraph 0 .*\n\nParagraph 1 /s);
  });

  it('splits a long paragraph between sentences, a long sentence between words, and cuts only overlong words', () => {
    const sentences = Array.from({ length: 12 }, (unused, index) => `Sentence number ${index} says something useful.`);
    const longSentence = Array.from({ length: 60 }, (unused, index) => `word${index}`).join(' ');
    const longWord = 'x'.repeat(400);
    // Without overlap, so every chunk boundary shows where the split happened.
    const chunks = chunkBlocks([paragraph(sentences.join(' ')), paragraph(longSentence), paragraph(longWord)], {
      ...SMALL,
      overlapChars: 0,
    });
    for (const chunk of chunks) assert.ok(chunk.text.length <= SMALL.maxChars, `${chunk.text.length}: ${chunk.text}`);
    const sentenceChunks = chunks.filter((chunk) => chunk.text.includes('Sentence number'));
    for (const chunk of sentenceChunks) assert.match(chunk.text, /^Sentence number \d+ .*\.$/s);
    assert.ok(chunks.some((chunk) => chunk.text.startsWith('x') && chunk.text.length === SMALL.maxChars));
  });

  it('starts each chunk with the end of the one before it, in the same section only', () => {
    const sentences = Array.from({ length: 10 }, (unused, index) => `Fact ${index} is here.`);
    const chunks = chunkBlocks(
      [heading(1, 'A'), paragraph(sentences.join(' ')), heading(1, 'B'), paragraph('Fresh start.')],
      { targetChars: 60, maxChars: 90, overlapChars: 30 },
    );
    const sectionA = chunks.filter((chunk) => chunk.headingPath[0] === 'A');
    assert.ok(sectionA.length >= 2);
    for (let index = 1; index < sectionA.length; index += 1) {
      const previousLastSentence = sectionA[index - 1].text.split(/(?<=\.)\s+/).pop();
      assert.ok(sectionA[index].text.startsWith(previousLastSentence), `${sectionA[index].text}`);
    }
    assert.equal(chunks.find((chunk) => chunk.headingPath[0] === 'B').text, 'Fresh start.');
  });

  it('gives the same chunks for the same blocks every time', () => {
    const blocks = [heading(1, 'Policy'), paragraph('One. Two. Three. '.repeat(80)), paragraph('Tail.', null)];
    assert.deepEqual(chunkBlocks(blocks), chunkBlocks(structuredClone(blocks)));
  });

  it('numbers chunks from 0 across the whole document', () => {
    const chunks = chunkBlocks([paragraph('a', 1), paragraph('b', 2), paragraph('c', 3)]);
    assert.deepEqual(
      chunks.map((chunk) => chunk.chunkIndex),
      [0, 1, 2],
    );
  });

  it('loses no word and stays within the limits, for 200 random documents', () => {
    const random = seededRandom(20_261_106);
    const vocabulary = [
      'leave',
      'policy',
      'salary',
      'team',
      'review',
      'days',
      'approval',
      'portal',
      'manager',
      'x'.repeat(30),
    ];
    for (let documentNumber = 0; documentNumber < 200; documentNumber += 1) {
      const blocks = [];
      const paragraphCount = 1 + Math.floor(random() * 25);
      for (let index = 0; index < paragraphCount; index += 1) {
        if (random() < 0.2) blocks.push(heading(1 + Math.floor(random() * 3), `Heading ${index}`));
        const sentenceCount = 1 + Math.floor(random() * 15);
        const text = Array.from({ length: sentenceCount }, () => {
          const wordCount = 1 + Math.floor(random() * 40);
          return `${Array.from({ length: wordCount }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(' ')}.`;
        }).join(' ');
        blocks.push(paragraph(text, random() < 0.5 ? null : 1 + Math.floor(index / 5)));
      }
      const chunks = chunkBlocks(blocks);
      const sourceWords = blocks.filter((block) => block.type === 'paragraph').flatMap((block) => wordsOf(block.text));
      const chunkWords = new Set(chunks.flatMap((chunk) => wordsOf(chunk.text)));
      for (const word of sourceWords) assert.ok(chunkWords.has(word), `document ${documentNumber} lost "${word}"`);
      for (const chunk of chunks) {
        assert.ok(chunk.text.length <= KNOWLEDGE_BASE_SETTINGS.CHUNK_MAX_CHARS, `document ${documentNumber}`);
        assert.ok(chunk.text.trim().length > 0);
      }
    }
  });

  it('gives no chunks for a document with only headings', () => {
    assert.deepEqual(chunkBlocks([heading(1, 'Empty'), heading(2, 'Still empty')]), []);
  });
});
