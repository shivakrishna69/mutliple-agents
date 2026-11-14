/**
 * Pieces shared by the HTML documents printed to PDF (offer letters, relieving letters, settlement
 * statements): Indian rupee and date formatting, the detail rows, and a safe CSS string for page
 * footers. Every value is escaped where it is inserted.
 */

import { escapeHtml } from '../utils/html.js';

const moneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'UTC' });

/** ₹1,23,456 */
export const formatMoney = (amount) => moneyFormatter.format(amount);

/** "14 November 2026" for a Date or a "YYYY-MM-DD" calendar date. */
export const formatDate = (date) =>
  dateFormatter.format(typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : date);

export const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;

/**
 * A CSS string for a page footer. Every character but letters, digits and spaces is written as a CSS
 * escape, so no text can end the string or the style element (HTML escaping does not apply there).
 */
export const cssString = (text) =>
  `"${[...text]
    .map((character) => (/[\p{L}\p{N} ]/u.test(character) ? character : `\\${character.codePointAt(0).toString(16)} `))
    .join('')}"`;

/** A label and value on one ruled line. */
export function detail(label, value) {
  return `<div class="detail"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value)}</span></div>`;
}
