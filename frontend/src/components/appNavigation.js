/**
 * The app's pages as the person reaches them: the sidebar (AppShell.jsx) and the My Access launcher
 * (pages/MyAccess.jsx) both read this one list, so they always offer the same pages to the same person.
 *
 * Each item names:
 *   capability       what a person needs to see it (null: everyone signed in); the same capability
 *                    its route guard checks (App.jsx). The backend authorises every request anyway.
 *   anyCapabilities  alternatively, any one of these
 *   isVisibleTo      a further condition on the context ({ managesOwnKnowledgeBase, hasTaskBoard })
 *   views            the portal views it belongs to, for people who switch (PortalSwitcher.jsx)
 *   testId           a data-testid for its sidebar link, where tests rely on one
 *   tile             its My Access tile: { label?, tint, keywords? } (the tint is the medallion's
 *                    gradient; keywords are other words the launcher's search finds it by), or
 *                    absent when the page has no tile (My Access itself, Account)
 */

import { hasAnyCapability, hasCapability } from '../auth/capabilities.js';
import { CAPABILITIES } from '../constants/capabilities.js';
import { PORTAL_VIEWS } from '../constants/portal.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import {
  AppGridIcon,
  BookOpenIcon,
  BuildingIcon,
  CalendarIcon,
  ChartIcon,
  ChatIcon,
  CheckBadgeIcon,
  CogIcon,
  CurrencyIcon,
  DocumentIcon,
  HomeIcon,
  InboxIcon,
  MapPinIcon,
  SitemapIcon,
  SparklesIcon,
  TerminalIcon,
  UserCircleIcon,
  UserPlusIcon,
  UsersIcon,
} from './Icons.jsx';

const BOTH_VIEWS = Object.freeze(Object.values(PORTAL_VIEWS));
const SELF_SERVICE_ONLY = Object.freeze([PORTAL_VIEWS.SELF_SERVICE]);
const MANAGEMENT_ONLY = Object.freeze([PORTAL_VIEWS.MANAGEMENT]);
const WORKSPACE = CAPABILITIES.USE_EMPLOYEE_WORKSPACE;

