/**
 * Starting and completing a department's sprints (leads), for the board's header and its planning
 * sections. Completing asks first: the sprint's unfinished tasks go back to the backlog.
 *
 *   const { transition, busySprintId } = useSprintTransition(departmentId, { onDone, onError });
 *   transition(sprint, SPRINT_STATUSES.ACTIVE)
 */

import { useState } from 'react';
import { requestSprintUpdate } from '../api/tasksApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { SPRINT_STATUSES } from '../constants/tasks.js';
import { toDisplayError } from './useApiResource.js';

export function useSprintTransition(departmentId, { onDone, onError }) {
  const { csrfToken } = useAuth();
  const [busySprintId, setBusySprintId] = useState(null);

  async function transition(sprint, nextStatus) {
    if (
      nextStatus === SPRINT_STATUSES.COMPLETED &&
      !window.confirm(`Complete ${sprint.name}? Its unfinished tasks go back to the backlog.`)
    ) {
      return;
    }
    setBusySprintId(sprint.id);
    try {
      const result = await requestSprintUpdate(
        departmentId,
        sprint.id,
        { status: nextStatus, version: sprint.version },
        csrfToken,
      );
      onDone(result.notice);
    } catch (transitionError) {
      onError(toDisplayError(transitionError));
    } finally {
      setBusySprintId(null);
    }
  }

  return { transition, busySprintId };
}
