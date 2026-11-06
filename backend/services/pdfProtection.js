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

/**
 * Why qpdf failed, for the logs: not found, timed out, or its exit code and first error line. The
 * passwords are only ever in the argument file, and qpdf's messages name files, not passwords.
 */
function describeQpdfFailure(qpdfError) {
  if (qpdfError.code === 'ENOENT') return 'qpdf not found';
  if (qpdfError.killed) return `qpdf timed out after ${OFFER_LETTER_PROTECTION.QPDF_TIMEOUT_MS} ms`;
  const firstErrorLine = String(qpdfError.stderr ?? '')
    .split('\n')
    .find((line) => line.trim());
  return `qpdf exited with ${qpdfError.code}${firstErrorLine ? `: ${firstErrorLine.trim()}` : ''}`;
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
    // One argument per line (qpdf's @file format). The positional form "--encrypt <user> <owner>
    // <bits>" works in every qpdf version (Debian ships 11.x, which lacks --user-password=).
    const qpdfArguments = [
      inputPath,
      '--encrypt',
      userPassword,
      randomBytes(OWNER_PASSWORD_BYTES).toString('hex'),
      String(OFFER_LETTER_PROTECTION.KEY_LENGTH_BITS),
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
        throw new PdfProtectionError(describeQpdfFailure(qpdfError));
      }
    }
    return await readFile(outputPath);
  } finally {
    await rm(workFolder, { recursive: true, force: true });
  }
}
