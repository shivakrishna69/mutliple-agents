/**
 * Onboarding offers (backend /api/hr/onboarding; services/onboardingService.js). Reads return the
 * response's `data`; changes return `{ ...data, notice }` with the backend's message. Every error is
 * an ApiError (api/httpClient.js) carrying the backend's message and field details.
 *
 *   GET   /settings                      policy and offer terms
 *   POST  /calculate                     the salary structure; with includePreview, the letter (base64 PDF)
 *   POST  /create-draft                  save an offer for review
 *   GET   /drafts?status=                drafts, newest first, each with its lifecycle
 *   PATCH /drafts/:id   POST /drafts/:id/cancel   POST /drafts/:id/dispatch
 *   POST  /drafts/import                 a CSV: every row a draft, or every problem by line and column
 *   POST  /drafts/bulk-send              { draftIds }: each sent in turn, every outcome reported
 */

import { sendApiRequest } from './httpClient.js';
import { toQueryString } from './queryString.js';

const BASE = '/api/hr/onboarding';
const encode = encodeURIComponent;

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

async function change(method, endpointPath, requestPayload, csrfToken) {
  const { responseData, responseMessage } = await sendApiRequest({ method, endpointPath, requestPayload, csrfToken });
  return { ...responseData, notice: responseMessage };
}

export const requestOfferSettings = (callerSignal) => getData(`${BASE}/settings`, callerSignal);

/** @param {object} offer  the offer as the backend takes it; includePreview asks for the letter too */
export const requestOfferCalculation = (offer, csrfToken) => change('POST', `${BASE}/calculate`, offer, csrfToken);

export const requestOfferDraftCreation = (offer, csrfToken) => change('POST', `${BASE}/create-draft`, offer, csrfToken);

export const requestOfferDrafts = (status, callerSignal) =>
  getData(`${BASE}/drafts${toQueryString({ status })}`, callerSignal);

export const requestOfferDraftCancel = (draftId, version, csrfToken) =>
  change('POST', `${BASE}/drafts/${encode(draftId)}/cancel`, { version }, csrfToken);

export const requestOfferDispatch = (draftId, csrfToken) =>
  change('POST', `${BASE}/drafts/${encode(draftId)}/dispatch`, {}, csrfToken);

export const requestOfferBulkSend = (draftIds, csrfToken) =>
  change('POST', `${BASE}/drafts/bulk-send`, { draftIds }, csrfToken);

export async function requestOfferImport(file, csrfToken) {
  const formData = new FormData();
  formData.append('file', file);
  const { responseData, responseMessage } = await sendApiRequest({
    method: 'POST',
    endpointPath: `${BASE}/drafts/import`,
    formData,
    csrfToken,
  });
  return { ...responseData, notice: responseMessage };
}
