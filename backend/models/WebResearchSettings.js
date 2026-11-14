/**
 * WebResearchSettings: the administrator's rules for NSK's web research (one document, key
 * "webResearch"), changed through PUT /api/web-research/settings.
 *
 *   allowedDomains        trusted sites: their pages are read and cached for everyone (approved)
 *   blockedDomains        never read, by anyone; cached pages of a newly blocked domain are removed
 *   allowUnlistedDomains  whether people with RUN_WEB_RESEARCH may read other sites too (cached for
 *                         them only). Off: only allowed domains are read.
 *
 * A list entry covers its subdomains. A domain cannot be on both lists. The version (__v) guards
 * against two administrators overwriting each other.
 */

import mongoose from 'mongoose';

export const WEB_RESEARCH_SETTINGS_KEY = 'webResearch';

const webResearchSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, immutable: true, default: WEB_RESEARCH_SETTINGS_KEY },
    allowedDomains: { type: [String], default: [] },
    blockedDomains: { type: [String], default: [] },
    allowUnlistedDomains: { type: Boolean, default: true },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

webResearchSettingsSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('WebResearchSettings', webResearchSettingsSchema);
