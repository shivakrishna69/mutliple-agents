/** Small coloured pill naming a user's role (admin, agent, customer). */

import { ROLE_DISPLAY } from '../constants/routes.js';

export default function RoleBadge({ role, tone = 'light' }) {
  const roleDisplay = ROLE_DISPLAY[role];
  if (tone === 'dark') {
    return (
      <span className="inline-flex items-center rounded-md bg-white/10 px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-indigo-100 uppercase ring-1 ring-white/15 ring-inset">
        {roleDisplay?.label ?? role}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${roleDisplay?.badgeClassName ?? 'bg-slate-100 text-slate-700 ring-slate-500/20'}`}>
      {roleDisplay?.label ?? role}
    </span>
  );
}
