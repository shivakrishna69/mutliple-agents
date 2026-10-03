/**
 * Org hierarchy graph engine: loads the reporting graph and turns it into nested trees.
 *
 * Data path
 * ---------
 *   1. Snapshot (cached): one aggregation reads every current employee as a flat row
 *        { id, managerId, name, designation }
 *      joining User for the display name. "Current" means still employed: Probation, Active or
 *      Notice. Terminated profiles are excluded. The snapshot is cached in Redis (see
 *      services/orgHierarchyCache.js for the invalidation scheme), so a page load normally costs
 *      two Redis GETs and no MongoDB query.
 *   2. Index: the rows are indexed in memory as `nodeById` and `childIdsByManagerId`, which is
 *      the adjacency list of the graph (manager -> reports).
 *   3. Trees: breadth-first walks over the adjacency list build the nested
 *        { id, name, designation, avatar, children: [...] }
 *      nodes, either for the whole organisation (a forest) or for one manager's subtree.
 *
 * Why one flat scan instead of a recursive $graphLookup
 * ------------------------------------------------------
 *   The full org chart needs every current employee anyway. A single scan returns each one once,
 *   in O(n); linking them in memory is another O(n). $graphLookup would re-traverse the graph per
 *   starting document, is capped at 100 MB of memory per stage, and still returns flat arrays that
 *   must be nested in application code. The manager endpoint reuses the same cached snapshot, so
 *   it costs no database query at all on a cache hit.
 *
 * Robustness
 * ----------
 *   - Every walk is iterative (explicit queue), so a deep chain cannot overflow the call stack.
 *   - Every walk keeps a visited set, so it terminates even if the data contains a loop (the
 *     models prevent loops on save, but a manual database edit could still create one). Each loop
 *     is broken at one member, deterministically, and counted in `stats.cycleBreakCount`.
 *   - An employee whose manager is not a current employee (e.g. the manager was terminated and
 *     their reports not yet reassigned) becomes a root, counted in `stats.orphanedCount`, so they
 *     never silently disappear from the chart.
 *   - Concurrent cache misses share one database query (single-flight), so an expired cache
 *     under load triggers one rebuild per backend instance, not one per request.
 */

import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import User from '../models/User.js';
import { getCachedJson, setCachedJson } from './cacheStore.js';
import { ORG_HIERARCHY_CACHE_SETTINGS, hierarchySnapshotKey, readHierarchyGeneration } from './orgHierarchyCache.js';
import { logger } from '../utils/logger.js';

/** Employment statuses that appear on the org chart. */
export const CURRENT_EMPLOYMENT_STATUSES = Object.freeze([EMPLOYMENT_STATUSES.PROBATION, EMPLOYMENT_STATUSES.ACTIVE, EMPLOYMENT_STATUSES.NOTICE]);

export const CACHE_STATUS = Object.freeze({ HIT: 'hit', MISS: 'miss' });

/** Rebuilds in progress, keyed by cache generation (or "uncached"), shared by concurrent misses. */
const inFlightSnapshotBuilds = new Map();

// =================================================================================================
// 1. Snapshot: load from cache or MongoDB
// =================================================================================================

/**
 * Reads every current employee as a flat row. Uses one aggregation:
 *   $match   current employees only
 *   $lookup  the User document for the display name (by _id, served by the _id index)
 *   $project only what the tree needs, with ids as strings so the snapshot is plain JSON
 */
function queryHierarchyRows() {
  return EmployeeProfile.aggregate([
    { $match: { 'organizationData.employmentStatus': { $in: CURRENT_EMPLOYMENT_STATUSES } } },
    {
      $lookup: {
        from: User.collection.collectionName,
        localField: 'userId',
        foreignField: '_id',
        pipeline: [{ $project: { _id: 0, name: 1 } }],
        as: 'account',
      },
    },
    {
      $project: {
        _id: 0,
        id: { $toString: '$_id' },
        managerId: { $toString: '$organizationData.reportingManagerId' },
        name: { $ifNull: [{ $first: '$account.name' }, null] },
        designation: '$organizationData.designation',
      },
    },
  ]);
}

/** True when a cached value has the snapshot shape this release writes. */
function isUsableSnapshot(cachedValue) {
  return typeof cachedValue?.generatedAt === 'string' && Array.isArray(cachedValue.nodes);
}

/**
 * Returns `{ snapshot: { generatedAt, nodes }, cacheStatus }`.
 * Cache hit: two Redis reads. Cache miss: one aggregation, then the result is stored under the
 * generation read *before* the query (see orgHierarchyCache.js for why). If the cache is down,
 * the snapshot is built from MongoDB on every call and nothing is stored.
 */
