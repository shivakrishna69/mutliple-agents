/**
 * Offer letter PDFs: the HTML of services/offerLetterTemplate.js rendered by the shared PDF
 * renderer (services/pdfGenerationService.js, headless Chromium).
 *
 *   preview   watermarked ONBOARDING_MESSAGES.PREVIEW_WATERMARK, not protected; for HR to check
 *   final     protected with the candidate's date of birth written DDMMYYYY (AES-256 with qpdf,
 *             services/pdfProtection.js); its SHA-256 is returned for the draft's audit record
 *
 * Letters are never stored: the draft holds everything needed to produce the same letter again.
 * Configuration (QPDF_PATH, the company's legal name and address) comes from config.offerLetters
 * through initOfferLetters.
 */

import { createHash } from 'node:crypto';

import { ONBOARDING_MESSAGES } from '../constants/messages.js';
import { isPdfRendererConfigured, renderHtmlToPdfStream } from './pdfGenerationService.js';
import { protectPdfWithPassword } from './pdfProtection.js';
import { compileOfferLetterHtml } from './offerLetterTemplate.js';

let offerLetterConfig = null;

/** @param {{ qpdfPath: string, legalName: string|null, registeredAddress: string|null }} config */
export function initOfferLetters(config) {
  offerLetterConfig = config;
}

/** True when this server can produce offer letters (a PDF renderer is configured). */
export function isOfferLetterRenderingAvailable() {
  return isPdfRendererConfigured();
}

/** The company details printed in the letter head: the configured legal name and address, else the company's name. */
export function letterheadCompany(companySettings) {
  return {
    name: companySettings.name,
    legalName: offerLetterConfig?.legalName ?? null,
    registeredAddress: offerLetterConfig?.registeredAddress ?? null,
    brandColor: companySettings.brandColors.primary,
  };
}

/** "DDMMYYYY" of a date of birth (midnight UTC of the day), the final letter's password. */
export function offerLetterPassword(dateOfBirth) {
  const [year, month, day] = dateOfBirth.toISOString().slice(0, 10).split('-');
  return `${day}${month}${year}`;
}

/** The HTML a letter is printed from: a preview carries ONBOARDING_MESSAGES.PREVIEW_WATERMARK, a final letter none. */
export function offerLetterHtml(letter, { preview }) {
  return compileOfferLetterHtml({ ...letter, watermark: preview ? ONBOARDING_MESSAGES.PREVIEW_WATERMARK : null });
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * @param {object} letter  compileOfferLetterHtml's input, without `watermark`
 * @param {{ preview: boolean, dateOfBirth?: Date }} options  dateOfBirth is required for a final letter
 * @returns {Promise<{ pdf: Buffer, sha256: string }>}
 */
export async function renderOfferLetter(letter, { preview, dateOfBirth }) {
  const rendered = await collect(await renderHtmlToPdfStream(offerLetterHtml(letter, { preview })));
  const pdf = preview
    ? rendered
    : await protectPdfWithPassword(rendered, offerLetterPassword(dateOfBirth), {
        qpdfPath: offerLetterConfig?.qpdfPath ?? 'qpdf',
      });
  return { pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
}
