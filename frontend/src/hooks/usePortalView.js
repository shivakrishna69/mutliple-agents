/**
 * Which portal view the signed-in person sees (constants/portal.js):
 *
 *   const { canSwitch, view, setView } = usePortalView(currentUser);
 *
 * Only people with a PORTAL_SWITCH_CAPABILITIES capability can switch; for everyone else `canSwitch` is false and `view` is null (one
 * sidebar, as always). The choice is remembered per person in this browser; when storage is blocked
 * (a private window, blocked site data) it simply starts at DEFAULT_PORTAL_VIEW each time.
 */

import { useCallback, useState } from 'react';
import { hasAnyCapability } from '../auth/capabilities.js';
import {
  DEFAULT_PORTAL_VIEW,
  PORTAL_SWITCH_CAPABILITIES,
  PORTAL_VIEWS,
  PORTAL_VIEW_STORAGE_KEY_PREFIX,
} from '../constants/portal.js';

const KNOWN_VIEWS = Object.values(PORTAL_VIEWS);

function readStoredView(storageKey) {
  try {
    const storedView = window.localStorage.getItem(storageKey);
    return KNOWN_VIEWS.includes(storedView) ? storedView : DEFAULT_PORTAL_VIEW;
  } catch {
    return DEFAULT_PORTAL_VIEW;
  }
}

export function usePortalView(currentUser) {
  const canSwitch = hasAnyCapability(currentUser, PORTAL_SWITCH_CAPABILITIES);
  const storageKey = `${PORTAL_VIEW_STORAGE_KEY_PREFIX}${currentUser.id}`;
  const [chosenView, setChosenView] = useState(() => (canSwitch ? readStoredView(storageKey) : null));

  const setView = useCallback(
    (nextView) => {
      if (!KNOWN_VIEWS.includes(nextView)) return;
      setChosenView(nextView);
      try {
        window.localStorage.setItem(storageKey, nextView);
      } catch {
        // Not remembered in this browser; the view still changes for now.
      }
    },
    [storageKey],
  );

  return { canSwitch, view: canSwitch ? (chosenView ?? DEFAULT_PORTAL_VIEW) : null, setView };
}
