/**
 * The administrator's web research settings (services/webResearch/webResearchSettings.js), mounted at
 * /api/web-research for MANAGE_COMPANY_SETTINGS (admin, IT administrator):
 *
 *   GET    /settings            the domain lists and whether unlisted domains may be read
 *   PUT    /settings            { allowedDomains, blockedDomains, allowUnlistedDomains, version }; cached
 *                               pages are brought in line (blocked domains removed, approval updated)
 *   GET    /sources             the cached pages, newest first
 *   DELETE /sources/:sourceId   remove one cached page (record and indexed chunks)
 *
 * Changes are audited (category "web_research") with counts and domains, never page content.
 */

import { CAPABILITIES } from '../constants/accessRoles.js';
import { WEB_RESEARCH_MESSAGES } from '../constants/messages.js';
import {
  getWebResearchSettings,
  listCachedSources,
  removeCachedSource,
  toSettingsSummary,
  updateWebResearchSettings,
} from '../services/webResearch/webResearchSettings.js';
import { validateWebResearchSettings } from '../validators/webResearchValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const handler = createWorkforceHandlerFactory({
  auditCategory: 'web_research',
  restrictedMessage: WEB_RESEARCH_MESSAGES.NOT_ALLOWED,
  inputInvalidMessage: WEB_RESEARCH_MESSAGES.INPUT_INVALID,
});
const READ = Object.freeze({ capability: CAPABILITIES.MANAGE_COMPANY_SETTINGS, isWrite: false });
const WRITE = Object.freeze({ capability: CAPABILITIES.MANAGE_COMPANY_SETTINGS, isWrite: true });
const callContextOf = (req) => ({ config: req.app.locals.config, requestId: req.id });

export const getSettings = handler('view_web_research_settings', READ, async () => ({
  message: WEB_RESEARCH_MESSAGES.SETTINGS_RETRIEVED,
  data: { settings: toSettingsSummary(await getWebResearchSettings()) },
}));

export const putSettings = handler('update_web_research_settings', WRITE, async (req) => {
  const validation = validateWebResearchSettings(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const { settings, synced } = await updateWebResearchSettings({
    ...validation.sanitizedInput,
    actorUserId: req.user.id,
    callContext: callContextOf(req),
  });
  return {
    message: WEB_RESEARCH_MESSAGES.SETTINGS_UPDATED,
    data: { settings, synced },
    auditDetails: {
      allowedDomains: settings.allowedDomains.length,
      blockedDomains: settings.blockedDomains.length,
      allowUnlistedDomains: settings.allowUnlistedDomains,
      ...synced,
    },
  };
});

export const getSources = handler('list_cached_web_pages', READ, async () => ({
  message: WEB_RESEARCH_MESSAGES.SOURCES_RETRIEVED,
  data: { sources: await listCachedSources() },
}));

export const deleteSource = handler('remove_cached_web_page', WRITE, async (req) => {
  const validationErrors = idParamErrors(req.params, 'sourceId');
  if (validationErrors) return { validationErrors };
  const removed = await removeCachedSource({ sourceId: req.params.sourceId, callContext: callContextOf(req) });
  return {
    message: WEB_RESEARCH_MESSAGES.SOURCE_REMOVED,
    data: removed,
    auditDetails: { sourceId: removed.id, domain: removed.domain },
  };
});
