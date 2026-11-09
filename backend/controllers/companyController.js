/**
 * Company settings endpoints (routes/companyRoutes.js): the branding anyone may see, the full
 * settings for READ_COMPANY_SETTINGS (admins, IT administrators, HR), and changes by
 * MANAGE_COMPANY_SETTINGS (admins, IT administrators). Changes are audited.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { COMPANY_MESSAGES } from '../constants/messages.js';
import { CAPABILITIES, hasCapability } from '../constants/accessRoles.js';
import {
  getCompanySettings,
  toCompanyBranding,
  toCompanySettingsSummary,
  updateCompanySettings,
} from '../services/companySettings.js';
import { ServiceError } from '../services/serviceError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { validateCompanySettingsChanges } from '../validators/companyValidators.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

const companyHandler = createWorkforceHandlerFactory({
  auditCategory: 'company',
  restrictedMessage: COMPANY_MESSAGES.RESTRICTED,
  inputInvalidMessage: COMPANY_MESSAGES.INPUT_INVALID,
});

/** GET /api/company/branding (public: the sign-in page shows the company's name and logo) */
export async function getCompanyBranding(req, res, next) {
  try {
    const settings = await getCompanySettings();
    return sendSuccess(res, HTTP_STATUS.OK, COMPANY_MESSAGES.BRANDING_RETRIEVED, {
      branding: toCompanyBranding(settings),
    });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/company/settings */
export const getCompanySettingsHandler = companyHandler(
  'view_company_settings',
  { capability: CAPABILITIES.READ_COMPANY_SETTINGS, isWrite: false },
  async () => ({
    message: COMPANY_MESSAGES.SETTINGS_RETRIEVED,
    data: { settings: toCompanySettingsSummary(await getCompanySettings()) },
  }),
);

/** PATCH /api/company/settings (admins and IT administrators; HR is told who can) */
export const patchCompanySettings = companyHandler(
  'update_company_settings',
  { capability: CAPABILITIES.READ_COMPANY_SETTINGS, isWrite: true },
  async (req) => {
    if (!hasCapability(req.user.role, CAPABILITIES.MANAGE_COMPANY_SETTINGS)) {
      throw new ServiceError(HTTP_STATUS.FORBIDDEN, 'ADMINS_ONLY', COMPANY_MESSAGES.ADMINS_ONLY);
    }
    const validation = validateCompanySettingsChanges(req.body);
    if (!validation.isValid) return validation;
    const settings = await updateCompanySettings({ ...validation.sanitizedInput, actorUserId: req.user.id });
    return {
      message: COMPANY_MESSAGES.SETTINGS_UPDATED,
      data: { settings },
      auditDetails: { changedFields: Object.keys(validation.sanitizedInput.changes) },
    };
  },
);
