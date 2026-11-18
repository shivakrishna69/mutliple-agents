/**
 * Small coloured pill naming an access role (constants/routes.js ROLE_DISPLAY), used wherever a
 * person's role is shown: the sidebar's user card, the dashboard, Account, Users & roles and the
 * invitations list. An unknown role shows its stored value in neutral colours.
 */

import { ROLE_DISPLAY } from '../constants/routes.js';

export default function RoleBadge({ role }) {
  const roleDisplay = ROLE_DISPLAY[role];
  return (
    <span
      data-role={role}
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${roleDisplay?.badgeClassName ?? 'bg-slate-100 text-slate-700 ring-slate-500/20'}`}
    >
      {roleDisplay?.label ?? role}
    </span>
  );
}
