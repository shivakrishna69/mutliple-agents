/**
 * Headless PDF compilation: renders a self-contained HTML document to a PDF with headless Chromium
 * (Playwright). Generic: it knows nothing about payslips, so any document type can use it.
 *
 * Why a browser engine: the HTML template is the single source of truth for the layout. Chromium's
 * print engine applies the same CSS (A4 @page rules, grid, fonts), embeds subset fonts, and
 * Flate-compresses content streams, which yields small, print-ready, text-searchable PDFs.
 *
 * Browser binary: never downloaded at install time. Configure the Chromium build explicitly:
 *   PDF_BROWSER_EXECUTABLE_PATH   path to a Chromium/Chrome/Edge executable (e.g. /usr/bin/chromium
 *                                 in a container image), or
 *   PDF_BROWSER_CHANNEL           an installed branded channel: chrome | msedge | chromium | ...
 *
 * Lifecycle
 *   - One browser process per backend process, launched lazily on the first render and reused.
 *     If it crashes or disconnects, the next render launches a new one.
 *   - Each render gets its own isolated browser context (no shared cookies, cache or storage) that
 *     is always closed afterwards, even when rendering fails.
 *   - At most MAX_CONCURRENT_RENDERS pages render at once; further requests wait in a FIFO queue
 *     for up to QUEUE_TIMEOUT_MS, so a burst of payslip runs cannot exhaust memory.
 *   - closePdfRenderer() closes the browser on shutdown.
 *
 * Sandboxing of the document being rendered
 *   - JavaScript disabled for the context: templates are static markup.
 *   - Every network request is aborted except data: URIs, so markup can never make the server
 *     fetch a URL (no SSRF, no tracking pixels, no remote fonts); templates are self-contained.
 *   - Offline context and a bounded render timeout.
 *
 * Output: renderHtmlToPdfStream returns a Node.js Readable over the PDF bytes, so callers pipe it
 * into storage (services/payslipStorage.js) without caring how it was produced. Chromium generates
 * the complete document before handing it over (that is how its print pipeline works); the stream
 * is the hand-off contract between the rendering and storage stages.
 */

import { Readable } from 'node:stream';
import { chromium } from 'playwright-core';
import { logger } from '../utils/logger.js';

export const PDF_RENDER_SETTINGS = Object.freeze({
  MAX_CONCURRENT_RENDERS: 2,
  QUEUE_TIMEOUT_MS: 30_000,
  RENDER_TIMEOUT_MS: 20_000,
  BROWSER_LAUNCH_TIMEOUT_MS: 30_000,
});

/** The renderer is not configured, or the browser could not start / render in time. */
export class PdfRenderError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'PdfRenderError';
  }
}

let rendererConfig = null;
let browserPromise = null;
let activeRenders = 0;
const waitingRenders = [];

/**
 * Stores the browser settings. Call once at startup; the browser itself starts on first use.
 * @param {{ executablePath: string|null, channel: string|null } | null} pdfBrowserConfig
 */
export function initPdfRenderer(pdfBrowserConfig) {
  rendererConfig = pdfBrowserConfig;
  if (pdfBrowserConfig) {
    logger.info('PDF renderer configured', { channel: pdfBrowserConfig.channel, customExecutable: Boolean(pdfBrowserConfig.executablePath) });
  }
}

export function isPdfRendererConfigured() {
  return rendererConfig !== null;
}

async function getBrowser() {
  if (!rendererConfig) throw new PdfRenderError('PDF renderer is not configured');
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        timeout: PDF_RENDER_SETTINGS.BROWSER_LAUNCH_TIMEOUT_MS,
        ...(rendererConfig.executablePath ? { executablePath: rendererConfig.executablePath } : { channel: rendererConfig.channel }),
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          logger.warn('PDF renderer browser disconnected; it will be relaunched on the next render');
          browserPromise = null;
        });
        logger.info('PDF renderer browser started', { version: browser.version() });
        return browser;
      })
      .catch((launchError) => {
        browserPromise = null;
        throw new PdfRenderError(`Could not start the PDF browser: ${launchError.message.split('\n')[0]}`, { cause: launchError });
      });
  }
  return browserPromise;
}

/** Waits for a render slot (FIFO), or rejects after QUEUE_TIMEOUT_MS. */
function acquireRenderSlot() {
  if (activeRenders < PDF_RENDER_SETTINGS.MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const waiterIndex = waitingRenders.indexOf(waiter);
      if (waiterIndex !== -1) waitingRenders.splice(waiterIndex, 1);
      reject(new PdfRenderError('PDF renderer is busy; try again shortly'));
    }, PDF_RENDER_SETTINGS.QUEUE_TIMEOUT_MS);
    waitingRenders.push(waiter);
  });
}

function releaseRenderSlot() {
  const nextWaiter = waitingRenders.shift();
  if (nextWaiter) {
    clearTimeout(nextWaiter.timer);
    nextWaiter.resolve(); // the slot passes straight to the next waiter
  } else {
    activeRenders -= 1;
  }
}

/**
 * Renders one HTML document to an A4 PDF.
 * @param {string} html  a complete, self-contained HTML document
 * @returns {Promise<Readable>} the PDF bytes
 * @throws {PdfRenderError}
 */
export async function renderHtmlToPdfStream(html) {
  await acquireRenderSlot();
  let browserContext = null;
  try {
    const browser = await getBrowser();
    browserContext = await browser.newContext({ javaScriptEnabled: false, offline: true });
    await browserContext.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort('blockedbyclient')));
    const page = await browserContext.newPage();
    page.setDefaultTimeout(PDF_RENDER_SETTINGS.RENDER_TIMEOUT_MS);
    await page.setContent(html, { waitUntil: 'load', timeout: PDF_RENDER_SETTINGS.RENDER_TIMEOUT_MS });
    await page.emulateMedia({ media: 'print' });
    const pdfBytes = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    return Readable.from([pdfBytes]);
  } catch (renderError) {
    if (renderError instanceof PdfRenderError) throw renderError;
    throw new PdfRenderError(`PDF rendering failed: ${renderError.message.split('\n')[0]}`, { cause: renderError });
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
    releaseRenderSlot();
  }
}

/** Closes the shared browser (shutdown). Safe to call when it never started. */
export async function closePdfRenderer() {
  const pendingBrowser = browserPromise;
  browserPromise = null;
  if (!pendingBrowser) return;
  try {
    const browser = await pendingBrowser;
    await browser.close();
  } catch (closeError) {
    logger.warn('PDF renderer browser did not close cleanly', { error: closeError.message });
  }
}