export async function loadHierarchySnapshot() {
  const generation = await readHierarchyGeneration();

  if (generation !== null) {
    const cachedSnapshot = await getCachedJson(hierarchySnapshotKey(generation));
    if (isUsableSnapshot(cachedSnapshot)) {
      return { snapshot: cachedSnapshot, cacheStatus: CACHE_STATUS.HIT };
    }
  }

  const flightKey = generation === null ? 'uncached' : `g${generation}`;
  let snapshotBuild = inFlightSnapshotBuilds.get(flightKey);
  if (!snapshotBuild) {
    snapshotBuild = (async () => {
      const buildStartedAt = performance.now();
      const nodes = await queryHierarchyRows();
      const snapshot = { generatedAt: new Date().toISOString(), nodes };
      if (generation !== null) {
        await setCachedJson(hierarchySnapshotKey(generation), snapshot, ORG_HIERARCHY_CACHE_SETTINGS.SNAPSHOT_TTL_SECONDS);
      }
      logger.info('Org hierarchy snapshot built', {
        employeeCount: nodes.length,
        generation,
        durationMs: Math.round(performance.now() - buildStartedAt),
      });
      return snapshot;
    })().finally(() => inFlightSnapshotBuilds.delete(flightKey));
    inFlightSnapshotBuilds.set(flightKey, snapshotBuild);
  }

  return { snapshot: await snapshotBuild, cacheStatus: CACHE_STATUS.MISS };
}

// =================================================================================================
// 2. Index: adjacency list
// =================================================================================================

/** Sort order for siblings: by name (case-insensitive), then id, so output is deterministic. */
const nameCollator = new Intl.Collator('en', { sensitivity: 'base' });
function compareRowsByName(firstRow, secondRow) {
  return nameCollator.compare(firstRow.name ?? '', secondRow.name ?? '') || firstRow.id.localeCompare(secondRow.id);
}

/**
 * Builds the lookup structures used by every walk:
 *   nodeById             id -> row
 *   childIdsByManagerId  managerId -> report ids, sorted by name (the graph's adjacency list).
 *                        Includes managers who are not in the snapshot (e.g. terminated), so their
 *                        remaining reports can still be found.
 */
export function indexHierarchyRows(rows) {
  const nodeById = new Map(rows.map((row) => [row.id, row]));
  const childRowsByManagerId = new Map();
  for (const row of rows) {
    if (!row.managerId) continue;
    const siblingRows = childRowsByManagerId.get(row.managerId);
    if (siblingRows) siblingRows.push(row);
    else childRowsByManagerId.set(row.managerId, [row]);
  }
  const childIdsByManagerId = new Map();
  for (const [managerId, childRows] of childRowsByManagerId) {
    childIdsByManagerId.set(managerId, childRows.sort(compareRowsByName).map((childRow) => childRow.id));
  }
  return { nodeById, childIdsByManagerId };
}

// =================================================================================================
// 3. Trees
// =================================================================================================

/**
 * The public node shape. `avatar` is null until profile images are stored; the frontend renders
 * initials from `name` meanwhile.
 */
function toTreeNode(row) {
  return { id: row.id, name: row.name, designation: row.designation, avatar: null, children: [] };
}

/**
 * Breadth-first walk from `startTreeNode` (already created for `startId`), attaching each report
 * under its manager. Skips ids already in `visitedIds`, which is what makes it loop-safe.
 * Calls `onVisit(row, level, parentId)` for every node reached (level 1 = direct report).
 * Returns the deepest level reached below the start node.
 */
function attachDescendants({ startId, startTreeNode, index, visitedIds, onVisit }) {
  const pendingNodes = [{ rowId: startId, treeNode: startTreeNode, level: 0 }];
  let deepestLevel = 0;
  for (let queueIndex = 0; queueIndex < pendingNodes.length; queueIndex += 1) {
    const { rowId, treeNode, level } = pendingNodes[queueIndex];
    for (const childId of index.childIdsByManagerId.get(rowId) ?? []) {
      if (visitedIds.has(childId)) continue;
      const childRow = index.nodeById.get(childId);
      if (!childRow) continue;
      visitedIds.add(childId);
      const childTreeNode = toTreeNode(childRow);
      treeNode.children.push(childTreeNode);
      pendingNodes.push({ rowId: childId, treeNode: childTreeNode, level: level + 1 });
      deepestLevel = Math.max(deepestLevel, level + 1);
      onVisit?.(childRow, level + 1, rowId);
    }
  }
  return deepestLevel;
}

