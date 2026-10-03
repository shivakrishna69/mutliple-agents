/**
 * Users & roles (admins only): find accounts and change their role from the site.
 *
 *   - Search by name or email (debounced) and filter by role; tab counts are totals per role.
 *   - Changing a role is two steps: pick the new role in the row's menu, then confirm with Save
 *     (Cancel restores it). One change can be in flight at a time per row.
 *   - Your own row is read-only: the backend refuses self role changes (409) so an admin cannot
 *     lock the deployment out of administration by accident.
 *   - After a change, the affected user's open sessions lose their live connection and pick up
 *     the new permissions on their next request (backend disconnectUserSockets).
 *
 * The page is behind AdminRoute, and every request is authorised again by the backend.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { requestUpdateUserRole, requestUserList } from '../api/adminApi.js';
import { ApiError, HTTP_STATUS_UNAUTHORIZED } from '../api/httpClient.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { SearchIcon, ShieldIcon, UsersIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';
import { ROLE_DISPLAY, USER_ROLES } from '../constants/routes.js';

const SEARCH_DEBOUNCE_MS = 300;
/** Same limit as the backend (adminController MAX_SEARCH_LENGTH). */
const SEARCH_MAX_LENGTH = 100;
const ROLE_OPTIONS = Object.freeze([USER_ROLES.CUSTOMER, USER_ROLES.AGENT, USER_ROLES.HR, USER_ROLES.ADMIN]);
const ROLE_FILTER_TABS = Object.freeze([{ value: '', label: 'All' }, ...ROLE_OPTIONS.map((role) => ({ value: role, label: ROLE_DISPLAY[role].pluralLabel }))]);

const joinedDateFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function formatJoinedDate(isoTimestamp) {
  const parsedDate = isoTimestamp ? new Date(isoTimestamp) : null;
  return parsedDate && !Number.isNaN(parsedDate.getTime()) ? joinedDateFormatter.format(parsedDate) : '—';
}

function toDisplayableError(error) {
  return {
    message: error instanceof ApiError ? error.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR,
    requestId: error instanceof ApiError && error.status >= 500 ? error.requestId : null,
  };
}

