/**
 * One request at a time from a signed-out screen, and what the server said about it.
 *
 *   run(send)   calls send(signal) unless a request is already running (a synchronous guard, so a
 *               double click sends once). Resolves to the answer, or to null when it failed or the
 *               screen was left (the request is then aborted and nothing is updated).
 *   error       the failure to show: { message, code, context, requestId }; the message is the
 *               server's (ApiError), or the API client's for network trouble
 *   fieldErrors { field: message } from the server's per-field details
 *
 * Nothing here writes a message of its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/authApi.js';
import { API_MESSAGES } from '../constants/messages.js';

const SERVER_FAULT_STATUS = 500;

export function useAuthRequest() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const isRunningRef = useRef(false);
  const controllerRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (send) => {
    if (isRunningRef.current) return null;
    isRunningRef.current = true;
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      return await send(controller.signal);
    } catch (requestError) {
      if (controller.signal.aborted) return null;
      if (requestError instanceof ApiError) {
        setError({
          message: requestError.message,
          code: requestError.code,
          context: requestError.context,
          requestId: requestError.status >= SERVER_FAULT_STATUS ? requestError.requestId : null,
        });
        setFieldErrors(requestError.fieldErrors);
      } else {
        setError({ message: API_MESSAGES.UNEXPECTED_SERVER_ERROR, code: null, context: null, requestId: null });
      }
      return null;
    } finally {
      if (!controller.signal.aborted) {
        isRunningRef.current = false;
        setIsSubmitting(false);
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { run, isSubmitting, error, fieldErrors, clearError };
}
