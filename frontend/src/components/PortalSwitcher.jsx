/**
 * The two portal views as a segmented control (hooks/usePortalView.js): "Employee self-service" and
 * "Admin / Management". Shown in the top bar, and at the top of the sidebar on small screens.
 * Frosted glass in the top bar and in the mobile sidebar.
 */

import { PORTAL_VIEWS, PORTAL_VIEW_DISPLAY } from '../constants/portal.js';
import { ShieldIcon, UserCircleIcon } from './Icons.jsx';

const VIEW_ICONS = Object.freeze({
  [PORTAL_VIEWS.SELF_SERVICE]: UserCircleIcon,
  [PORTAL_VIEWS.MANAGEMENT]: ShieldIcon,
});

const SEGMENT_CLASSES = Object.freeze({
  active: 'bg-white/90 text-slate-900 shadow-sm ring-1 ring-slate-900/[0.06]',
  idle: 'text-slate-600 hover:bg-white/50 hover:text-slate-900',
});

export default function PortalSwitcher({ view, onChange, className = '' }) {
  return (
    <div
      role="group"
      aria-label="Portal view"
      className={`inline-flex items-center gap-1 rounded-xl bg-slate-900/[0.04] p-1 shadow-[inset_0_1px_2px_rgb(15_23_42/0.06)] ring-1 ring-slate-900/[0.06] backdrop-blur ${className}`}
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
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${isActive ? SEGMENT_CLASSES.active : SEGMENT_CLASSES.idle}`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {PORTAL_VIEW_DISPLAY[portalView].label}
          </button>
        );
      })}
    </div>
  );
}
