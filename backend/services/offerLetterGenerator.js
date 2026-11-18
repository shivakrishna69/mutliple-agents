/**
 * Offer letter PDFs: the HTML of services/offerLetterTemplate.js rendered by the shared PDF
 * renderer (services/pdfGenerationService.js, headless Chromium).
 *
 *   preview   watermarked ONBOARDING_MESSAGES.PREVIEW_WATERMARK, not protected; for HR to check
 *   final     protected with the candidate's date of birth written DDMMYYYY (AES-256 with qpdf,
 *             services/pdfProtection.js); its SHA-256 is returned for the draft's audit record
 *
 * Letters are never stored: the draft holds everything needed to produce the same letter again.
 * Configuration (QPDF_PATH, the company's legal name, address, CIN, GSTIN and logo file) comes from
 * config.offerLetters through initOfferLetters. The logo is read once there and embedded in every
 * letter as a data address; when it cannot be read, the letterhead uses the brand mark instead.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ONBOARDING_MESSAGES } from '../constants/messages.js';
import { OFFER_LETTER_LOGO } from '../constants/validation.js';
import { logger } from '../utils/logger.js';
import { isPdfRendererConfigured, renderHtmlToPdfStream } from './pdfGenerationService.js';
import { protectPdfWithPassword } from './pdfProtection.js';
import { compileOfferLetterHtml } from './offerLetterTemplate.js';

let offerLetterConfig = null;
let logoDataUri = null;

/** The logo file as a data address, or null (logged) when it is missing, too big or of another type. */
export function readLogoDataUri(logoFile) {
  if (!logoFile) return null;
  const mediaType = OFFER_LETTER_LOGO.MEDIA_TYPES[path.extname(logoFile).toLowerCase()];
  try {
    if (!mediaType) throw new Error('not a PNG, JPEG or SVG file');
    if (statSync(logoFile).size > OFFER_LETTER_LOGO.MAX_BYTES) {
      throw new Error(`larger than ${OFFER_LETTER_LOGO.MAX_BYTES} bytes`);
    }
    return `data:${mediaType};base64,${readFileSync(logoFile).toString('base64')}`;
  } catch (logoError) {
    logger.warn('Offer letter logo not used; the letterhead shows the brand mark', {
      logoFile,
      reason: logoError.code ?? logoError.message,
    });
    return null;
  }
}

/**
 * @param {{ qpdfPath: string, legalName: string|null, registeredAddress: string|null, cin?: string|null,
 *   gstin?: string|null, logoFile?: string|null }} config
 */
export function initOfferLetters(config) {
  offerLetterConfig = config;
  logoDataUri = readLogoDataUri(config.logoFile ?? null);
}

/** A website worth printing: an absolute https address (a site-relative one means nothing on paper). */
const printableWebsite = (url) => (typeof url === 'string' && /^https:\/\//i.test(url) ? url : null);

/** True when this server can produce offer letters (a PDF renderer is configured). */
export function isOfferLetterRenderingAvailable() {
  return isPdfRendererConfigured();
}

/**
 * The company details printed in the letterhead and footer: the configured legal name, address, CIN,
 * GSTIN and logo, else the company's name; its website and contact email from its settings.
 */
export function letterheadCompany(companySettings) {
  return {
    name: companySettings.name,
    shortCode: companySettings.shortCode ?? null,
    legalName: offerLetterConfig?.legalName ?? null,
    registeredAddress: offerLetterConfig?.registeredAddress ?? null,
    cin: offerLetterConfig?.cin ?? null,
    gstin: offerLetterConfig?.gstin ?? null,
    website: printableWebsite(companySettings.websiteUrl),
    email: companySettings.supportEmail ?? null,
    logoDataUri,
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
