/**
 * HTML helpers shared by everything that renders HTML on the server (emails, payslip PDFs).
 */

const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/** Escapes text for use inside HTML element content and quoted attribute values. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
