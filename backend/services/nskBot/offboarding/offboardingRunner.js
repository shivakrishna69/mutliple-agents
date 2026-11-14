/**
 * Generates an executed offboarding case's documents (offboardingQueue.js hands it a case id), in
 * order, each uploaded to S3 (offboardingStorage.js) and recorded on the case as it is done:
 *
 *   1  RELIEVING_LETTER       PDF (offboardingDocuments.js), on the company letterhead, signed by the
 *                             signatory of the onboarding settings
 *   2  SETTLEMENT_STATEMENT   PDF, the full and final settlement with the 2-working-day banner
 *   3  ATTENDANCE_AUDIT       .xlsx (attendanceAudit.js), the last AUDIT_MONTHS months
 *
 * One worker at a time: the case is claimed with a lease (an atomic update). A document already
 * recorded is never made again, so a run that stopped resumes where it was. Each step's progress is
 * pushed over Socket.IO (OFFBOARDING_PROGRESS) to the person who started the case.
 *
 * A failed run puts the case back in the queue (BullMQ retries it with backoff; without Redis the
 * sweep does); after MAX_ATTEMPTS it is FAILED with an error code, and HR can start it again.
 */

import { Readable } from 'node:stream';
import { OFFBOARDING_MESSAGES } from '../../../constants/messages.js';
import { OFFBOARDING_SETTINGS as S } from '../../../constants/validation.js';
import EmployeeProfile from '../../../models/EmployeeProfile.js';
import OffboardingCase, { ARTIFACT_KINDS, OFFBOARDING_STATUSES } from '../../../models/OffboardingCase.js';
import { logger } from '../../../utils/logger.js';
import { S3ObjectStoreError } from '../../../utils/s3ObjectStore.js';
import { emitOffboardingProgress } from '../../../utils/socketManager.js';
import { readOfficeLocalClock } from '../../attendancePolicy.js';
import { formatDate } from '../../documentParts.js';
import { getCompanySettings } from '../../companySettings.js';
import { letterheadCompany } from '../../offerLetterGenerator.js';
import { getOnboardingSettings } from '../../onboardingService.js';
import { PdfRenderError, renderHtmlToPdfStream } from '../../pdfGenerationService.js';
import { buildAttendanceAuditWorkbook, loadAttendanceAudit } from './attendanceAudit.js';
import { compileRelievingLetterHtml, compileSettlementStatementHtml } from './offboardingDocuments.js';
import { offboardingObjectKey, offboardingStore } from './offboardingStorage.js';

const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const OFFBOARDING_ERROR_CODES = Object.freeze({
  PDF_RENDER_FAILED: 'PDF_RENDER_FAILED',
  STORAGE_FAILED: 'STORAGE_FAILED',
  GENERATION_FAILED: 'GENERATION_FAILED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
});

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const referenceOf = (caseId) => `OFF-${caseId.slice(-8).toUpperCase()}`;

/** What every document needs: the company, the signatory, today in the company's time zone. */
async function loadContext(now) {
  const [companySettings, onboardingSettings] = await Promise.all([getCompanySettings(), getOnboardingSettings()]);
  return {
    company: letterheadCompany(companySettings),
    signatory: {
      name: onboardingSettings.offerTerms.signatoryName ?? null,
      title: onboardingSettings.offerTerms.signatoryTitle ?? null,
    },
    today: readOfficeLocalClock(now, companySettings.timeZone).calendarDate,
  };
}

/** Each document: how it is made, its file name and type. */
const DOCUMENTS = Object.freeze({
  [ARTIFACT_KINDS.RELIEVING_LETTER]: {
    extension: 'pdf',
    contentType: PDF,
    fileName: (snapshot) => `Relieving and experience letter - ${snapshot.employeeCode}.pdf`,
    async build(offboardingCase, context) {
      const html = compileRelievingLetterHtml({
        company: context.company,
        signatory: context.signatory,
        employee: offboardingCase.employeeSnapshot,
        separation: offboardingCase.separation,
        service: offboardingCase.settlement.service,
        reference: referenceOf(offboardingCase._id.toString()),
      });
      return collect(await renderHtmlToPdfStream(html));
    },
  },
  [ARTIFACT_KINDS.SETTLEMENT_STATEMENT]: {
    extension: 'pdf',
    contentType: PDF,
    fileName: (snapshot) => `Full and final settlement - ${snapshot.employeeCode}.pdf`,
    async build(offboardingCase, context) {
      const html = compileSettlementStatementHtml({
        company: context.company,
        signatory: context.signatory,
        employee: offboardingCase.employeeSnapshot,
        separation: offboardingCase.separation,
        settlement: offboardingCase.settlement,
        complianceNote: OFFBOARDING_MESSAGES.SETTLEMENT_DEADLINE_NOTE(formatDate(offboardingCase.settlementDueDate)),
        issuedOn: context.today,
        reference: referenceOf(offboardingCase._id.toString()),
      });
      return collect(await renderHtmlToPdfStream(html));
    },
  },
  [ARTIFACT_KINDS.ATTENDANCE_AUDIT]: {
    extension: 'xlsx',
    contentType: XLSX,
    fileName: (snapshot) => `Attendance and leave audit - ${snapshot.employeeCode}.xlsx`,
    async build(offboardingCase, context, now) {
      const profile = await EmployeeProfile.findById(offboardingCase.employeeId)
        .select('organizationData.officeLocationId')
        .lean();
      const audit = await loadAttendanceAudit({
        profile: { _id: offboardingCase.employeeId, organizationData: profile?.organizationData ?? {} },
        snapshot: offboardingCase.employeeSnapshot,
        lastWorkingDay: offboardingCase.separation.lastWorkingDay,
        today: context.today,
      });
      return buildAttendanceAuditWorkbook(audit, {
        companyName: context.company.legalName ?? context.company.name,
        generatedAt: now,
      });
    },
  },
});

