/**
 * The portal switcher (components/PortalSwitcher.jsx): people who manage the company see either their
 * own workspace or the management tools, never both crowded into one sidebar. It only decides what
 * the sidebar shows; route guards and the backend still decide what anyone may open.
 */

import { USER_ROLES } from './routes.js';

export const PORTAL_VIEWS = Object.freeze({ SELF_SERVICE: 'self-service', MANAGEMENT: 'management' });

export const PORTAL_VIEW_DISPLAY = Object.freeze({
  [PORTAL_VIEWS.SELF_SERVICE]: { label: 'Employee self-service', shortLabel: 'Self-service' },
  [PORTAL_VIEWS.MANAGEMENT]: { label: 'Admin / Management', shortLabel: 'Management' },
});

/** Who can switch; everyone else always sees their one sidebar. */
export const PORTAL_SWITCH_ROLES = Object.freeze([USER_ROLES.ADMIN, USER_ROLES.HR]);

/** Where a person who can switch starts. */
export const DEFAULT_PORTAL_VIEW = PORTAL_VIEWS.MANAGEMENT;

/** The chosen view is remembered per person in this browser (a convenience only). */
export const PORTAL_VIEW_STORAGE_KEY_PREFIX = 'nsk.portal-view.';