/**
 * Builds the whole organisation as a forest of nested nodes.
 *
 *   Roots:   employees with no manager, plus orphans whose manager is not a current employee.
 *   Walk:    breadth-first from each root (see attachDescendants).
 *   Loops:   any row still unvisited afterwards can only be part of (or hang below) a loop, since
 *            every acyclic chain ends at a root. Each loop is broken at one of its members, which
 *            is treated as a root, so everyone appears exactly once.
 *
 * @param {Array<{ id: string, managerId: string|null, name: string|null, designation: string }>} rows
 * @returns {{ roots: object[], stats: { employeeCount, rootCount, orphanedCount, cycleBreakCount, maxDepth } }}
 */
export function buildHierarchyForest(rows) {
  const index = indexHierarchyRows(rows);
  const visitedIds = new Set();
  const roots = [];
  let orphanedCount = 0;
  let cycleBreakCount = 0;
  let maxDepth = 0;

  const growFromRoot = (rootRow) => {
    visitedIds.add(rootRow.id);
    const rootTreeNode = toTreeNode(rootRow);
    roots.push(rootTreeNode);
    maxDepth = Math.max(maxDepth, attachDescendants({ startId: rootRow.id, startTreeNode: rootTreeNode, index, visitedIds }));
  };

  const rootRows = rows
    .filter((row) => {
      if (!row.managerId) return true;
      if (index.nodeById.has(row.managerId)) return false;
      orphanedCount += 1;
      return true;
    })
    .sort(compareRowsByName);
  rootRows.forEach(growFromRoot);

  if (visitedIds.size < rows.length) {
    const unreachedRows = rows.filter((row) => !visitedIds.has(row.id)).sort((firstRow, secondRow) => firstRow.id.localeCompare(secondRow.id));
    for (const unreachedRow of unreachedRows) {
      if (visitedIds.has(unreachedRow.id)) continue;
      // An unreached employee is in a loop or hangs below one; every manager above them is also
      // unreached. Climbing the manager chain must therefore revisit some employee, and that
      // employee is on the loop. Breaking the loop there brings the loop and everything below it in.
      const climbedIds = new Set();
      let climbingId = unreachedRow.id;
      while (!climbedIds.has(climbingId)) {
        climbedIds.add(climbingId);
        climbingId = index.nodeById.get(climbingId).managerId;
      }
      cycleBreakCount += 1;
      growFromRoot(index.nodeById.get(climbingId));
    }
    logger.warn('Org hierarchy contains reporting loops; broken for display', {
      cycleBreakCount,
      affectedEmployeeIds: unreachedRows.slice(0, 20).map((unreachedRow) => unreachedRow.id),
    });
  }

  return { roots, stats: { employeeCount: rows.length, rootCount: roots.length, orphanedCount, cycleBreakCount, maxDepth } };
}

/**
 * Builds one manager's reporting subtree from the snapshot.
 *
 * @param {object[]} rows         Snapshot rows.
 * @param {{ id, name, designation }} managerRow  The manager; may come from the database when the
 *                                manager is not a current employee (their reports are still listed).
 * @returns {{ tree, directReports, indirectReports, stats: { directReportCount, totalReportCount, maxDepth } }}
 *   tree             nested nodes rooted at the manager
 *   directReports    flat list, level 1
 *   indirectReports  flat list, level >= 2, each with `managerId` (their own manager) and `level`
 */
export function buildReportsSubtree(rows, managerRow) {
  const index = indexHierarchyRows(rows);
  const tree = toTreeNode(managerRow);
  const directReports = [];
  const indirectReports = [];
  // The manager starts as visited, so a loop leading back to them stops the walk.
  const visitedIds = new Set([managerRow.id]);

  const maxDepth = attachDescendants({
    startId: managerRow.id,
    startTreeNode: tree,
    index,
    visitedIds,
    onVisit: (reportRow, level, parentId) => {
      const flatReport = { id: reportRow.id, name: reportRow.name, designation: reportRow.designation, avatar: null, managerId: parentId, level };
      (level === 1 ? directReports : indirectReports).push(flatReport);
    },
  });

  return {
    tree,
    directReports,
    indirectReports,
    stats: { directReportCount: directReports.length, totalReportCount: directReports.length + indirectReports.length, maxDepth },
  };
}

/**
 * Loads one employee's display row straight from MongoDB, whatever their status. Used when a
 * requested manager is not in the snapshot (for example terminated). Returns null if not found.
 */
export async function findEmployeeRowById(employeeId) {
  const profileRecord = await EmployeeProfile.findById(employeeId)
    .select('userId organizationData.designation organizationData.employmentStatus')
    .populate({ path: 'userId', select: 'name' })
    .lean();
  if (!profileRecord) return null;
  return {
    id: profileRecord._id.toString(),
    name: profileRecord.userId?.name ?? null,
    designation: profileRecord.organizationData.designation,
    employmentStatus: profileRecord.organizationData.employmentStatus,
  };
}