function UserAvatar({ name }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-100 to-slate-200 text-sm font-semibold text-slate-700" aria-hidden="true">
      {(name ?? '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** Role cell: badge for your own row; otherwise a menu plus Save/Cancel once a different role is picked. */
function RoleEditor({ userSummary, isCurrentUser, isSaving, onSaveRole }) {
  const [selectedRole, setSelectedRole] = useState(userSummary.role);
  const hasPendingChange = selectedRole !== userSummary.role;

  // The saved role can change underneath (a successful save, or a reload); follow it.
  const [lastSavedRole, setLastSavedRole] = useState(userSummary.role);
  if (lastSavedRole !== userSummary.role) {
    setLastSavedRole(userSummary.role);
    setSelectedRole(userSummary.role);
  }

  if (isCurrentUser) {
    return (
      <div className="flex items-center gap-2">
        <RoleBadge role={userSummary.role} />
        <span className="text-xs text-slate-400">Your own role can’t be changed here</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`role-${userSummary.id}`}>
        Role for {userSummary.name}
      </label>
      <select
        id={`role-${userSummary.id}`}
        value={selectedRole}
        disabled={isSaving}
        onChange={(changeEvent) => setSelectedRole(changeEvent.target.value)}
        className="rounded-lg border border-slate-200 bg-white py-1.5 pr-8 pl-3 text-sm text-slate-800 shadow-sm transition hover:border-slate-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 focus:outline-none disabled:opacity-60"
      >
        {ROLE_OPTIONS.map((roleOption) => (
          <option key={roleOption} value={roleOption}>
            {ROLE_DISPLAY[roleOption].label}
          </option>
        ))}
      </select>
      {hasPendingChange && (
        <>
          <button
            type="button"
            disabled={isSaving}
            aria-busy={isSaving}
            onClick={() => onSaveRole(userSummary, selectedRole)}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:ring-4 focus-visible:ring-indigo-200 focus-visible:outline-none disabled:opacity-60"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => setSelectedRole(userSummary.role)}
            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none disabled:opacity-60"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

export default function AdminUsers() {
  const { currentUser, csrfToken, markSessionEnded } = useAuth();

  const [searchText, setSearchText] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [users, setUsers] = useState([]);
  const [countsByRole, setCountsByRole] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [savingUserId, setSavingUserId] = useState(null);
  const savingUserIdRef = useRef(null);

  const handleRequestError = useCallback(
    (error, bannerTitle) => {
      if (error instanceof ApiError && error.status === HTTP_STATUS_UNAUTHORIZED) {
        markSessionEnded();
        return;
      }
      setPageError({ title: bannerTitle, ...toDisplayableError(error) });
    },
    [markSessionEnded],
  );

  // Apply the search after the user pauses typing.
  useEffect(() => {
    const debounceTimer = setTimeout(() => setAppliedSearch(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(debounceTimer);
  }, [searchText]);

  useEffect(() => {
    const loadController = new AbortController();
    setIsLoading(true);
    requestUserList({ search: appliedSearch, role: roleFilter }, { signal: loadController.signal })
      .then((userListResult) => {
        setUsers(userListResult.users);
        setCountsByRole(userListResult.countsByRole);
        setPageError(null);
      })
      .catch((error) => {
        if (!loadController.signal.aborted) handleRequestError(error, BANNER_TITLES.USERS_LOAD_FAILED);
      })
      .finally(() => {
        if (!loadController.signal.aborted) setIsLoading(false);
      });
    return () => loadController.abort();
  }, [appliedSearch, roleFilter, handleRequestError]);

  async function saveRole(userSummary, newRole) {
    if (savingUserIdRef.current) return;
    savingUserIdRef.current = userSummary.id;
    setSavingUserId(userSummary.id);
    setSuccessMessage(null);
    setPageError(null);
    try {
      const updatedUser = await requestUpdateUserRole(userSummary.id, newRole, csrfToken);
      setUsers((previousUsers) =>
        previousUsers
          .map((listedUser) => (listedUser.id === updatedUser.id ? { ...listedUser, role: updatedUser.role } : listedUser))
          // Under a role filter, a user who no longer matches leaves the list.
          .filter((listedUser) => !roleFilter || listedUser.role === roleFilter),
      );
      setCountsByRole((previousCounts) =>
        previousCounts && userSummary.role !== updatedUser.role
          ? { ...previousCounts, [userSummary.role]: previousCounts[userSummary.role] - 1, [updatedUser.role]: (previousCounts[updatedUser.role] ?? 0) + 1 }
          : previousCounts,
      );
      setSuccessMessage(`${updatedUser.name} is now ${ROLE_DISPLAY[updatedUser.role].assignmentPhrase}.`);
    } catch (error) {
      handleRequestError(error, BANNER_TITLES.ROLE_CHANGE_FAILED);
    } finally {
      savingUserIdRef.current = null;
      setSavingUserId(null);
    }
  }

  const totalUsers = countsByRole ? Object.values(countsByRole).reduce((runningTotal, roleCount) => runningTotal + roleCount, 0) : null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8 lg:py-10">
      <PageHeader title="Users & roles" description="Give teammates access to the support console or HR tools, or make them administrators." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ROLE_OPTIONS.slice()
          .reverse()
          .map((role) => (
            <div key={role} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <RoleBadge role={role} />
                <span className="text-2xl font-bold tracking-tight text-slate-900">{countsByRole ? countsByRole[role] ?? 0 : '—'}</span>
              </div>
              <p className="mt-3 text-sm text-slate-500">{ROLE_DISPLAY[role].description}</p>
            </div>
          ))}
      </div>

      {pageError && <ErrorBanner title={pageError.title} message={pageError.message} requestId={pageError.requestId} onDismiss={() => setPageError(null)} />}
      {successMessage && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-600/20 ring-inset">
          <ShieldIcon className="h-4 w-4 shrink-0" />
          {successMessage} Their open sessions pick up the change immediately.
        </p>
      )}

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-slate-100 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div role="tablist" aria-label="Filter by role" className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
            {ROLE_FILTER_TABS.map((filterTab) => {
              const isSelected = roleFilter === filterTab.value;
              const tabCount = filterTab.value ? countsByRole?.[filterTab.value] : totalUsers;
              return (
                <button
                  key={filterTab.value || 'all'}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => setRoleFilter(filterTab.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
                    isSelected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {filterTab.label}
                  {typeof tabCount === 'number' && <span className={`ml-1.5 text-xs ${isSelected ? 'text-indigo-600' : 'text-slate-400'}`}>{tabCount}</span>}
                </button>
              );
            })}
          </div>
          <div className="relative lg:w-80">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <label htmlFor="user-search" className="sr-only">
              Search users by name or email
            </label>
            <input
              id="user-search"
              type="search"
              value={searchText}
              maxLength={SEARCH_MAX_LENGTH}
              onChange={(changeEvent) => setSearchText(changeEvent.target.value)}
              placeholder="Search name or email"
              className="block w-full rounded-xl border border-slate-200 bg-white py-2 pr-3 pl-9 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 focus:outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50/80 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              <tr>
                <th scope="col" className="px-5 py-3">User</th>
                <th scope="col" className="px-5 py-3">Role</th>
                <th scope="col" className="hidden px-5 py-3 md:table-cell">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100" aria-busy={isLoading}>
              {isLoading && users.length === 0 ? (
                Array.from({ length: 4 }, (_, rowIndex) => (
                  <tr key={rowIndex}>
                    <td className="px-5 py-4" colSpan={3}>
                      <span className="block h-4 w-1/2 animate-pulse rounded bg-slate-100" />
                    </td>
                  </tr>
                ))
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-14 text-center">
                    <UsersIcon className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-2 text-sm text-slate-500">No users match these filters.</p>
                  </td>
                </tr>
              ) : (
                users.map((userSummary) => {
                  const isCurrentUser = userSummary.id === currentUser.id;
                  return (
                    <tr key={userSummary.id} className={`transition ${isLoading ? 'opacity-60' : ''} hover:bg-slate-50/60`}>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <UserAvatar name={userSummary.name} />
                          <div className="min-w-0">
                            <p className="flex items-center gap-2 truncate font-semibold text-slate-900">
                              {userSummary.name}
                              {isCurrentUser && <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[0.65rem] font-semibold text-indigo-700">You</span>}
                            </p>
                            <p className="truncate text-slate-500">{userSummary.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <RoleEditor userSummary={userSummary} isCurrentUser={isCurrentUser} isSaving={savingUserId === userSummary.id} onSaveRole={saveRole} />
                      </td>
                      <td className="hidden px-5 py-4 whitespace-nowrap text-slate-500 md:table-cell">{formatJoinedDate(userSummary.createdAt)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {users.length >= 200 && <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">Showing the 200 newest matches. Refine the search to find others.</p>}
      </section>
    </div>
  );
}
