/**
 * Why a PDF could not be protected (services/pdfProtection.js): the reason the server logs must
 * name the actual cause. The invalid-input case needs qpdf (QPDF_PATH, default "qpdf") and is
 * skipped without it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PdfProtectionError, isQpdfAvailable, protectPdfWithPassword } from '../../services/pdfProtection.js';

const qpdfPath = process.env.QPDF_PATH || 'qpdf';
const qpdfMissing = !(await isQpdfAvailable(qpdfPath));

describe('protectPdfWithPassword failures', () => {
  it('says when qpdf is not installed', async () => {
    await assert.rejects(
      protectPdfWithPassword(Buffer.from('%PDF-'), '15061995', { qpdfPath: 'qpdf-that-does-not-exist' }),
      (protectionError) => protectionError instanceof PdfProtectionError && protectionError.reason === 'qpdf not found',
    );
  });

  it(
    'gives qpdf’s exit code and error for a file it cannot read, without the password',
    { skip: qpdfMissing },
    async () => {
      await assert.rejects(
        protectPdfWithPassword(Buffer.from('not a pdf'), '15061995', { qpdfPath }),
        (protectionError) => {
          assert.ok(protectionError instanceof PdfProtectionError);
          assert.match(protectionError.reason, /^qpdf exited with \d+: \S/);
          assert.doesNotMatch(protectionError.reason, /15061995/);
          return true;
        },
      );
    },
  );
});
