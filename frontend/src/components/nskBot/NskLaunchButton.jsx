/**
 * Opens Ask NSK (/ask-nsk, pages/AskNsk.jsx): labelled in the top bar, an icon in the mobile header.
 * The sidebar entry and the My Access tile come from components/appNavigation.js. Renders nothing
 * for people without use_nsk_assistant.
 */

import { Link, useLocation } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { hasCapability } from '../../auth/capabilities.js';
import { CAPABILITIES } from '../../constants/capabilities.js';
import { NSK_LABELS } from '../../constants/nskBot.js';
import { ROUTE_PATHS } from '../../constants/routes.js';
import { SparklesIcon } from '../Icons.jsx';

const VARIANT_CLASSES = Object.freeze({
  topbar:
    'flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-600 via-indigo-600 to-violet-600 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 ring-1 ring-white/25 transition hover:shadow-indigo-500/45 hover:brightness-110',
  icon: 'rounded-lg p-1.5 text-brand-600 hover:bg-brand-50',
});

/** @param {{ variant: 'topbar'|'icon' }} props */
export default function NskLaunchButton({ variant }) {
  const { currentUser } = useAuth();
  const { pathname } = useLocation();
  if (!hasCapability(currentUser, CAPABILITIES.USE_NSK_ASSISTANT)) return null;
  return (
    <Link
      to={ROUTE_PATHS.ASK_NSK}
      aria-label={variant === 'icon' ? NSK_LABELS.OPEN : undefined}
      aria-current={pathname === ROUTE_PATHS.ASK_NSK ? 'page' : undefined}
      data-testid={`nsk-open-${variant}`}
      className={`${VARIANT_CLASSES[variant]} focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none`}
    >
      <SparklesIcon className={variant === 'icon' ? 'h-6 w-6' : 'h-5 w-5 shrink-0'} />
      {variant !== 'icon' && NSK_LABELS.OPEN}
    </Link>
  );
}
