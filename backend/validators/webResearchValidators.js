/**
 * Request validation for the web research settings (routes/webResearchRoutes.js). Domains are
 * normalised (lower case, no trailing dot) and de-duplicated; unknown fields are refused.
 */

import { WEB_RESEARCH_SETTINGS as S } from '../constants/validation.js';
import { normalizeDomain } from '../services/webResearch/urlSafety.js';
import { refuseUnknownFields } from './agentChatValidators.js';
import { bodyNotObjectResult, isPlainObject, validationResult } from './requestShape.js';

function readDomains(value, field, errors) {
  if (!Array.isArray(value) || value.length > S.DOMAINS_MAX) {
    errors.push({ field, message: `must be a list of at most ${S.DOMAINS_MAX} domains` });
    return [];
  }
  const domains = [];
  value.forEach((entry, index) => {
    const domain = normalizeDomain(entry);
    if (!domain) errors.push({ field: `${field}[${index}]`, message: 'must be a domain name such as rbi.org.in' });
    else if (!domains.includes(domain)) domains.push(domain);
  });
  return domains.sort();
}

/** PUT /api/web-research/settings: { allowedDomains, blockedDomains, allowUnlistedDomains, version } */
export function validateWebResearchSettings(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const errors = [];
  refuseUnknownFields(requestBody, ['allowedDomains', 'blockedDomains', 'allowUnlistedDomains', 'version'], errors);
  const allowedDomains = readDomains(requestBody.allowedDomains, 'allowedDomains', errors);
  const blockedDomains = readDomains(requestBody.blockedDomains, 'blockedDomains', errors);
  if (typeof requestBody.allowUnlistedDomains !== 'boolean') {
    errors.push({ field: 'allowUnlistedDomains', message: 'must be true or false' });
  }
  if (!Number.isInteger(requestBody.version) || requestBody.version < 0) {
    errors.push({ field: 'version', message: 'must be the version you are working from' });
  }
  return validationResult(errors, {
    changes: { allowedDomains, blockedDomains, allowUnlistedDomains: requestBody.allowUnlistedDomains },
    version: requestBody.version,
  });
}
