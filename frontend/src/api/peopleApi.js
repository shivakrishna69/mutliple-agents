/**
 * Employee onboarding endpoints (backend routes/peopleRoutes.js and routes/invitationRoutes.js).
 *   HR/admin (session): invitation form options, list, create, resend, revoke
 *   Public (token):     preview an invitation, accept it (creates the account and signs in)
 */

import { sendApiRequest } from './httpClient.js';

const encode = encodeURIComponent;

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

async function postData(endpointPath, requestPayload, csrfToken) {
  const { responseData } = await sendApiRequest({ method: 'POST', endpointPath, requestPayload, csrfToken });
  return responseData;
}

export const requestInvitationOptions = (callerSignal) => getData('/api/people/invitations/options', callerSignal);
export const requestInvitations = (status, callerSignal) => getData(`/api/people/invitations${status ? `?status=${encode(status)}` : ''}`, callerSignal);
export const requestInvitationCreation = (invitationInput, csrfToken) => postData('/api/people/invitations', invitationInput, csrfToken);
export const requestInvitationResend = (invitationId, csrfToken) => postData(`/api/people/invitations/${encode(invitationId)}/resend`, {}, csrfToken);
export const requestInvitationRevoke = (invitationId, csrfToken) => postData(`/api/people/invitations/${encode(invitationId)}/revoke`, {}, csrfToken);

export const requestInvitationPreview = (token, callerSignal) => getData(`/api/invitations/${encode(token)}`, callerSignal);
export const requestInvitationAcceptance = (token, password) => postData(`/api/invitations/${encode(token)}/accept`, { password });
