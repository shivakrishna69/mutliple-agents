/**
 * Presence endpoints (routes/presenceRoutes.js, mounted at /api/presence). Everyone signed in uses
 * their own; team views follow services/teamRoster.js.
 */

import { PRESENCE_MESSAGES } from '../constants/messages.js';
import { acknowledgePresenceNotice, getOwnPresenceSetup } from '../services/presenceSettings.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

const presenceHandler = createWorkforceHandlerFactory({
  auditCategory: 'presence',
  restrictedMessage: PRESENCE_MESSAGES.FORBIDDEN,
  inputInvalidMessage: PRESENCE_MESSAGES.QUERY_INVALID,
});

const ANYONE_READ = Object.freeze({ requiresWorkforceAdmin: false, isWrite: false });
const ANYONE_WRITE = Object.freeze({ requiresWorkforceAdmin: false, isWrite: true });

/** GET /api/presence/me : whether my activity is recorded, after how long I show Away, the notice. */
export const getOwnPresence = presenceHandler('view_own_presence_setup', ANYONE_READ, async (req) => ({
  message: PRESENCE_MESSAGES.SETUP_RETRIEVED,
  data: { presence: await getOwnPresenceSetup(req.user.id) },
}));

/** POST /api/presence/notice : { version } of the notice I read. Audited: it is a consent record. */
export const postNoticeAcknowledgement = presenceHandler('acknowledge_presence_notice', ANYONE_WRITE, async (req) => {
  const version = req.body?.version;
  if (!Number.isInteger(version)) {
    return { validationErrors: [{ field: 'version', message: PRESENCE_MESSAGES.NOTICE_VERSION_INVALID }] };
  }
  const presence = await acknowledgePresenceNotice({ userId: req.user.id, version });
  return {
    message: PRESENCE_MESSAGES.NOTICE_ACKNOWLEDGED,
    data: { presence },
    auditDetails: { noticeVersion: version },
  };
});
