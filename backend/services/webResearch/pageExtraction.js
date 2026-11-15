/**
 * The readable part of a fetched page: Mozilla Readability (Apache-2.0) on a linkedom document (ISC),
 * the same algorithm as Firefox's reader view, so menus, footers, adverts and scripts are left out.
 * Its article is then walked as a DOM (never parsed with patterns, so attribute values, however odd,
 * stay out of the text) into heading and paragraph blocks: each heading, paragraph, list item, table
 * cell, quotation, code block and caption once (an element inside another counted with it). The
 * blocks are chunked exactly like uploaded documents. Plain text is split at blank lines. Nothing from
 * the page is ever executed: linkedom does not run scripts or load resources.
 *
 * extractPage({ text, contentType, url }) → { title, blocks, text, byline, publishedTime }
 *   text: the readable text, at most WEB_RESEARCH_SETTINGS.TEXT_MAX_CHARS; empty when none
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';

const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,td,th,pre,blockquote,figcaption';
const UNREADABLE_SELECTOR = 'script,style,noscript,template,svg,math,iframe,object';
const HEADING = /^H([1-6])$/;

const collapse = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

function blocksText(blocks) {
  return blocks
    .map((block) => block.text)
    .join('\n\n')
    .slice(0, S.TEXT_MAX_CHARS);
}

function plainTextBlocks(text) {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => collapse(paragraph))
    .filter(Boolean)
    .map((paragraph) => ({ type: 'paragraph', text: paragraph, page: null }));
}

/** Heading and paragraph blocks of an element's readable content, in document order. */
export function blocksOf(root) {
  for (const unreadable of root.querySelectorAll(UNREADABLE_SELECTOR)) unreadable.remove();
  const blocks = [];
  let length = 0;
  for (const element of root.querySelectorAll(BLOCK_SELECTOR)) {
    // A paragraph inside a list item (or a cell, a quotation) is read with it, once.
    if (element.parentElement?.closest(BLOCK_SELECTOR)) continue;
    const text = collapse(element.textContent);
    if (!text) continue;
    const heading = HEADING.exec(element.tagName);
    blocks.push(
      heading ? { type: 'heading', level: Number(heading[1]), text } : { type: 'paragraph', text, page: null },
    );
    length += text.length;
    if (length > S.TEXT_MAX_CHARS) break;
  }
  if (blocks.length === 0) {
    const text = collapse(root.textContent);
    if (text) blocks.push({ type: 'paragraph', text: text.slice(0, S.TEXT_MAX_CHARS), page: null });
  }
  return blocks;
}

/** The page's own <title>, else its host. */
function titleOf(candidate, url) {
  const title = collapse(candidate);
  return (title || new URL(url).hostname).slice(0, S.TITLE_MAX_LENGTH);
}

/**
 * @param {{ text: string, contentType: string, url: string }} page  safeFetch.js fetchPublicPage's result
 */
export function extractPage({ text, contentType, url }) {
  if (contentType === 'text/plain') {
    const blocks = plainTextBlocks(text.slice(0, S.TEXT_MAX_CHARS * 2));
    return { title: titleOf(null, url), blocks, text: blocksText(blocks), byline: null, publishedTime: null };
  }
  const { document } = parseHTML(text);
  const pageTitle = document.querySelector('title')?.textContent ?? null;
  let article = null;
  try {
    // Readability changes the document it reads; it gets its own copy.
    article = new Readability(parseHTML(text).document, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  // Readability found no article (a very short page): the body is read as it is.
  const root = article?.content
    ? parseHTML(`<html><body>${article.content}</body></html>`).document.body
    : document.body;
  const blocks = root ? blocksOf(root) : [];
  return {
    title: titleOf(article?.title || pageTitle, url),
    blocks,
    text: blocksText(blocks),
    byline: article?.byline ? collapse(article.byline).slice(0, S.TITLE_MAX_LENGTH) : null,
    publishedTime: article?.publishedTime ?? null,
  };
}