export const NAVIGATION_SECTIONS = Object.freeze([
  {
    sectionTitle: 'Workspace',
    items: [
      { label: 'My Access', path: ROUTE_PATHS.MY_ACCESS, Icon: AppGridIcon, views: BOTH_VIEWS, capability: WORKSPACE },
      {
        label: 'Ask NSK',
        path: ROUTE_PATHS.ASK_NSK,
        Icon: SparklesIcon,
        views: BOTH_VIEWS,
        capability: CAPABILITIES.USE_NSK_ASSISTANT,
        testId: 'nsk-open-sidebar',
        tile: { tint: 'from-brand-500 via-indigo-600 to-violet-600', keywords: ['assistant', 'chat', 'ai', 'help'] },
      },
      {
        label: 'Overview',
        path: ROUTE_PATHS.DASHBOARD,
        Icon: HomeIcon,
        views: BOTH_VIEWS,
        capability: WORKSPACE,
        tile: { tint: 'from-brand-500 to-indigo-600', keywords: ['dashboard', 'home'] },
      },
      {
        label: 'Support chat',
        path: ROUTE_PATHS.SUPPORT,
        Icon: ChatIcon,
        views: BOTH_VIEWS,
        capability: CAPABILITIES.USE_SUPPORT_CHAT,
        tile: { label: 'Support Chat', tint: 'from-blue-500 to-indigo-700', keywords: ['help', 'ticket'] },
      },
      {
        label: 'Support console',
        path: ROUTE_PATHS.CONSOLE,
        Icon: InboxIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.STAFF_SUPPORT,
        tile: { label: 'Support Console', tint: 'from-cyan-500 to-sky-700', keywords: ['tickets', 'queue', 'chats'] },
      },
      {
        label: "My department's knowledge base",
        path: ROUTE_PATHS.MY_KNOWLEDGE,
        Icon: BookOpenIcon,
        views: SELF_SERVICE_ONLY,
        capability: null,
        isVisibleTo: (context) => context.managesOwnKnowledgeBase,
        tile: { label: 'Knowledge Base', tint: 'from-lime-500 to-emerald-600', keywords: ['documents', 'knowledge'] },
      },
      {
        label: 'Department Board',
        path: ROUTE_PATHS.BOARDS,
        Icon: CheckBadgeIcon,
        views: BOTH_VIEWS,
        capability: CAPABILITIES.USE_TASK_BOARDS,
        isVisibleTo: (context) => context.hasTaskBoard,
        tile: { tint: 'from-teal-400 to-teal-700', keywords: ['tasks', 'sprint', 'kanban'] },
      },
      {
        label: 'Ask an agent',
        path: ROUTE_PATHS.ASK_AGENTS,
        Icon: SparklesIcon,
        views: BOTH_VIEWS,
        capability: CAPABILITIES.ASK_DEPARTMENT_AGENTS,
        tile: { label: 'Ask an Agent', tint: 'from-fuchsia-500 to-purple-700', keywords: ['agents', 'questions'] },
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
        capability: WORKSPACE,
        tile: {
          tint: 'from-orange-400 to-rose-500',
          keywords: ['punch', 'check in', 'regularize', 'timesheet', 'corrections'],
        },
      },
      {
        label: 'Leave',
        path: ROUTE_PATHS.LEAVE,
        Icon: CalendarIcon,
        views: BOTH_VIEWS,
        capability: WORKSPACE,
        tile: { tint: 'from-sky-400 to-blue-600', keywords: ['time off', 'holiday', 'vacation', 'approvals'] },
      },
      {
        label: 'Payroll',
        path: ROUTE_PATHS.PAYROLL,
        Icon: CurrencyIcon,
        views: BOTH_VIEWS,
        capability: WORKSPACE,
        tile: {
          label: 'Payroll & Form 16',
          tint: 'from-indigo-400 to-indigo-700',
          keywords: ['payslip', 'salary', 'tax'],
        },
      },
      {
        label: 'Analytics hub',
        path: ROUTE_PATHS.ANALYTICS,
        Icon: ChartIcon,
        views: BOTH_VIEWS,
        capability: WORKSPACE,
        tile: {
          label: 'Analytics Hub',
          tint: 'from-violet-400 to-purple-700',
          keywords: ['reports', 'okr', 'vault', 'insights'],
        },
      },
      {
        label: 'Organisation',
        path: ROUTE_PATHS.ORGANISATION,
        Icon: SitemapIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.STAFF_SUPPORT,
        tile: { tint: 'from-purple-600 to-indigo-900', keywords: ['org chart', 'directory', 'hierarchy'] },
      },
      {
        label: 'Onboarding',
        path: ROUTE_PATHS.ONBOARDING,
        Icon: UserPlusIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_WORKFORCE,
        tile: { tint: 'from-amber-400 to-orange-600', keywords: ['offers', 'invite', 'new joiner', 'hiring'] },
      },
      {
        label: 'Workplace',
        path: ROUTE_PATHS.WORKPLACE,
        Icon: BuildingIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_WORKFORCE,
        tile: { tint: 'from-emerald-400 to-green-700', keywords: ['offices', 'departments', 'holidays', 'ctc'] },
      },
      {
        label: 'Offboarding',
        path: ROUTE_PATHS.OFFBOARDING,
        Icon: DocumentIcon,
        views: MANAGEMENT_ONLY,
        capability: null,
        anyCapabilities: [CAPABILITIES.VIEW_FINAL_SETTLEMENT, CAPABILITIES.VIEW_IT_OFFBOARDING],
        tile: { tint: 'from-red-500 to-rose-700', keywords: ['exit', 'resignation', 'settlement', 'relieving'] },
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
        tile: { tint: 'from-green-500 to-teal-700', keywords: ['knowledge base', 'agents'] },
      },
      {
        label: 'Company',
        path: ROUTE_PATHS.COMPANY,
        Icon: CogIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_COMPANY_SETTINGS,
        tile: {
          label: 'Company Settings',
          tint: 'from-slate-400 to-slate-600',
          keywords: ['settings', 'branding', 'email domain'],
        },
      },
      {
        label: 'Users & roles',
        path: ROUTE_PATHS.ADMIN_USERS,
        Icon: UsersIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_USERS,
        tile: {
          label: 'Users & Roles',
          tint: 'from-blue-500 to-blue-800',
          keywords: ['permissions', 'accounts', 'access'],
        },
      },
      {
        label: 'Agent telemetry',
        path: ROUTE_PATHS.AGENT_TELEMETRY,
        Icon: TerminalIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.VIEW_AGENT_TELEMETRY,
        tile: { label: 'Agent Telemetry', tint: 'from-slate-600 to-slate-900', keywords: ['logs', 'monitoring'] },
      },
    ],
  },
  {
    sectionTitle: 'Tax',
    items: [
      {
        label: 'Form 16 / CA Portal',
        path: ROUTE_PATHS.CA_PORTAL,
        Icon: DocumentIcon,
        views: MANAGEMENT_ONLY,
        capability: CAPABILITIES.MANAGE_FORM16,
        tile: { tint: 'from-indigo-500 to-violet-700', keywords: ['tax', 'ca', 'chartered accountant'] },
      },
    ],
  },
  {
    sectionTitle: 'Settings',
    items: [{ label: 'Account', path: ROUTE_PATHS.ACCOUNT, Icon: UserCircleIcon, views: BOTH_VIEWS, capability: null }],
  },
]);

const ALL_NAVIGATION_ITEMS = NAVIGATION_SECTIONS.flatMap((section) => section.items);

/**
 * True when this person sees `item`: they have its capability (or one of its `anyCapabilities`), it
 * suits the context, and it belongs to their view (if they switch).
 * @param {{ user: object, view: string|null, context: object }} visibility
 */
export const isItemVisible = (item, { user, view, context }) =>
  (item.capability === null || hasCapability(user, item.capability)) &&
  (!item.anyCapabilities || hasAnyCapability(user, item.anyCapabilities)) &&
  (item.isVisibleTo?.(context) ?? true) &&
  (view === null || item.views.includes(view));

/** The item for the page at `pathname` (the longest matching path), or null. */
export function itemOfPath(pathname) {
  return (
    ALL_NAVIGATION_ITEMS.filter((item) => pathname === item.path || pathname.startsWith(`${item.path}/`)).sort(
      (first, second) => second.path.length - first.path.length,
    )[0] ?? null
  );
}

/** The launcher tiles this person sees, in sidebar order: [{ label, path, Icon, tint, keywords }]. */
export const launcherTilesFor = (visibility) =>
  ALL_NAVIGATION_ITEMS.filter((item) => item.tile && isItemVisible(item, visibility)).map((item) => ({
    label: item.tile.label ?? item.label,
    path: item.path,
    Icon: item.Icon,
    tint: item.tile.tint,
    keywords: item.tile.keywords ?? [],
  }));
