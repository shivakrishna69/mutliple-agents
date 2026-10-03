/**
 * Document vault routes, mounted in server.js under `/api/vault`.
 *
 *   POST  /documents                         upload (multipart/form-data)
 *   GET   /employees/:employeeId/documents   list one employee's readable documents
 *   GET   /download/:documentId              60-second pre-signed download URL
 *   PATCH /documents/:documentId/verify      mark verified
 *
 * Middleware order per request:
 *   protect            session cookie (401) and, on POST/PATCH, the CSRF token; loads req.user
 *   no-store           responses carry document metadata or short-lived URLs; never cache them
 *   rate limit         per user, before any file is buffered
 *   receiveVaultUpload multipart parsing with size/count limits (uploads only)
 */

import { Router } from 'express';
import { downloadDocument, listEmployeeDocuments, uploadDocument, verifyDocument } from '../controllers/vaultController.js';
import { protect } from '../middleware/authMiddleware.js';
import { vaultDownloadRateLimitByUser, vaultUploadRateLimitByUser } from '../middleware/rateLimiter.js';
import { receiveVaultUpload } from '../middleware/vaultUpload.js';

const vaultRouter = Router();

vaultRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

vaultRouter.post('/documents', vaultUploadRateLimitByUser, receiveVaultUpload, uploadDocument);
vaultRouter.get('/employees/:employeeId/documents', listEmployeeDocuments);
vaultRouter.get('/download/:documentId', vaultDownloadRateLimitByUser, downloadDocument);
vaultRouter.patch('/documents/:documentId/verify', verifyDocument);

export default vaultRouter;
