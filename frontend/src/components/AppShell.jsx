/**
 * Layout for every signed-in page, in the dashboard design: a dark sidebar with the pages this
 * user's role can open (grouped, the current one a blue pill) and the signed-in user's card with
 * sign-out; a top bar with where you are (company › page), the services' state for administrators
 * (hooks/useSystemHealth.js) and the user's initials; and the page content.
 *
 *   lg and up:  fixed dark sidebar (w-72) | top bar over a scrollable content column
 *   below lg:   top bar with a menu button that opens the same sidebar as a drawer
 *
 * The content column is exactly one viewport tall and the <main> element scrolls, so full-height
 * pages (the chat and the console) can fill it with `h-full` while ordinary pages scroll inside it.
 *
 * Each navigation item names the capability it needs (constants/capabilities.js), the same one its
 * route guard checks (App.jsx); the server says which capabilities the signed-in person has, so the
 * sidebar never compares role names. It only steers navigation: the backend authorises every call.
 *
 * People who manage the company (PORTAL_SWITCH_CAPABILITIES) choose a portal view (PortalSwitcher.jsx,
 * hooks/usePortalView.js): "Employee self-service" keeps their own pages, "Admin / Management" adds
 * the management tools. Each item names the views it belongs to; for everyone else the sidebar
 * ignores views. "My department's
 * knowledge base" is shown to people who head or lead a department (GET /api/knowledge-bases).
 *
 * Sign-out revokes the session on the server first. If that fails, the user stays signed in and
 * sees an error banner, because hiding the failure would leave a valid session on this device.
 */

import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../api/httpClient.js';
import { requestKnowledgeBases } from '../api/knowledgeApi.js';
import { requestMyBoards } from '../api/tasksApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { hasCapability } from '../auth/capabilities.js';
import BrandMark from './BrandMark.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import PortalSwitcher from './PortalSwitcher.jsx';
import RoleBadge from './RoleBadge.jsx';
import {
  BookOpenIcon,
  CheckBadgeIcon,
  BuildingIcon,
  CalendarIcon,
  ChartIcon,
  ChatIcon,
  CloseIcon,
  CurrencyIcon,
  HomeIcon,
  InboxIcon,
  MapPinIcon,
  MenuIcon,
  SignOutIcon,
  SitemapIcon,
  SparklesIcon,
  TerminalIcon,
  UserPlusIcon,
  UserCircleIcon,
  UsersIcon,
} from './Icons.jsx';
import { CAPABILITIES } from '../constants/capabilities.js';
import { SERVICE_STATE_TONES } from '../constants/dashboardDisplay.js';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';
import { KNOWLEDGE_ACCESS_BASIS } from '../constants/knowledge.js';
import { PORTAL_VIEWS } from '../constants/portal.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { usePortalView } from '../hooks/usePortalView.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';
import { useSystemHealth } from '../hooks/useSystemHealth.js';
import { initialsOf } from '../utils/dashboardFormat.js';

const BOTH_VIEWS = Object.freeze(Object.values(PORTAL_VIEWS));
const SELF_SERVICE_ONLY = Object.freeze([PORTAL_VIEWS.SELF_SERVICE]);
const MANAGEMENT_ONLY = Object.freeze([PORTAL_VIEWS.MANAGEMENT]);

/**
 * Sidebar entries, grouped into sections. `capability` is what a person needs to see one (null:
 * everyone); `isVisibleTo(context)`, when present, is a further condition (context:
 * { managesOwnKnowledgeBase, hasTaskBoard }); `views` the portal views it belongs to, for people who switch.
 */
