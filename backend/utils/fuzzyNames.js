/**
 * Closest names to a misspelled one ("Rajeshwary" for "Rajeshwari"), for the NSK people search when
 * nothing matches exactly. Pure: the caller loads the names, already limited to what the person may
 * see.
 *
 *   editDistance     optimal string alignment distance (Levenshtein plus swapped neighbours), stopping
 *                    early once it is over `max`
 *   allowedEdits     how many edits a query word of this length may be off: 1 up to 4 letters, 2 up
 *                    to 8, 3 beyond
 *   nameDistance     how far a name is from the query words: every query word must be within its
 *                    allowed edits of a different word of the name (or of that word's start, so a
 *                    misspelled part of a name still counts); the total edits, or null
 *   closestNames     the entries within reach that are closest: only those at the smallest distance
 *                    ("Rahul Sarma" finds Rahul Sharma, not also Rahul Verma two edits away), by name
 *
 * Case and accents are ignored. Query words shorter than FUZZY_NAME_RULES.MIN_WORD_LENGTH must match
 * a name word's start exactly: two letters are too few to guess from.
 */

export const FUZZY_NAME_RULES = Object.freeze({
  MIN_WORD_LENGTH: 3,
  // A query word of up to this many letters may be one edit off, then two, then three.
  ONE_EDIT_UP_TO: 4,
  TWO_EDITS_UP_TO: 8,
});

/** Lower case without accents, split into words. */
export function nameWords(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function allowedEdits(length) {
  if (length <= FUZZY_NAME_RULES.ONE_EDIT_UP_TO) return 1;
  if (length <= FUZZY_NAME_RULES.TWO_EDITS_UP_TO) return 2;
  return 3;
}

/** Optimal string alignment distance between `a` and `b`, or max + 1 once it is known to be over `max`. */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previousPrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (previousPrevious && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previousPrevious[j - 2] + 1);
      }
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > max) return max + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/** Edits between one query word and one name word (the whole word, or its start), or null. */
function wordDistance(queryWord, word) {
  if (word.startsWith(queryWord)) return 0;
  if (queryWord.length < FUZZY_NAME_RULES.MIN_WORD_LENGTH) return null;
  const max = allowedEdits(queryWord.length);
  const distance = Math.min(
    editDistance(queryWord, word, max),
    editDistance(queryWord, word.slice(0, queryWord.length), max),
  );
  return distance <= max ? distance : null;
}

/**
 * Total edits from the query words to the name, each query word matched to a different name word
 * (greedily, closest first), or null when a word matches none.
 */
export function nameDistance(queryWords, name) {
  const words = nameWords(name);
  if (queryWords.length === 0) return null;
  const pairs = [];
  queryWords.forEach((queryWord, queryIndex) => {
    words.forEach((word, wordIndex) => {
      const distance = wordDistance(queryWord, word);
      if (distance !== null) pairs.push({ queryIndex, wordIndex, distance });
    });
  });
  pairs.sort((first, second) => first.distance - second.distance);
  const usedQueries = new Set();
  const usedWords = new Set();
  let total = 0;
  for (const pair of pairs) {
    if (usedQueries.has(pair.queryIndex) || usedWords.has(pair.wordIndex)) continue;
    usedQueries.add(pair.queryIndex);
    usedWords.add(pair.wordIndex);
    total += pair.distance;
  }
  return usedQueries.size === queryWords.length ? total : null;
}

/**
 * The entries whose name is within reach of `query` at the smallest distance found, by name.
 * @template T
 * @param {string} query
 * @param {T[]} entries
 * @param {(entry: T) => string} nameOf
 * @returns {T[]}
 */
export function closestNames(query, entries, nameOf) {
  const queryWords = nameWords(query);
  const scored = entries
    .map((entry) => ({ entry, name: nameOf(entry) ?? '', distance: nameDistance(queryWords, nameOf(entry)) }))
    .filter((item) => item.distance !== null);
  const closest = Math.min(...scored.map((item) => item.distance));
  return scored
    .filter((item) => item.distance === closest)
    .sort((first, second) => first.name.localeCompare(second.name))
    .map((item) => item.entry);
}
