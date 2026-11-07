/**
 * The two portal views as a segmented control (hooks/usePortalView.js): "Employee self-service" and
 * "Admin / Management". Shown in the top bar, and at the top of the sidebar on small screens.
 * `tone`: 'light' on the white top bar, 'dark' in the sidebar.
 */

import { PORTAL_VIEWS, PORTAL_VIEW_DISPLAY } from '../constants/portal.js';
import { ShieldIcon, UserCircleIcon } from './Icons.jsx';

const VIEW_ICONS = Object.freeze({
  [PORTAL_VIEWS.SELF_SERVICE]: UserCircleIcon,
  [PORTAL_VIEWS.MANAGEMENT]: ShieldIcon,
});

const TONES = Object.freeze({
  light: {
    group: 'bg-slate-100 ring-slate-200',
    active: 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200',
    idle: 'text-slate-500 hover:text-slate-800',
  },
  dark: {
    group: 'bg-white/[0.06] ring-white/[0.08]',
    active: 'bg-brand-600 text-white shadow',
    idle: 'text-slate-300 hover:text-white',
  },
});

export default function PortalSwitcher({ view, onChange, tone = 'light', className = '' }) {
  const toneClasses = TONES[tone];
  return (
    <div
      role="group"
      aria-label="Portal view"
      className={`inline-flex items-center gap-1 rounded-xl p-1 ring-1 ${toneClasses.group} ${className}`}
    >
      {Object.values(PORTAL_VIEWS).map((portalView) => {
        const isActive = portalView === view;
        const Icon = VIEW_ICONS[portalView];
        return (
          <button
            key={portalView}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(portalView)}
            title={PORTAL_VIEW_DISPLAY[portalView].label}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${isActive ? toneClasses.active : toneClasses.idle}`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {PORTAL_VIEW_DISPLAY[portalView].label}
          </button>
        );
      })}
    </div>
  );
}