const NAVIGATION_SECTIONS = Object.freeze([
  {
    sectionTitle: 'Workspace',
    items: [
      { label: 'Overview', path: ROUTE_PATHS.DASHBOARD, Icon: HomeIcon, views: BOTH_VIEWS, capability: null },
      {
        label: 'Support chat',
        path: ROUTE_PATHS.SUPPORT,
        Icon: ChatIcon,
        views: BOTH_VIEWS,
        capability: CAPABILITIES.USE_SUPPORT_CHAT,
      },
      {
        label: 'Support console',
        path: ROUTE_PATHS.CONSOLE,
        Icon: InboxIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.STAFF_SUPPORT,
      },
      {
        label: "My department's knowledge base",
        path: ROUTE_PATHS.MY_KNOWLEDGE,
        Icon: BookOpenIcon,
        views: SELF_SERVICE_ONLY,
        capability: null,
        isVisibleTo: (context) => context.managesOwnKnowledgeBase,
      },
      {
        label: 'Department Board',
        path: ROUTE_PATHS.BOARDS,
        Icon: CheckBadgeIcon,
        views: BOTH_VIEWS,
        capability: CAPABILITIES.USE_TASK_BOARDS,
        isVisibleTo: (context) => context.hasTaskBoard,
      },
      {
        label: 'Ask an agent',
        path: ROUTE_PATHS.ASK_AGENTS,
        Icon: SparklesIcon,
        views: BOTH_VIEWS,
        capability: CAPABILITIES.ASK_DEPARTMENT_AGENTS,
      },
    ],
  },
  {
    sectionTitle: 'People',
    items: [
      {
        label: 'Attendance',
        path: ROUTE_PATHS.ATTENDANCE,
        Icon: MapPinIcon,
        views: BOTH_VIEWS,
        capability: null,
      },
      { label: 'Leave', path: ROUTE_PATHS.LEAVE, Icon: CalendarIcon, views: BOTH_VIEWS, capability: null },
      { label: 'Payroll', path: ROUTE_PATHS.PAYROLL, Icon: CurrencyIcon, views: BOTH_VIEWS, capability: null },
      {
        label: 'Analytics hub',
        path: ROUTE_PATHS.ANALYTICS,
        Icon: ChartIcon,
        views: BOTH_VIEWS,
        capability: null,
      },
      {
        label: 'Organisation',
        path: ROUTE_PATHS.ORGANISATION,
        Icon: SitemapIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.STAFF_SUPPORT,
      },
      {
        label: 'Onboarding',
        path: ROUTE_PATHS.ONBOARDING,
        Icon: UserPlusIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_WORKFORCE,
      },
      {
        label: 'Workplace',
        path: ROUTE_PATHS.WORKPLACE,
        Icon: BuildingIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_WORKFORCE,
      },
    ],
  },
  {
    sectionTitle: 'Administration',
    items: [
      {
        label: 'Departments & Agents',
        path: ROUTE_PATHS.KNOWLEDGE_HUB,
        Icon: BookOpenIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_KNOWLEDGE_BASES,
      },
      {
        label: 'Company',
        path: ROUTE_PATHS.COMPANY,
        Icon: BuildingIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_COMPANY_SETTINGS,
      },
      {
        label: 'Users & roles',
        path: ROUTE_PATHS.ADMIN_USERS,
        Icon: UsersIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_USERS,
      },
      {
        label: 'Agent telemetry',
        path: ROUTE_PATHS.AGENT_TELEMETRY,
        Icon: TerminalIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.VIEW_AGENT_TELEMETRY,
      },
    ],
  },
  {
    sectionTitle: 'Settings',
    items: [{ label: 'Account', path: ROUTE_PATHS.ACCOUNT, Icon: UserCircleIcon, views: BOTH_VIEWS, capability: null }],
  },
]);

const ALL_NAVIGATION_ITEMS = NAVIGATION_SECTIONS.flatMap((section) => section.items);

/** True when this person sees `item`: they have its capability, and it belongs to their view (if they switch). */
const isItemVisible = (item, { user, view, context }) =>
  (item.capability === null || hasCapability(user, item.capability)) &&
  (item.isVisibleTo?.(context) ?? true) &&
  (view === null || item.views.includes(view));