function progressPayload(offboardingCase) {
  return {
    caseId: offboardingCase._id.toString(),
    employeeId: offboardingCase.employeeId.toString(),
    status: offboardingCase.status,
    progress: offboardingCase.progress,
    lastErrorCode: offboardingCase.lastErrorCode ?? null,
    artifacts: (offboardingCase.artifacts ?? []).map((artifact) => ({
      id: artifact._id.toString(),
      kind: artifact.kind,
      fileName: artifact.fileName,
      sizeBytes: artifact.sizeBytes,
    })),
  };
}

function announce(offboardingCase) {
  if (offboardingCase?.executedByUserId) {
    emitOffboardingProgress(offboardingCase.executedByUserId.toString(), progressPayload(offboardingCase));
  }
}

/** Takes the case if it is queued, or generating under a lease that has run out. Null if not available. */
function claimCase(caseId, workerId, now) {
  return OffboardingCase.findOneAndUpdate(
    {
      _id: caseId,
      $or: [
        { status: OFFBOARDING_STATUSES.QUEUED },
        { status: OFFBOARDING_STATUSES.GENERATING, 'lease.until': { $lt: now } },
      ],
    },
    {
      $set: {
        status: OFFBOARDING_STATUSES.GENERATING,
        lease: { owner: workerId, until: new Date(now.getTime() + S.LEASE_MS) },
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
}

/** An update that only applies while this worker still holds the lease; the case after it, or null. */
function updateHeld(caseId, workerId, update) {
  return OffboardingCase.findOneAndUpdate({ _id: caseId, 'lease.owner': workerId }, update, { new: true }).lean();
}

const errorCodeOf = (runError) => {
  if (runError instanceof PdfRenderError) return OFFBOARDING_ERROR_CODES.PDF_RENDER_FAILED;
  if (runError instanceof S3ObjectStoreError) return OFFBOARDING_ERROR_CODES.STORAGE_FAILED;
  return OFFBOARDING_ERROR_CODES.GENERATION_FAILED;
};

async function finishFailed(caseId, workerId, code) {
  announce(
    await updateHeld(caseId, workerId, {
      $set: {
        status: OFFBOARDING_STATUSES.FAILED,
        lastErrorCode: code,
        'progress.currentStep': null,
        lease: { owner: null, until: null },
      },
    }),
  );
}

/**
 * @param {string} caseId
 * @param {{ workerId: string }} context
 */
export async function runOffboardingJob(caseId, { workerId }) {
  const now = new Date();
  let claimed = await claimCase(caseId, workerId, now);
  if (!claimed) return;
  if (claimed.attempts > S.MAX_ATTEMPTS) {
    await finishFailed(caseId, workerId, OFFBOARDING_ERROR_CODES.TOO_MANY_ATTEMPTS);
    return;
  }
  announce(claimed);
  try {
    const context = await loadContext(now);
    for (const kind of Object.values(ARTIFACT_KINDS)) {
      if (claimed.artifacts.some((artifact) => artifact.kind === kind)) continue;
      claimed = await updateHeld(caseId, workerId, {
        $set: { 'progress.currentStep': kind, 'lease.until': new Date(Date.now() + S.LEASE_MS) },
      });
      if (!claimed) return;
      announce(claimed);
      const document = DOCUMENTS[kind];
      const bytes = await document.build(claimed, context, now);
      const s3Key = offboardingObjectKey(caseId, kind, document.extension);
      const stored = await offboardingStore.upload(Readable.from([bytes]), s3Key, document.contentType);
      const artifact = {
        kind,
        fileName: document.fileName(claimed.employeeSnapshot),
        contentType: document.contentType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        s3Key,
        generatedAt: new Date(),
      };
      claimed = await updateHeld(caseId, workerId, {
        $push: { artifacts: artifact },
        $inc: { 'progress.completedSteps': 1 },
      });
      if (!claimed) {
        // Another worker took the case over meanwhile: its own run records this document.
        await offboardingStore.deleteQuietly(s3Key);
        return;
      }
    }
    announce(
      await updateHeld(caseId, workerId, {
        $set: {
          status: OFFBOARDING_STATUSES.COMPLETED,
          completedAt: new Date(),
          lastErrorCode: null,
          'progress.currentStep': null,
          lease: { owner: null, until: null },
        },
      }),
    );
  } catch (runError) {
    const code = errorCodeOf(runError);
    logger.error('Offboarding documents could not be generated', {
      caseId,
      attempt: claimed?.attempts ?? null,
      code,
      error: { name: runError.name, message: runError.message },
    });
    if ((claimed?.attempts ?? S.MAX_ATTEMPTS) >= S.MAX_ATTEMPTS) {
      await finishFailed(caseId, workerId, code);
      return;
    }
    announce(
      await updateHeld(caseId, workerId, {
        $set: { status: OFFBOARDING_STATUSES.QUEUED, lastErrorCode: code, lease: { owner: null, until: null } },
      }),
    );
    throw runError;
  }
}
