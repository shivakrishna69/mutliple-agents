/**
 * What the signed-out screens show that the server decides: the company's name, logo, support
 * address and terms links (GET /api/company/branding), the numbers it is configured with
 * (GET /api/auth/options) and the password checklist (GET /api/auth/password-policy).
 *
 * Loaded once per page load and shared by every screen (a module-level promise), so moving between
 * sign-in, signup and reset does not ask again. A failed load is forgotten, so the next screen
 * tries again. Each part is null until it arrives; screens render without it meanwhile.
 */

import { useEffect, useState } from 'react';
import { requestAuthOptions, requestPasswordPolicy } from '../api/authApi.js';
import { requestCompanyBranding } from '../api/companyApi.js';

let settingsPromise = null;

function loadPublicAuthSettings() {
  if (!settingsPromise) {
    settingsPromise = Promise.all([
      requestCompanyBranding().then((data) => data.branding),
      requestAuthOptions(),
      requestPasswordPolicy(),
    ]).then(
      ([branding, options, passwordPolicy]) => ({ branding, options, passwordPolicy, loadError: null }),
      (loadError) => {
        settingsPromise = null;
        return { branding: null, options: null, passwordPolicy: null, loadError };
      },
    );
  }
  return settingsPromise;
}

const EMPTY_SETTINGS = Object.freeze({ branding: null, options: null, passwordPolicy: null, loadError: null });

/** @returns {{ branding: object|null, options: object|null, passwordPolicy: object|null, loadError: Error|null }} */
export function usePublicAuthSettings() {
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  useEffect(() => {
    let isCurrent = true;
    loadPublicAuthSettings().then((loaded) => {
      if (isCurrent) setSettings(loaded);
    });
    return () => {
      isCurrent = false;
    };
  }, []);
  return settings;
}
