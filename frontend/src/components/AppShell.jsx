/**
 * Layout for every signed-in page: a sidebar with the pages this user's role can open, the
 * signed-in user's card with sign-out, and the page content to the right.
 *
 *   lg and up:  fixed dark sidebar (w-64) | scrollable content column
 *   below lg:   top bar with a menu button that opens the same sidebar as a drawer
 *
 * The content column is exactly one viewport tall and the <main> element scrolls, so full-height
 * pages (the chat and the console) can fill it with `h-full` while ordinary pages scroll inside it.
 *
 * Navigation items are filtered by role here for convenience only; every page is also behind a
 * route guard (RouteGuards.jsx) and every API call is authorised by the backend.
 *
 * Sign-out revokes the session on the server first. If that fails, the user stays signed in and
 * sees an error banner, because hiding the failure would leave a valid session on this device.
 */

import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { ApiError } from '../api/httpClient.js';
import { useAuth } from '../auth/AuthContext.jsx';
import BrandMark from './BrandMark.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import RoleBadge from './RoleBadge.jsx';
import { ChartIcon, ChatIcon, CloseIcon, CurrencyIcon, HomeIcon, InboxIcon, MapPinIcon, MenuIcon, SignOutIcon, SitemapIcon, TerminalIcon, UserCircleIcon, UsersIcon } from './Icons.jsx';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS, STAFF_ROLES, USER_ROLES } from '../constants/routes.js';

/** Sidebar entries, grouped into sections. `isVisibleTo(role)` decides who sees each one. */
const NAVIGATION_SECTIONS = Object.freeze([
  {
    sectionTitle: 'Workspace',
    items: [
      { label: 'Overview', path: ROUTE_PATHS.DASHBOARD, Icon: HomeIcon, isVisibleTo: () => true },
      { label: 'Support chat', path: ROUTE_PATHS.SUPPORT, Icon: ChatIcon, isVisibleTo: (role) => role === USER_ROLES.CUSTOMER },
      { label: 'Support console', path: ROUTE_PATHS.CONSOLE, Icon: InboxIcon, isVisibleTo: (role) => STAFF_ROLES.includes(role) },
    ],
  },
  {
    sectionTitle: 'People',
    items: [
      { label: 'Attendance', path: ROUTE_PATHS.ATTENDANCE, Icon: MapPinIcon, isVisibleTo: () => true },
      { label: 'Payroll', path: ROUTE_PATHS.PAYROLL, Icon: CurrencyIcon, isVisibleTo: () => true },
      { label: 'Analytics hub', path: ROUTE_PATHS.ANALYTICS, Icon: ChartIcon, isVisibleTo: () => true },
      { label: 'Organisation', path: ROUTE_PATHS.ORGANISATION, Icon: SitemapIcon, isVisibleTo: (role) => STAFF_ROLES.includes(role) },
    ],
  },
  {
    sectionTitle: 'Administration',
    items: [
      { label: 'Users & roles', path: ROUTE_PATHS.ADMIN_USERS, Icon: UsersIcon, isVisibleTo: (role) => role === USER_ROLES.ADMIN },
      { label: 'Agent telemetry', path: ROUTE_PATHS.AGENT_TELEMETRY, Icon: TerminalIcon, isVisibleTo: (role) => role === USER_ROLES.ADMIN },
    ],
  },
  {
    sectionTitle: 'Settings',
    items: [{ label: 'Account', path: ROUTE_PATHS.ACCOUNT, Icon: UserCircleIcon, isVisibleTo: () => true }],
  },
]);

/** "Ada Lovelace" -> "AL"; a single word gives one letter. */
function computeInitials(fullName) {
  const nameParts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  const initials = nameParts.length > 1 ? nameParts[0][0] + nameParts[nameParts.length - 1][0] : (nameParts[0]?.[0] ?? '?');
  return initials.toUpperCase();
}

