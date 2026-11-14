/**
 * ExternalSource: one web page NSK read and keeps as external knowledge (services/webResearch/), its
 * chunks embedded in the ai-service's Qdrant collection `external_knowledge` under this record's id.
 *
 *   url, domain        the page as asked for (normalised; one record per URL) and the host it came from
 *   finalUrl           where its redirects ended
 *   approved           its domain is on the admin's allowlist: everyone may read it from the cache.
 *                      Otherwise only people with RUN_WEB_RESEARCH may (it was read for one of them).
 *                      Kept in step with the settings when the lists change.
 *   fetchedAt          when it was read; every citation shows it
 *   expiresAt          fetchedAt + EXTERNAL_KNOWLEDGE_TTL_DAYS: after it, searches skip the page and
 *                      the cleanup job removes it here and from the index (no TTL index, so the two
 *                      are removed together)
 *   excerpt            the first WEB_RESEARCH_SETTINGS.EXCERPT_CHARS of its readable text, so a page
 *                      read again within its life is answered without fetching it
 *   sha256, chunkCount the readable text's hash and how many chunks were indexed
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const externalSourceSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, maxlength: 2048 },
    finalUrl: { type: String, required: true, maxlength: 2048 },
    domain: { type: String, required: true, maxlength: 253 },
    title: { type: String, required: true, maxlength: 300 },
    byline: { type: String, default: null, maxlength: 300 },
    approved: { type: Boolean, required: true },
    fetchedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    excerpt: { type: String, required: true },
    sha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    sizeBytes: { type: Number, required: true, min: 0 },
    chunkCount: { type: Number, required: true, min: 0 },
    // false when the page was read but its chunks could not be indexed (the ai-service was down):
    // it is answered from `excerpt` until it expires, and not found by searches.
    indexed: { type: Boolean, required: true },
    fetchedByUserId: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

externalSourceSchema.index({ url: 1 }, { unique: true });
externalSourceSchema.index({ expiresAt: 1 });
externalSourceSchema.index({ domain: 1 });

export default mongoose.model('ExternalSource', externalSourceSchema);
