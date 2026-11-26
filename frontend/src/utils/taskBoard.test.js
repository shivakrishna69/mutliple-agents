/**
 * The board's rules as the browser applies them (taskBoard.js), mirroring the backend's: who may move
 * a task where, Done only from In review by a lead or the reporter, and the backlog into the active
 * sprint by a lead or the task's assignee; due chips against the company date, reviews for leads, and
 * the tasks a task may follow (never itself or one that would make a loop).
 */

import { describe, expect, it } from 'vitest';
import {
  allowedStatusesOf,
  canDragTask,
  canDropTask,
  canReviewTask,
  dueStateOf,
  followableTasks,
  revisionOf,
  taskRightsOf,
} from './taskBoard.js';

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

describe('due dates, reviews and the task a task follows', () => {
  const TODAY = '2026-11-26';

  it('marks open tasks overdue or due today against the company date, never done or undated ones', () => {
    expect(dueStateOf(task({ dueDate: '2026-11-25' }), TODAY)).toBe('OVERDUE');
    expect(dueStateOf(task({ dueDate: '2026-11-26' }), TODAY)).toBe('DUE_TODAY');
    expect(dueStateOf(task({ dueDate: '2026-11-27' }), TODAY)).toBeNull();
    expect(dueStateOf(task({ dueDate: '2026-11-20', status: 'DONE' }), TODAY)).toBeNull();
    expect(dueStateOf(task({ dueDate: null }), TODAY)).toBeNull();
    expect(dueStateOf(task({ dueDate: '2026-11-20' }), null)).toBeNull();
  });

  it('lets leads review only tasks in review, and shows a revision only on a task sent back', () => {
    expect(canReviewTask(task({ status: 'IN_REVIEW' }), LEAD)).toBe(true);
    expect(canReviewTask(task({ status: 'IN_REVIEW' }), MEMBER)).toBe(false);
    expect(canReviewTask(task({ status: 'IN_PROGRESS' }), LEAD)).toBe(false);
    const review = { state: 'CHANGES_REQUESTED', note: 'Add the totals row' };
    expect(revisionOf(task({ status: 'IN_PROGRESS', review }))).toBe(review);
    expect(revisionOf(task({ status: 'IN_REVIEW', review: { ...review, state: 'SUBMITTED' } }))).toBeNull();
    expect(revisionOf(task({ status: 'TODO', review }))).toBeNull();
  });

  it('offers every other task to follow, except those that already follow it (no loops), by key', () => {
    const tasks = [
      { id: 'a', key: 'ENG-10', dependsOnTaskId: null },
      { id: 'b', key: 'ENG-2', dependsOnTaskId: 'a' },
      { id: 'c', key: 'ENG-3', dependsOnTaskId: 'b' },
      { id: 'd', key: 'ENG-1', dependsOnTaskId: null },
    ];
    const keys = (list) => list.map((entry) => entry.key);
    expect(keys(followableTasks(tasks, 'a'))).toEqual(['ENG-1']);
    expect(keys(followableTasks(tasks, 'c'))).toEqual(['ENG-1', 'ENG-2', 'ENG-10']);
    expect(keys(followableTasks(tasks, null))).toEqual(['ENG-1', 'ENG-2', 'ENG-3', 'ENG-10']);
    // A loop already in the data (never saved by the backend) does not hang the check.
    const looped = [
      { id: 'x', key: 'ENG-5', dependsOnTaskId: 'y' },
      { id: 'y', key: 'ENG-6', dependsOnTaskId: 'x' },
    ];
    expect(keys(followableTasks(looped, 'z'))).toEqual(['ENG-5', 'ENG-6']);
  });
});
