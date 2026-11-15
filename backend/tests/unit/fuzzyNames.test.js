/**
 * The closest spellings of a misspelled name (utils/fuzzyNames.js), used by the NSK people search
 * when nobody is named exactly as asked: edit distance with swapped letters, how many edits a word
 * may be off, every query word matched to its own name word, and only the closest names kept.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FUZZY_NAME_RULES,
  allowedEdits,
  closestNames,
  editDistance,
  nameDistance,
  nameWords,
} from '../../utils/fuzzyNames.js';

const people = [
  { id: 1, name: 'Rajeshwari Rao' },
  { id: 2, name: 'Rajesh Kumar' },
  { id: 3, name: 'Rahul Sharma' },
  { id: 4, name: 'Rahul Verma' },
  { id: 5, name: 'Priya Iyer' },
];
const idsOf = (entries) => entries.map((entry) => entry.id);
const closest = (query) => idsOf(closestNames(query, people, (person) => person.name));

describe('fuzzy names', () => {
  it('counts edits, a swap of neighbours as one, and stops early past the limit', () => {
    assert.equal(editDistance('rajeshwary', 'rajeshwari'), 1);
    assert.equal(editDistance('rahul', 'rahul'), 0);
    assert.equal(editDistance('rhaul', 'rahul'), 1);
    assert.equal(editDistance('kitten', 'sitting'), 3);
    assert.equal(editDistance('', 'abc'), 3);
    assert.equal(editDistance('abc', ''), 3);
    assert.equal(editDistance('abcdef', 'uvwxyz', 2), 3);
    assert.equal(editDistance('a', 'abcdef', 2), 3);
    assert.equal(editDistance('ab', 'ba', 1), 1);
  });

  it('allows more edits for longer words', () => {
    assert.equal(allowedEdits(3), 1);
    assert.equal(allowedEdits(FUZZY_NAME_RULES.ONE_EDIT_UP_TO), 1);
    assert.equal(allowedEdits(FUZZY_NAME_RULES.ONE_EDIT_UP_TO + 1), 2);
    assert.equal(allowedEdits(FUZZY_NAME_RULES.TWO_EDITS_UP_TO), 2);
    assert.equal(allowedEdits(FUZZY_NAME_RULES.TWO_EDITS_UP_TO + 1), 3);
  });

  it('reads names without case or accents', () => {
    assert.deepEqual(nameWords('  Zoë  O’Brien-Shah '), ['zoe', 'o', 'brien', 'shah']);
    assert.deepEqual(nameWords(null), []);
  });

  it('matches every query word to its own name word, or not at all', () => {
    assert.equal(nameDistance(['rajeshwary'], 'Rajeshwari Rao'), 1);
    assert.equal(nameDistance(['rao', 'rajeshwary'], 'Rajeshwari Rao'), 1);
    assert.equal(nameDistance(['raj'], 'Rajeshwari Rao'), 0);
    // A misspelled start of a name counts.
    assert.equal(nameDistance(['rajesw'], 'Rajeshwari Rao'), 1);
    assert.equal(nameDistance(['rajeshwray'], 'Rajeshwari Rao'), 2);
    // Two query words cannot both use the same name word.
    assert.equal(nameDistance(['rahul', 'rahul'], 'Rahul Sharma'), null);
    assert.equal(nameDistance(['rahul', 'sharma', 'x'], 'Rahul Sharma'), null);
    assert.equal(nameDistance([], 'Rahul Sharma'), null);
    // Too short to guess from: only an exact start counts.
    assert.equal(nameDistance(['rx'], 'Rahul Sharma'), null);
    assert.equal(nameDistance(['ra'], 'Rahul Sharma'), 0);
    assert.equal(nameDistance(['zzzzzz'], 'Rahul Sharma'), null);
  });

  it('keeps only the closest names, sorted by name', () => {
    assert.deepEqual(closest('Rajeshwary'), [1]);
    assert.deepEqual(closest('rahul sarma'), [3]);
    assert.deepEqual(closest('Rahul'), [3, 4]);
    assert.deepEqual(closest('Priyaa'), [5]);
    assert.deepEqual(closest('Zubair'), []);
    assert.deepEqual(idsOf(closestNames('rahul', [{ id: 9, name: null }, ...people], (person) => person.name)), [3, 4]);
  });
});