function SidebarNavigation({ userRole, onNavigate }) {
  return (
    <nav aria-label="Main" className="flex-1 space-y-7 overflow-y-auto px-3 py-6 scroll-thin">
      {NAVIGATION_SECTIONS.map((navigationSection) => {
        const visibleItems = navigationSection.items.filter((navigationItem) => navigationItem.isVisibleTo(userRole));
        if (visibleItems.length === 0) return null;
        return (
          <div key={navigationSection.sectionTitle}>
            <p className="px-3 text-[0.68rem] font-semibold tracking-wider text-slate-500 uppercase">{navigationSection.sectionTitle}</p>
            <ul className="mt-2 space-y-1">
              {visibleItems.map(({ label, path, Icon }) => (
                <li key={path}>
                  <NavLink
                    to={path}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      [
                        'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                        'focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:outline-none',
                        isActive
                          ? 'bg-gradient-to-r from-indigo-500/20 to-violet-500/10 text-white ring-1 ring-indigo-400/30 ring-inset'
                          : 'text-slate-400 hover:bg-white/5 hover:text-white',
                      ].join(' ')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon className={`h-5 w-5 shrink-0 ${isActive ? 'text-indigo-300' : 'text-slate-500 group-hover:text-slate-300'}`} />
                        {label}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function UserCard({ currentUser, isSigningOut, onSignOut }) {
  return (
    <div className="border-t border-white/10 p-3">
      <div className="flex items-center gap-3 rounded-xl bg-white/5 p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 text-sm font-bold text-white" aria-hidden="true">
          {computeInitials(currentUser.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{currentUser.name}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <RoleBadge role={currentUser.role} tone="dark" />
          </div>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          disabled={isSigningOut}
          aria-busy={isSigningOut}
          aria-label={isSigningOut ? 'Signing out' : 'Sign out'}
          title="Sign out"
          className="rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
        >
          <SignOutIcon className="h-5 w-5" />
        </button>
      </div>
      <p className="mt-2 truncate px-1 text-xs text-slate-500" title={currentUser.email}>
        {currentUser.email}
      </p>
    </div>
  );
}

function SidebarContents({ currentUser, isSigningOut, onSignOut, onNavigate, closeButton = null }) {
  return (
    <div className="flex h-full flex-col bg-slate-950">
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-5">
        <BrandMark tone="light" />
        {closeButton}
      </div>
      <SidebarNavigation userRole={currentUser.role} onNavigate={onNavigate} />
      <UserCard currentUser={currentUser} isSigningOut={isSigningOut} onSignOut={onSignOut} />
    </div>
  );
}

export default function AppShell() {
  const { currentUser, signOut } = useAuth();
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(null);

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!isMobileNavOpen) return undefined;
    function handleKeyDown(keyboardEvent) {
      if (keyboardEvent.key === 'Escape') setIsMobileNavOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobileNavOpen]);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      // On success AuthContext switches to signed-out and ProtectedRoute redirects to /login.
      await signOut();
    } catch (signOutFailure) {
      setSignOutError({
        message: signOutFailure instanceof ApiError ? signOutFailure.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR,
        requestId: signOutFailure instanceof ApiError && signOutFailure.status >= 500 ? signOutFailure.requestId : null,
      });
      setIsSigningOut(false);
    }
  }

  const closeMobileNav = () => setIsMobileNavOpen(false);

  return (
    <div className="h-dvh bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <SidebarContents currentUser={currentUser} isSigningOut={isSigningOut} onSignOut={handleSignOut} />
      </aside>

      {/* Mobile drawer */}
      {isMobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" aria-label="Close navigation" onClick={closeMobileNav} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">
            <SidebarContents
              currentUser={currentUser}
              isSigningOut={isSigningOut}
              onSignOut={handleSignOut}
              onNavigate={closeMobileNav}
              closeButton={
                <button
                  type="button"
                  onClick={closeMobileNav}
                  aria-label="Close navigation"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:outline-none"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              }
            />
          </aside>
        </div>
      )}

      <div className="flex h-dvh flex-col lg:pl-64">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setIsMobileNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={isMobileNavOpen}
            className="-ml-1.5 rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
          >
            <MenuIcon className="h-6 w-6" />
          </button>
          <BrandMark />
          <span className="w-8" aria-hidden="true" />
        </header>

        {signOutError && (
          <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-8">
            <ErrorBanner title={BANNER_TITLES.SIGN_OUT_FAILED} message={signOutError.message} requestId={signOutError.requestId} onDismiss={() => setSignOutError(null)} />
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
