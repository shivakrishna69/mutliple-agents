/**
 * Checks that this machine can produce offer letters, end to end, without touching the database
 * or sending anything: it renders a sample letter with the configured Chromium
 * (PDF_BROWSER_EXECUTABLE_PATH or PDF_BROWSER_CHANNEL), locks it with qpdf (QPDF_PATH) using a
 * sample date of birth, then confirms with qpdf that the letter is AES-256 encrypted, that the date
 * of birth opens it, that another password does not, and that it prints on SAMPLE_LETTER_PAGES pages
 * (one per section: the sample's content fits each section on its page).
 *
 *   node scripts/checkOfferLetterPdf.js        (in the backend folder, or in the backend container)
 *
 * Prints one line per check and exits 0 when all pass, 1 otherwise. CI runs it inside the
 * production image (.github/workflows/ci.yml, "Offer letter PDFs").
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadOfferLetterConfig, loadPdfBrowserConfig } from '../config/environment.js';
import { ONBOARDING_SETTINGS } from '../constants/validation.js';
import { computeCtcStructure } from '../services/ctcStructure.js';
import { initOfferLetters, offerLetterPassword, renderOfferLetter } from '../services/offerLetterGenerator.js';
import { closePdfRenderer, initPdfRenderer } from '../services/pdfGenerationService.js';

const runFile = promisify(execFile);
// Sample data only: nothing here is a real person.
const SAMPLE_DATE_OF_BIRTH = new Date('1995-06-15T00:00:00Z');
const SAMPLE_JOINING_DATE = new Date('2026-12-01T00:00:00Z');
const AES_256_REVISION = /R = 6/;
const SAMPLE_LETTER_PAGES = 5;

async function main() {
  const pdfBrowser = loadPdfBrowserConfig();
  if (!pdfBrowser) throw new Error('No PDF browser: set PDF_BROWSER_EXECUTABLE_PATH or PDF_BROWSER_CHANNEL');
  const offerLetters = loadOfferLetterConfig();
  initPdfRenderer(pdfBrowser);
  initOfferLetters(offerLetters);
  const { stdout: qpdfVersion } = await runFile(offerLetters.qpdfPath, ['--version']);
  console.log(`using ${qpdfVersion.split('\n')[0]}`);

  const structure = computeCtcStructure(
    {
      annualCtc: 25_00_000,
      variablePayAnnual: 2_50_000,
      taxRegime: 'new',
      workCity: 'Bengaluru',
      professionalTaxState: 'KA',
      dateOfBirth: SAMPLE_DATE_OF_BIRTH,
      joiningDate: SAMPLE_JOINING_DATE,
    },
    ONBOARDING_SETTINGS.DEFAULT_COMPENSATION_POLICY,
  );
  const { pdf, sha256 } = await renderOfferLetter(
    {
      company: { name: 'Sample Company', legalName: null, registeredAddress: null, brandColor: '#1f5bff' },
      candidate: { name: 'Sample Candidate' },
      position: {
        designation: 'Sample Role',
        departmentName: 'Sample Department',
        managerName: null,
        dateOfJoining: SAMPLE_JOINING_DATE,
        workLocationType: 'Onsite',
        employmentStatus: 'Probation',
        employmentType: 'full_time',
      },
      structure,
      stockOptions: { units: 1_200, note: ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.esopNote },
      terms: {
        ...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS,
        shiftTimings: '9:30 am to 6:30 pm, Monday to Friday',
        additionalClauses: ['You may be asked to travel for work from time to time.'],
        signatoryName: 'Sample Signatory',
        signatoryTitle: 'Head of People',
      },
      leavePolicy: [
        { name: 'Casual Leave', annualDays: 12 },
        { name: 'Sick Leave', annualDays: 6 },
      ],
      issuedOn: new Date(),
      validUntil: new Date(),
    },
    { preview: false, dateOfBirth: SAMPLE_DATE_OF_BIRTH },
  );
  console.log(`rendered and locked: ${pdf.length} bytes, sha256 ${sha256.slice(0, 16)}…`);

  const workFolder = await mkdtemp(path.join(tmpdir(), 'nsk-pdf-check-'));
  try {
    const pdfPath = path.join(workFolder, 'letter.pdf');
    await writeFile(pdfPath, pdf);
    const password = offerLetterPassword(SAMPLE_DATE_OF_BIRTH);
    const { stdout } = await runFile(offerLetters.qpdfPath, ['--show-encryption', `--password=${password}`, pdfPath]);
    if (!AES_256_REVISION.test(stdout)) throw new Error('the letter is not AES-256 encrypted');
    console.log('encrypted with AES-256, and the date of birth opens it');
    const wrongPasswordOpens = await runFile(offerLetters.qpdfPath, ['--check', '--password=00000000', pdfPath]).then(
      () => true,
      () => false,
    );
    if (wrongPasswordOpens) throw new Error('another password opened the letter');
    console.log('another password does not open it');
    const { stdout: pageCount } = await runFile(offerLetters.qpdfPath, [
      '--show-npages',
      `--password=${password}`,
      pdfPath,
    ]);
    if (Number(pageCount.trim()) !== SAMPLE_LETTER_PAGES) {
      throw new Error(`the sample letter has ${pageCount.trim()} pages, not ${SAMPLE_LETTER_PAGES}`);
    }
    console.log(`prints on ${SAMPLE_LETTER_PAGES} pages`);
  } finally {
    await rm(workFolder, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log('offer letters: OK');
} catch (checkError) {
  // A qpdf failure carries its cause in `reason` (services/pdfProtection.js).
  console.error(`offer letters: FAILED - ${checkError.reason ?? checkError.message}`);
  process.exitCode = 1;
} finally {
  await closePdfRenderer();
}
