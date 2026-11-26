/**
 * My Access (/my-access): where everyone with an employee workspace starts after signing in. The app
 * shell hides the sidebar here, so the launcher fills the page: a frosted panel with the "My Access"
 * heading, the person's latest unread notification as an announcement pill, and one tile per page
 * they may open (components/appNavigation.js, the same list and rules as the sidebar). Opening a tile
 * goes to that page, where the sidebar is back; the launcher button in the top bar returns here.
 *
 * The shell passes what decides visibility (role, portal view, board and knowledge base membership)
 * and the notifications through the outlet context, so nothing is fetched twice.
 *
 *   search   a box in the heading row filters the tiles as the person types (label, keywords or
 *            address, any case); × clears it; a short note when nothing matches
 *   briefing the briefing bar above the tiles (components/insights/BriefingBar.jsx): the headline,
 *            the most pressing item with its action, and Open briefing
 *   badges   pending counts on the tiles that have one (Leave, Attendance, Support Console, Form 16 /
 *            CA Portal), from the daily briefing's exact queues (utils/launcherBadges.js), so they
 *            update live and cost no requests of their own; a badge shows only above 0
 *   hover    the tile lifts and its medallion zooms (transform only, so it stays smooth)
 */

import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { launcherTilesFor } from '../components/appNavigation.js';
import { freshNavigationState } from '../components/NotificationCenter.jsx';
import { BellIcon, CloseIcon, SearchIcon } from '../components/Icons.jsx';
import BriefingBar from '../components/insights/BriefingBar.jsx';
import { useInsights } from '../components/insights/InsightsContext.jsx';
import { LAUNCHER_BADGE_LABEL, LAUNCHER_SEARCH } from '../constants/launcher.js';
import { badgeText, badgesFromQueues, filterTiles } from '../utils/launcherBadges.js';

const DISMISSED_KEY = 'nsk.myAccess.dismissedNotification';

function readDismissedId() {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function rememberDismissedId(notificationId) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, notificationId);
  } catch {
    // Not remembered in this browser; it is hidden for this visit.
  }
}

/** The newest unread notification, as a pill that opens it or can be dismissed; nothing when none. */
function AnnouncementPill({ notificationState }) {
  const navigate = useNavigate();
  const [dismissedId, setDismissedId] = useState(readDismissedId);
  const latestUnread = (notificationState?.notifications ?? []).find((notification) => !notification.readAt);
  if (!latestUnread || latestUnread.id === dismissedId) return null;

  function open() {
    notificationState.markRead(latestUnread.id);
    if (latestUnread.link) navigate(latestUnread.link, { state: freshNavigationState() });
  }

  function dismiss() {
    rememberDismissedId(latestUnread.id);
    setDismissedId(latestUnread.id);
  }

  return (
    <div
      className="flex max-w-full items-center gap-2 rounded-full bg-white/70 py-1.5 pr-1.5 pl-3 text-sm shadow-[inset_0_1px_1px_rgb(255_255_255/0.9)] ring-1 ring-slate-900/[0.06] backdrop-blur"
      data-testid="my-access-announcement"
    >
      <BellIcon className="h-4 w-4 shrink-0 text-brand-700" />
      <button
        type="button"
        onClick={open}
        className="min-w-0 truncate text-left text-slate-700 hover:text-slate-900 focus-visible:underline focus-visible:outline-none"
        title={latestUnread.body}
      >
        <span className="font-semibold text-slate-900">{latestUnread.title}</span>
        {latestUnread.body && <span className="ml-1.5 text-slate-600">{latestUnread.body}</span>}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="shrink-0 rounded-full p-1 text-slate-500 hover:bg-slate-900/[0.06] hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The search box in the heading row: compact, so the grid still fits one screen. */
function ModuleSearch({ value, onChange }) {
  return (
    <div className="relative w-full sm:w-64">
      <label htmlFor="my-access-search" className="sr-only">
        {LAUNCHER_SEARCH.LABEL}
      </label>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 z-10 h-4 w-4 -translate-y-1/2 text-slate-600" />
      <input
        id="my-access-search"
        type="search"
        value={value}
        maxLength={LAUNCHER_SEARCH.MAX_LENGTH}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Escape') onChange('');
        }}
        placeholder={LAUNCHER_SEARCH.PLACEHOLDER}
        autoComplete="off"
        className="h-9 w-full rounded-full border-0 bg-white/70 py-1.5 pr-9 pl-9 text-sm text-slate-900 shadow-[inset_0_1px_1px_rgb(255_255_255/0.9)] ring-1 ring-slate-900/[0.08] backdrop-blur transition placeholder:text-slate-500 focus:bg-white/90 focus:ring-2 focus:ring-brand-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={LAUNCHER_SEARCH.CLEAR}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-slate-500 hover:bg-slate-900/[0.06] hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function LauncherTile({ tile, badge }) {
  const { label, path, Icon, tint } = tile;
  return (
    <li>
      <Link
        to={path}
        className="group flex w-28 flex-col items-center gap-2 rounded-2xl text-center focus-visible:outline-none"
        data-testid="my-access-tile"
      >
        <span className="glass-card relative flex h-24 w-24 items-center justify-center transition-[transform,box-shadow,border-color] duration-200 ease-out will-change-transform group-hover:-translate-y-1 group-hover:border-white group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-brand-500 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
          <span
            className={`flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br text-white shadow-[inset_0_1px_1px_rgb(255_255_255/0.45),0_8px_18px_-8px_rgb(15_23_42/0.45)] ring-[3px] ring-white/40 transition-transform duration-200 ease-out will-change-transform group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100 ${tint}`}
          >
            <Icon className="h-8 w-8" />
          </span>
          {badge && (
            <span
              className="absolute -top-1.5 -right-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-600 px-1.5 text-[11px] font-semibold text-white shadow-sm ring-2 ring-white"
              data-testid="my-access-badge"
              aria-hidden="true"
            >
              {badge}
            </span>
          )}
        </span>
        <span className="text-[13px] leading-tight font-medium text-slate-800 group-hover:text-slate-950">
          {label}
          {badge && <span className="sr-only">{`, ${badge} ${LAUNCHER_BADGE_LABEL}`}</span>}
        </span>
      </Link>
    </li>
  );
}

export default function MyAccess() {
  const { visibility, notificationState } = useOutletContext();
  const tiles = launcherTilesFor(visibility);
  const [query, setQuery] = useState('');
  const badges = badgesFromQueues(useInsights()?.briefing?.queues);
  const shownTiles = filterTiles(tiles, query);
  return (
    <div className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-10">
      <section className="glass-card px-5 py-5 sm:px-8 sm:py-6" aria-labelledby="my-access-heading">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 id="my-access-heading" className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            My Access
          </h1>
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
            <AnnouncementPill notificationState={notificationState} />
            <ModuleSearch value={query} onChange={setQuery} />
          </div>
        </div>
        <BriefingBar className="mt-4" />
        {shownTiles.length === 0 ? (
          <p className="mt-5 py-8 text-center text-sm text-slate-500" role="status" data-testid="my-access-no-match">
            {LAUNCHER_SEARCH.NO_MATCH} “{query.trim()}”
          </p>
        ) : (
          <ul className="mt-5 grid grid-cols-2 justify-items-center gap-x-6 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
            {shownTiles.map((tile) => (
              <LauncherTile key={tile.path} tile={tile} badge={badgeText(badges[tile.path])} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
