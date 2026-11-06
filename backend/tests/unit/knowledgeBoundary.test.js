/**
 * The knowledge base's domain boundary: outside services/knowledge/, code may use only
 * knowledgeBaseService.js (the API's way in) and, in server.js alone, ingestionQueue.js (to start and
 * stop the queue). File storage, file types, text extraction, chunking, the ingestion runner and the
 * vector index client stay internal, so no other feature handles file keys, chunks or vectors.
 * Checked on every source file's imports; tests are exempt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KNOWLEDGE_DIR = path.join(BACKEND_ROOT, 'services', 'knowledge');
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'tests', 'coverage', '.git']);
const PUBLIC_ENTRY = path.join(KNOWLEDGE_DIR, 'knowledgeBaseService.js');
const QUEUE_ENTRY = path.join(KNOWLEDGE_DIR, 'ingestionQueue.js');
const SERVER_ENTRY = path.join(BACKEND_ROOT, 'server.js');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(entryPath);
    return entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function relativeImports(file) {
  const source = readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  return specifiers.map((specifier) => path.resolve(path.dirname(file), specifier));
}

describe('knowledge base boundary', () => {
  it('keeps the knowledge internals behind knowledgeBaseService.js', () => {
    const violations = [];
    for (const file of sourceFiles(BACKEND_ROOT)) {
      if (file.startsWith(KNOWLEDGE_DIR + path.sep)) continue;
      for (const imported of relativeImports(file)) {
        if (!imported.startsWith(KNOWLEDGE_DIR + path.sep)) continue;
        const allowed = imported === PUBLIC_ENTRY || (imported === QUEUE_ENTRY && file === SERVER_ENTRY);
        if (!allowed)
          violations.push(`${path.relative(BACKEND_ROOT, file)} -> ${path.relative(BACKEND_ROOT, imported)}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it('is really checking: the API reaches the knowledge base through its service', () => {
    const importers = sourceFiles(BACKEND_ROOT).filter((file) => relativeImports(file).includes(PUBLIC_ENTRY));
    assert.ok(importers.some((file) => file.endsWith(path.join('middleware', 'departmentKnowledgeScope.js'))));
    assert.ok(importers.some((file) => file.endsWith(path.join('controllers', 'departmentKnowledgeController.js'))));
  });
});
