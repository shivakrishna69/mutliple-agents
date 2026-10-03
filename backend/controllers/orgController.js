/**
 * Organisation chart endpoints. Graph loading, caching and tree building live in
 * services/orgHierarchyService.js; these handlers validate input, choose the tree to build, and
 * shape the HTTP response.
 *
 * HTTP caching: responses carry `Cache-Control: private, no-cache`. Shared caches (proxies, CDNs)
 * must never store internal staff data, and the browser must revalidate on every load; Express's
 * automatic ETag then answers an unchanged chart with 304 Not Modified. Whether the server
 * snapshot came from Redis is reported in the `X-Cache: hit|miss` header rather than the body,
 * so the body (and its ETag) stays identical across cache hits.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ORG_MESSAGES } from '../constants/messages.js';
import {
  buildHierarchyForest,
  buildReportsSubtree,
  findEmployeeRowById,
  loadHierarchySnapshot,
} from '../services/orgHierarchyService.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

function setOrgResponseHeaders(res, cacheStatus) {
  res.set('Cache-Control', 'private, no-cache');
  res.set('X-Cache', cacheStatus);
}

/**
 * GET /api/org/hierarchy
 *
 * The whole organisation as nested nodes. An organisation normally has one root (the CEO), but
 * the response is always a list: a company may have several top-level heads, and employees whose
 * manager is no longer employed are shown as extra roots until they are reassigned.
 *
 * Responses:
 *   200 { message, data: {
 *         roots: [{ id, name, designation, avatar, children: [...] }],
 *         meta:  { generatedAt, employeeCount, rootCount, orphanedCount, cycleBreakCount, maxDepth } } }
 *   401 / 403  from protect / requireStaff
 *   500        unexpected failure (central error handler)
 */
export async function getOrgHierarchy(req, res, next) {
  try {
    const { snapshot, cacheStatus } = await loadHierarchySnapshot();
    const { roots, stats } = buildHierarchyForest(snapshot.nodes);

    if (stats.orphanedCount > 0) {
      logger.warn('Org hierarchy has employees whose manager is not a current employee', { requestId: req.id, orphanedCount: stats.orphanedCount });
    }

    setOrgResponseHeaders(res, cacheStatus);
    return sendSuccess(res, HTTP_STATUS.OK, ORG_MESSAGES.HIERARCHY_RETRIEVED, {
      roots,
      meta: { generatedAt: snapshot.generatedAt, ...stats },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/org/manager/:id
 *
 * Everyone who reports to the given employee, directly or through other managers, as both a
 * nested tree (rooted at the manager) and flat lists. `:id` is an EmployeeProfile id.
 *
 * The manager is looked up in the cached snapshot first. A manager who is not a current employee
 * (e.g. terminated) is not in the snapshot, so they are loaded from MongoDB; their remaining
 * reports are still returned, which is exactly what is needed to reassign them.
 *
 * Responses:
 *   200 { message, data: {
 *         manager:         { id, name, designation, avatar, isCurrentEmployee },
 *         tree:            { id, name, designation, avatar, children: [...] },
 *         directReports:   [{ id, name, designation, avatar, managerId, level: 1 }],
 *         indirectReports: [{ id, name, designation, avatar, managerId, level: 2.. }],
 *         meta:            { generatedAt, directReportCount, totalReportCount, maxDepth } } }
 *   400 `:id` is not a valid id
 *   404 no employee profile with that id
 *   401 / 403  from protect / requireStaff
 *   500 unexpected failure
 */
export async function getManagerReports(req, res, next) {
  try {
    const managerId = req.params.id;
    if (!isValidObjectIdString(managerId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ORG_MESSAGES.INVALID_EMPLOYEE_ID, [{ field: 'id', message: ORG_MESSAGES.INVALID_EMPLOYEE_ID }]);
    }
    // Ids in the snapshot are lowercase hex strings; compare in the same form.
    const normalizedManagerId = managerId.toLowerCase();

    const { snapshot, cacheStatus } = await loadHierarchySnapshot();
    let managerRow = snapshot.nodes.find((row) => row.id === normalizedManagerId) ?? null;
    const isCurrentEmployee = managerRow !== null;
    if (!managerRow) {
      managerRow = await findEmployeeRowById(normalizedManagerId);
      if (!managerRow) {
        return sendError(req, res, HTTP_STATUS.NOT_FOUND, ORG_MESSAGES.EMPLOYEE_NOT_FOUND);
      }
    }

    const { tree, directReports, indirectReports, stats } = buildReportsSubtree(snapshot.nodes, managerRow);

    setOrgResponseHeaders(res, cacheStatus);
    return sendSuccess(res, HTTP_STATUS.OK, ORG_MESSAGES.REPORTS_RETRIEVED, {
      manager: { id: managerRow.id, name: managerRow.name, designation: managerRow.designation, avatar: null, isCurrentEmployee },
      tree,
      directReports,
      indirectReports,
      meta: { generatedAt: snapshot.generatedAt, ...stats },
    });
  } catch (error) {
    return next(error);
  }
}
