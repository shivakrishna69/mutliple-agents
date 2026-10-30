/**
 * Fails when a retired product name appears in any tracked text file, so an old brand cannot creep
 * back in. Run from the repository root: npm run check:names (CI runs it on every pull request).
 *
 * Whole words only: "noValidate" is a form attribute, not the old name.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RETIRED_NAMES = /\b(?:unitora|nova(?:support)?)\b/i;
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.woff', '.woff2']);
const THIS_FILE = 'scripts/checkRetiredNames.mjs';

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
for (const file of trackedFiles) {
  if (file === THIS_FILE || BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (RETIRED_NAMES.test(line)) findings.push(`${file}:${index + 1}: ${line.trim()}`);
    });
}

if (findings.length > 0) {
  console.error(`Retired product names found (use the current brand instead):\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`No retired product names in ${trackedFiles.length} tracked files.`);
