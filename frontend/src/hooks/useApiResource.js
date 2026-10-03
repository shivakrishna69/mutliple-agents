/**
 * useApiResource: loads one API resource for a component and keeps loading/error/data state.
 *
 *   const { data, error, isLoading, reload, setData } = useApiResource(
 *     (signal) => requestSomething(params, signal),
 *     [params],                       // reloads when these change
 *     { enabled: true },              // false skips loading (e.g. the user lacks the role)
 *   );
 *
 * Each load gets its own AbortController; a newer load or unmounting aborts the previous one,
 * so a slow response can never overwrite newer data or update an unmounted component.
 * A 401 means the session ended: AuthContext is told, which signs the UI out.
 * `error` is an ApiError-like object ({ message, status, requestId }), safe to display.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, HTTP_STATUS_UNAUTHORIZED } from '../api/httpClient.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { API_MESSAGES } from '../constants/messages.js';

export function toDisplayError(caughtError) {
  if (caughtError instanceof ApiError) {
    return { message: caughtError.message, status: caughtError.status, requestId: caughtError.status >= 500 ? caughtError.requestId : null, fieldErrors: caughtError.fieldErrors ?? {} };
  }
  return { message: API_MESSAGES.UNEXPECTED_SERVER_ERROR, status: 0, requestId: null, fieldErrors: {} };
}

export function useApiResource(loadResource, dependencies, { enabled = true } = {}) {
  const { markSessionEnded } = useAuth();
  const [resourceState, setResourceState] = useState({ data: null, error: null, isLoading: enabled });
  const activeControllerRef = useRef(null);
  const loadResourceRef = useRef(loadResource);
  loadResourceRef.current = loadResource;

  const reload = useCallback(async () => {
    activeControllerRef.current?.abort();
    const loadController = new AbortController();
    activeControllerRef.current = loadController;
    setResourceState((previousState) => ({ ...previousState, isLoading: true, error: null }));
    try {
      const loadedData = await loadResourceRef.current(loadController.signal);
      if (!loadController.signal.aborted) setResourceState({ data: loadedData, error: null, isLoading: false });
    } catch (loadError) {
      if (loadController.signal.aborted) return;
      if (loadError instanceof ApiError && loadError.status === HTTP_STATUS_UNAUTHORIZED) {
        markSessionEnded();
        return;
      }
      setResourceState((previousState) => ({ ...previousState, error: toDisplayError(loadError), isLoading: false }));
    }
  }, [markSessionEnded]);

  useEffect(() => {
    if (!enabled) {
      setResourceState({ data: null, error: null, isLoading: false });
      return undefined;
    }
    reload();
    return () => activeControllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reload, ...dependencies]);

  const setData = useCallback((updateData) => {
    setResourceState((previousState) => ({ ...previousState, data: typeof updateData === 'function' ? updateData(previousState.data) : updateData }));
  }, []);

  return { ...resourceState, reload, setData };
}
