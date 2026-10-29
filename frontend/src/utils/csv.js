/**
 * CSV files built in the browser, for downloads such as the leave payroll export.
 *
 * Values that came from users (names, references) can start with "=", "+", "-", "@", a tab or a
 * carriage return, which spreadsheet programs run as formulas. Such text values are prefixed with
 * an apostrophe so they open as plain text. Numbers are written as they are.
 */

const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

function toCsvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (FORMULA_TRIGGERS.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV text (CRLF line endings, as RFC 4180 and Excel expect) from a header row and data rows. */
export function toCsv(headerRow, dataRows) {
  return [headerRow, ...dataRows].map((row) => row.map(toCsvCell).join(',')).join('\r\n');
}

/** Saves `csvText` as a download named `fileName`. */
export function downloadCsv(fileName, csvText) {
  // The byte-order mark makes Excel read the file as UTF-8 (names with accents or Indic scripts).
  const fileBlob = new Blob(['﻿', csvText], { type: 'text/csv;charset=utf-8' });
  const objectUrl = URL.createObjectURL(fileBlob);
  const downloadLink = document.createElement('a');
  downloadLink.href = objectUrl;
  downloadLink.download = fileName;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  URL.revokeObjectURL(objectUrl);
}
