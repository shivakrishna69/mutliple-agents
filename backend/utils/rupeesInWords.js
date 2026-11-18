/**
 * A whole rupee amount in words, the Indian way (lakh and crore), as offer letters write the CTC:
 * 1800000 -> "Rupees Eighteen Lakh only", 2512345 -> "Rupees Twenty-Five Lakh Twelve Thousand Three
 * Hundred Forty-Five only". Amounts are whole rupees from 0 to 99,99,99,99,999 (paise are not written).
 */

const ONES = Object.freeze([
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
]);
const TENS = Object.freeze(['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']);
// Largest first: each scale takes its part of the amount, the rest goes to the next.
const SCALES = Object.freeze([
  { name: 'Crore', value: 1_00_00_000 },
  { name: 'Lakh', value: 1_00_000 },
  { name: 'Thousand', value: 1_000 },
  { name: 'Hundred', value: 100 },
]);
export const RUPEES_IN_WORDS_MAX = 99_99_99_99_999;

/** 1 to 99 in words: "Forty-Five". */
function belowHundred(amount) {
  if (amount < 20) return ONES[amount];
  const tens = TENS[Math.floor(amount / 10)];
  return amount % 10 === 0 ? tens : `${tens}-${ONES[amount % 10]}`;
}

/** 1 and up in words, without "Rupees" (crores above 99 are written in words too). */
function inWords(amount) {
  const parts = [];
  let rest = amount;
  for (const scale of SCALES) {
    const count = Math.floor(rest / scale.value);
    if (count > 0) {
      parts.push(`${inWords(count)} ${scale.name}`);
      rest -= count * scale.value;
    }
  }
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/**
 * @param {number} amount  whole rupees
 * @returns {string} "Rupees … only"
 */
export function rupeesInWords(amount) {
  if (!Number.isInteger(amount) || amount < 0 || amount > RUPEES_IN_WORDS_MAX) {
    throw new RangeError(`rupeesInWords takes whole rupees from 0 to ${RUPEES_IN_WORDS_MAX}`);
  }
  return `Rupees ${amount === 0 ? ONES[0] : inWords(amount)} only`;
}