/** The item for the page at `pathname` (the longest matching path). */
function itemOfPath(pathname) {
  return (
    ALL_NAVIGATION_ITEMS.filter((item) => pathname === item.path || pathname.startsWith(`${item.path}/`)).sort(
      (first, second) => second.path.length - first.path.length,
    )[0] ?? null
  );
}

/** The sidebar label of the page at `pathname`, for the top bar. */
const pageLabelOf = (pathname) => itemOfPath(pathname)?.label ?? null;

function SidebarNavigation({ visibility, onNavigate }) {
  return (
    <nav aria-label="Main" className="flex-1 space-y-7 overflow-y-auto px-4 py-6 scroll-thin">
      {NAVIGATION_SECTIONS.map((navigationSection) => {
        const visibleItems = navigationSection.items.filter((navigationItem) =>
          isItemVisible(navigationItem, visibility),
        );
        if (visibleItems.length === 0) return null;
        return (
          <div key={navigationSection.sectionTitle}>
            <p className="px-3 text-[0.7rem] font-semibold tracking-[0.12em] text-slate-400 uppercase">
              {navigationSection.sectionTitle}
            </p>
            <ul className="mt-2.5 space-y-1">
              {visibleItems.map(({ label, path, Icon }) => (
                <li key={path}>
                  <NavLink
                    to={path}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      [
                        'group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[15px] font-medium transition',
                        'focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none',
                        isActive
                          ? 'bg-brand-600 text-white shadow-lg shadow-brand-600/30'
                          : 'text-slate-300 hover:bg-white/[0.06] hover:text-white',
                      ].join(' ')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          className={`h-5 w-5 shrink-0 ${isActive ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}
                        />
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

function UserCard({ currentUser, companyName, isSigningOut, onSignOut }) {
  return (
    <div className="p-4">
      <div className="flex items-center gap-3 rounded-2xl bg-white/[0.06] p-3 ring-1 ring-white/[0.06]">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white"
          aria-hidden="true"
        >
          {initialsOf(currentUser.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-white">{currentUser.name}</p>
            <RoleBadge role={currentUser.role} tone="dark" />
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-400" title={currentUser.email}>
            {companyName ?? currentUser.email}
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          disabled={isSigningOut}
          aria-busy={isSigningOut}
          aria-label={isSigningOut ? 'Signing out' : 'Sign out'}
          title="Sign out"
          className="rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
        >
          <SignOutIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function SidebarContents({
  currentUser,
  companyName,
  visibility,
  isSigningOut,
  onSignOut,
  onNavigate,
  switcher = null,
  closeButton = null,
}) {
  return (
    <div className="flex h-full flex-col bg-[#23272e]">
      <div className="flex h-20 shrink-0 items-center justify-between border-b border-white/[0.06] px-6">
        <BrandMark tone="light" />
        {closeButton}
      </div>
      {switcher && <div className="shrink-0 px-4 pt-4">{switcher}</div>}
      <SidebarNavigation visibility={visibility} onNavigate={onNavigate} />
      <UserCard currentUser={currentUser} companyName={companyName} isSigningOut={isSigningOut} onSignOut={onSignOut} />
    </div>
  );
}

/** "Systems live" while every configured service is operational, otherwise the overall state. */
function SystemsPill({ health }) {
  if (!health) return null;
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
      <span className={`h-2 w-2 rounded-full ${SERVICE_STATE_TONES[health.overall].dotClassName}`} aria-hidden="true" />
      {health.overall === 'operational' ? 'Systems live' : `Systems: ${health.overallLabel}`}
    </span>
  );
}

function TopBar({ companyName, pageLabel, currentUser, health, switcher }) {
  return (
    <header className="hidden h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200/70 bg-white/80 px-8 backdrop-blur lg:flex">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-3 text-sm">
        {companyName && <span className="truncate text-slate-500">{companyName}</span>}
        {companyName && pageLabel && (
          <span className="text-slate-300" aria-hidden="true">
            ›
          </span>
        )}
        {pageLabel && (
          <span className="truncate font-semibold text-slate-900" aria-current="page">
            {pageLabel}
          </span>
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-3">
        {switcher}
        <SystemsPill health={health} />
        <NotificationCenter />
        <span
          className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white"
          title={currentUser.name}
          aria-hidden="true"
        >
          {initialsOf(currentUser.name)}
        </span>
      </div>
    </header>
  );
}

export default function AppShell() {
  const { currentUser, signOut } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { branding } = usePublicAuthSettings();
  const health = useSystemHealth(hasCapability(currentUser, CAPABILITIES.VIEW_SYSTEM_HEALTH));
  const companyName = branding?.name ?? null;
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(null);
  const { canSwitch, view, setView } = usePortalView(currentUser);
  // Whether this person heads or leads a department (for "My department's knowledge base"). A failed
  // load just leaves the entry out; the page itself is still reachable and reports its own errors.
  const knowledgeBases = useApiResource((signal) => requestKnowledgeBases(signal), [currentUser.id]);
  // Whether this person is on any department's task board (for "Department Board"); a failed load
  // just leaves the entry out.
  const taskBoards = useApiResource((signal) => requestMyBoards(signal), [currentUser.id], {
    enabled: hasCapability(currentUser, CAPABILITIES.USE_TASK_BOARDS),
  });
  const visibility = {
    user: currentUser,
    view,
    context: {
      hasTaskBoard: (taskBoards.data?.boards ?? []).length > 0,
      managesOwnKnowledgeBase: (knowledgeBases.data?.knowledgeBases ?? []).some(
        (knowledgeBase) => knowledgeBase.access.basis !== KNOWLEDGE_ACCESS_BASIS.ADMIN,
      ),
    },
  };

  /** Switches the view; a page that is not part of the new view gives way to the overview. */
  function changeView(nextView) {
    setView(nextView);
    const currentItem = itemOfPath(pathname);
    if (currentItem && !isItemVisible(currentItem, { ...visibility, view: nextView })) {
      navigate(ROUTE_PATHS.DASHBOARD);
    }
  }

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
    <div className="h-dvh bg-[#f5f7fb]">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 lg:block">
        <SidebarContents
          currentUser={currentUser}
          companyName={companyName}
          visibility={visibility}
          isSigningOut={isSigningOut}
          onSignOut={handleSignOut}
        />
      </aside>

      {/* Mobile drawer */}
      {isMobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            aria-label="Close navigation"
            onClick={closeMobileNav}
          />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">
            <SidebarContents
              currentUser={currentUser}
              companyName={companyName}
              visibility={visibility}
              isSigningOut={isSigningOut}
              onSignOut={handleSignOut}
              onNavigate={closeMobileNav}
              switcher={
                canSwitch && <PortalSwitcher view={view} onChange={changeView} tone="dark" className="w-full" />
              }
              closeButton={
                <button
                  type="button"
                  onClick={closeMobileNav}
                  aria-label="Close navigation"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              }
            />
          </aside>
        </div>
      )}

      <div className="flex h-dvh flex-col lg:pl-72">
        <TopBar
          companyName={companyName}
          pageLabel={pageLabelOf(pathname)}
          currentUser={currentUser}
          health={health.data}
          switcher={canSwitch && <PortalSwitcher view={view} onChange={changeView} />}
        />

        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setIsMobileNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={isMobileNavOpen}
            className="-ml-1.5 rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
          >
            <MenuIcon className="h-6 w-6" />
          </button>
          <BrandMark />
          <NotificationCenter />
        </header>

        {signOutError && (
          <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-8">
            <ErrorBanner
              title={BANNER_TITLES.SIGN_OUT_FAILED}
              message={signOutError.message}
              requestId={signOutError.requestId}
              onDismiss={() => setSignOutError(null)}
            />
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
