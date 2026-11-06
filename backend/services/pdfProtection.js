/**
 * Password protection for finished PDFs, with qpdf (https://qpdf.readthedocs.io; Apache-2.0):
 * AES-256 encryption (OFFER_LETTER_PROTECTION.KEY_LENGTH_BITS) with
 *
 *   user password    what the reader types to open the file
 *   owner password   random, never stored: nobody can lift the restrictions below
 *   permissions      full-quality printing allowed (the letter is print-ready); editing and
 *                    copying text out are not
 *
 * qpdf works on files, so the PDF goes through a private temporary folder that is always removed.
 * The passwords are passed in an argument file (qpdf's @file), never on the command line, where
 * any other process on the server could read them. The executable is QPDF_PATH (config).
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { OFFER_LETTER_PROTECTION } from '../constants/validation.js';

const runFile = promisify(execFile);
const OWNER_PASSWORD_BYTES = 32;
const PRIVATE_FILE_MODE = 0o600;
const QPDF_EXIT_SUCCESS_WITH_WARNINGS = 3;

/** qpdf could not run or failed; `reason` is for the logs only. */
export class PdfProtectionError extends Error {
  constructor(reason) {
    super('PDF protection failed');
    this.name = 'PdfProtectionError';
    this.reason = reason;
  }
}

/** True when the qpdf at `qpdfPath` answers --version. */
export async function isQpdfAvailable(qpdfPath) {
  try {
    await runFile(qpdfPath, ['--version'], { timeout: OFFER_LETTER_PROTECTION.QPDF_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Buffer} pdf             the PDF to protect
 * @param {string} userPassword    what the reader will type to open it
 * @param {{ qpdfPath: string }} options
 * @returns {Promise<Buffer>} the encrypted PDF
 * @throws {PdfProtectionError}
 */
export async function protectPdfWithPassword(pdf, userPassword, { qpdfPath }) {
  const workFolder = await mkdtemp(path.join(tmpdir(), 'nsk-pdf-'));
  try {
    const inputPath = path.join(workFolder, 'input.pdf');
    const outputPath = path.join(workFolder, 'output.pdf');
    const argumentsPath = path.join(workFolder, 'arguments');
    await writeFile(inputPath, pdf, { mode: PRIVATE_FILE_MODE });
    // One argument per line (qpdf's @file format).
    const qpdfArguments = [
      inputPath,
      '--encrypt',
      `--user-password=${userPassword}`,
      `--owner-password=${randomBytes(OWNER_PASSWORD_BYTES).toString('hex')}`,
      `--bits=${OFFER_LETTER_PROTECTION.KEY_LENGTH_BITS}`,
      '--print=full',
      '--modify=none',
      '--extract=n',
      '--',
      outputPath,
    ];
    await writeFile(argumentsPath, `${qpdfArguments.join('\n')}\n`, { mode: PRIVATE_FILE_MODE });
    try {
      await runFile(qpdfPath, [`@${argumentsPath}`], { timeout: OFFER_LETTER_PROTECTION.QPDF_TIMEOUT_MS });
    } catch (qpdfError) {
      // qpdf exits with 3 when it succeeded but noted warnings about the input.
      if (qpdfError.code !== QPDF_EXIT_SUCCESS_WITH_WARNINGS) {
        throw new PdfProtectionError(qpdfError.code === 'ENOENT' ? 'qpdf not found' : 'qpdf failed');
      }
    }
    return await readFile(outputPath);
  } finally {
    await rm(workFolder, { recursive: true, force: true });
  }
}
