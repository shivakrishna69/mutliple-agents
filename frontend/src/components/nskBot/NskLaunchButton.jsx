/**
 * Opens the NSK drawer: in the top bar (labelled), in the sidebar (a navigation-style entry) and in the
 * mobile header (an icon). Renders nothing for people without use_nsk_assistant (no drawer provider).
 */

import { NSK_LABELS } from '../../constants/nskBot.js';
import { SparklesIcon } from '../Icons.jsx';
import { useNskDrawer } from './nskDrawerState.js';

const VARIANT_CLASSES = Object.freeze({
  topbar:
    'flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-600 to-brand-700 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:from-brand-500 hover:to-brand-600',
  sidebar:
    'flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[15px] font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white',
  icon: 'rounded-lg p-1.5 text-brand-600 hover:bg-brand-50',
});

/** @param {{ variant: 'topbar'|'sidebar'|'icon', onOpened?: () => void }} props */
export default function NskLaunchButton({ variant, onOpened }) {
  const { isAvailable, isOpen, open } = useNskDrawer();
  if (!isAvailable) return null;
  return (
    <button
      type="button"
      aria-label={variant === 'icon' ? NSK_LABELS.OPEN : undefined}
      aria-expanded={isOpen}
      data-testid={`nsk-open-${variant}`}
      onClick={() => {
        open();
        onOpened?.();
      }}
      className={`${VARIANT_CLASSES[variant]} focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none`}
    >
      <SparklesIcon className={variant === 'icon' ? 'h-6 w-6' : 'h-5 w-5 shrink-0'} />
      {variant !== 'icon' && NSK_LABELS.OPEN}
    </button>
  );
}
