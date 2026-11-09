/**
 * The portal switcher (components/PortalSwitcher.jsx): people who manage the company see either their
 * own workspace or the management tools, never both crowded into one sidebar. It only decides what
 * the sidebar shows; route guards and the backend still decide what anyone may open.
 */

import { CAPABILITIES } from './capabilities.js';

export const PORTAL_VIEWS = Object.freeze({ SELF_SERVICE: 'self-service', MANAGEMENT: 'management' });

export const PORTAL_VIEW_DISPLAY = Object.freeze({
  [PORTAL_VIEWS.SELF_SERVICE]: { label: 'Employee self-service', shortLabel: 'Self-service' },
  [PORTAL_VIEWS.MANAGEMENT]: { label: 'Admin / Management', shortLabel: 'Management' },
});

/**
 * Who can switch: people with any of these management capabilities (admins, HR, IT administrators).
 * Everyone else always sees their one sidebar.
 */
export const PORTAL_SWITCH_CAPABILITIES = Object.freeze([
  CAPABILITIES.MANAGE_WORKFORCE,
  CAPABILITIES.MANAGE_USERS,
  CAPABILITIES.MANAGE_COMPANY_SETTINGS,
]);

/** Where a person who can switch starts. */
export const DEFAULT_PORTAL_VIEW = PORTAL_VIEWS.MANAGEMENT;

/** The chosen view is remembered per person in this browser (a convenience only). */
export const PORTAL_VIEW_STORAGE_KEY_PREFIX = 'nsk.portal-view.';
