/**
 * The board's rules as the browser applies them (taskBoard.js), mirroring the backend's: who may move
 * a task where, Done only from In review by a lead or the reporter, and the backlog into the active
 * sprint by a lead or the task's assignee.
 */

import { describe, expect, it } from 'vitest';
import { allowedStatusesOf, canDragTask, canDropTask, taskRightsOf } from './taskBoard.js';

const LEAD = { canMoveAnyTask: true, canPlanSprints: true };
const MEMBER = { canMoveAnyTask: false, canPlanSprints: false };
const ACTIVE = 'sprint-active';
const ME = { id: 'me' };
const OTHER = { id: 'other' };
const task = (fields) => ({ status: 'TODO', sprintId: ACTIVE, assignee: null, reporter: OTHER, ...fields });
const rightsFor = (viewer, someTask, activeSprintId = ACTIVE) => taskRightsOf(someTask, viewer, ME.id, activeSprintId);

describe('task board rules', () => {
  it('reaches Done only from In review, for a lead or the reporter, never the assignee alone', () => {
    const assigned = task({ status: 'IN_REVIEW', assignee: ME });
    expect(allowedStatusesOf(assigned, rightsFor(MEMBER, assigned))).toEqual(['TODO', 'IN_PROGRESS', 'IN_REVIEW']);
    const reported = task({ status: 'IN_REVIEW', reporter: ME });
    expect(allowedStatusesOf(reported, rightsFor(MEMBER, reported))).toEqual(['IN_REVIEW', 'DONE']);
    const inProgress = task({ status: 'IN_PROGRESS' });
    expect(allowedStatusesOf(inProgress, rightsFor(LEAD, inProgress))).not.toContain('DONE');
    const inReview = task({ status: 'IN_REVIEW' });
    expect(allowedStatusesOf(inReview, rightsFor(LEAD, inReview))).toContain('DONE');
  });

  it('takes a backlog task into To do of the active sprint, for a lead or its assignee', () => {
    const mine = task({ sprintId: null, assignee: ME });
    expect(canDropTask(mine, { status: 'TODO' }, rightsFor(MEMBER, mine), ACTIVE)).toBe(true);
    expect(canDropTask(mine, { status: 'IN_PROGRESS' }, rightsFor(MEMBER, mine), ACTIVE)).toBe(false);
    const theirs = task({ sprintId: null, assignee: OTHER });
    expect(canDropTask(theirs, { status: 'TODO' }, rightsFor(MEMBER, theirs), ACTIVE)).toBe(false);
    expect(canDragTask(theirs, rightsFor(MEMBER, theirs), ACTIVE)).toBe(false);
    expect(canDropTask(theirs, { status: 'TODO' }, rightsFor(LEAD, theirs), ACTIVE)).toBe(true);
    expect(canDropTask(mine, { status: 'TODO' }, rightsFor(MEMBER, mine, null), null)).toBe(false);
    expect(canDragTask(mine, rightsFor(MEMBER, mine, null), null)).toBe(false);
  });

  it('keeps the backlog and planned sprints to leads, and Done drops to who may mark done', () => {
    const mine = task({ assignee: ME, status: 'IN_REVIEW' });
    expect(canDropTask(mine, { sprintId: null }, rightsFor(MEMBER, mine), ACTIVE)).toBe(false);
    expect(canDropTask(mine, { sprintId: null }, rightsFor(LEAD, mine), ACTIVE)).toBe(true);
    expect(canDropTask(mine, { status: 'DONE' }, rightsFor(MEMBER, mine), ACTIVE)).toBe(false);
    expect(canDropTask(mine, { status: 'IN_PROGRESS' }, rightsFor(MEMBER, mine), ACTIVE)).toBe(true);
    const reported = task({ reporter: ME, status: 'IN_REVIEW' });
    expect(canDropTask(reported, { status: 'DONE' }, rightsFor(MEMBER, reported), ACTIVE)).toBe(true);
    expect(canDropTask(reported, { status: 'TODO' }, rightsFor(MEMBER, reported), ACTIVE)).toBe(false);
  });
});
