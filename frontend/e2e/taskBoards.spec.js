/**
 * A department's task board in two browsers. The head (a lead) opens the board from the sidebar,
 * plans a sprint, creates a task for an employee in it and starts it. The employee opens the task
 * from the assignment notification, drags it to In progress, comments, filters the board, and creates
 * a task (which goes to the backlog; members do not plan sprints). The head sees the move, drags the
 * task to Done and completes the sprint, which sends unfinished work back to the backlog.
 * Then delegation: the employee, a member, has no team overview and cannot choose leads; the head
 * names them a task lead, and they read the team overview (their workload, the completed sprint's
 * burndown, the unassigned backlog, from which a task opens); the head takes the role back and the
 * overview is gone, even by address.
 * One sign-in per person: the suite's sign-ins share one address's limit (30 per 15 minutes). Runs after questionsInbox.spec.js (files run in name order), whose bell
 * counts this spec's notifications would otherwise change.
 */

import { expect, test } from '@playwright/test';

import { DEPARTMENT_NAME, EMPLOYEE, KNOWLEDGE_HEAD } from './environment.js';
import { localToday, mainNavigation, signIn, watchForPageProblems } from './helpers.js';

const TASK_TITLE = 'Fix the login button on Safari';
const LEAD_ONLY_TASK = 'Plan the team offsite';
const MEMBER_TASK = 'Write the release notes';
const COMMENT = 'Reproduced it, working on a fix.';

/** A calendar date `days` after today, as the date inputs take it. */
function daysFromToday(days) {
  const date = new Date(`${localToday()}T00:00:00`);
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

const column = (page, name) => page.getByRole('region', { name, exact: true });
const card = (page, title) => page.getByRole('listitem', { name: new RegExp(title) });
const bell = (page) => page.getByRole('banner').getByRole('button', { name: /^Notifications/ });

async function setEmployeeAsLead(page, isLead) {
  await page.getByRole('button', { name: 'Task leads' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task leads' });
  await expect(dialog.getByRole('checkbox', { name: new RegExp(KNOWLEDGE_HEAD.name) })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: new RegExp(EMPLOYEE.name) }).setChecked(isLead);
  await dialog.getByRole('button', { name: 'Save task leads' }).click();
  await expect(page.getByText('Task leads saved')).toBeVisible();
  await expect(dialog).toHaveCount(0);
}

test('a department plans a sprint, works its tasks on the board, completes it, and delegates leads', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  // --- The head plans a sprint with a task for the employee, and starts it ------------------------
  const headContext = await browser.newContext();
  const headPage = await headContext.newPage();
  const headProblems = watchForPageProblems(headPage);
  await signIn(headPage, KNOWLEDGE_HEAD.email);
  await mainNavigation(headPage).getByRole('link', { name: 'Department Board' }).click();
  await expect(headPage).toHaveURL(/\/boards\/[0-9a-f]{24}$/);
  await expect(headPage.getByRole('heading', { level: 1, name: `${DEPARTMENT_NAME} board` })).toBeVisible();
  await expect(headPage.getByText('No sprint is active').first()).toBeVisible();

  await headPage.getByRole('tab', { name: 'Backlog' }).click();
  await headPage.getByRole('button', { name: 'Plan a sprint' }).click();
  const sprintDialog = headPage.getByRole('dialog', { name: 'Plan a sprint' });
  await sprintDialog.getByLabel('Sprint name').fill('Sprint 1');
  await sprintDialog.getByLabel('Starts').fill(localToday());
  await sprintDialog.getByLabel('Ends').fill(daysFromToday(13));
  await sprintDialog.getByRole('button', { name: 'Plan sprint' }).click();
  await expect(headPage.getByText('Sprint created')).toBeVisible();

  for (const [title, assignee] of [
    [TASK_TITLE, EMPLOYEE.name],
    [LEAD_ONLY_TASK, null],
  ]) {
    await headPage.getByRole('button', { name: 'Create task' }).click();
    const createDialog = headPage.getByRole('dialog', { name: 'Create a task' });
    await createDialog.getByLabel('Title').fill(title);
    await createDialog.getByLabel('Type').selectOption({ label: 'Bug' });
    await createDialog.getByLabel('Priority').selectOption({ label: 'High' });
    if (assignee) await createDialog.getByLabel('Assignee').selectOption({ label: assignee });
    await createDialog.getByLabel('Story points').fill('3');
    await createDialog.getByLabel('Sprint', { exact: true }).selectOption({ label: 'Sprint 1 (planning)' });
    await createDialog.getByRole('button', { name: 'Create task' }).click();
    await expect(headPage.getByText('Task created')).toBeVisible();
  }
  const sprintSection = headPage.getByRole('region', { name: 'Sprint 1' });
  await expect(sprintSection.getByText(TASK_TITLE)).toBeVisible();
  await sprintSection.getByRole('button', { name: 'Start sprint' }).click();
  await expect(headPage.getByText('Sprint saved')).toBeVisible();
  await headPage.getByRole('tab', { name: 'Active sprint' }).click();
  await expect(card(column(headPage, 'To do'), TASK_TITLE)).toBeVisible();

  // --- The employee opens it from the notification and moves it --------------------------------------
  const employeeContext = await browser.newContext();
  const employeePage = await employeeContext.newPage();
  const employeeProblems = watchForPageProblems(employeePage);
  await signIn(employeePage, EMPLOYEE.email);
  await expect(bell(employeePage)).toHaveAccessibleName(/1 unread/);
  await bell(employeePage).click();
  await employeePage
    .getByRole('dialog', { name: 'Notifications' })
    .getByRole('button', { name: /was assigned to you/ })
    .click();
  await expect(employeePage).toHaveURL(/\/boards\/[0-9a-f]{24}\?task=[0-9a-f]{24}$/);
  const taskDialog = employeePage.getByRole('dialog', { name: new RegExp(TASK_TITLE) });
  await expect(taskDialog.getByLabel('Title')).toHaveValue(TASK_TITLE);
  await expect(taskDialog.getByLabel('Sprint', { exact: true })).toBeDisabled();
  await employeePage.keyboard.press('Escape');
  await expect(taskDialog).toHaveCount(0);

  // A member: no team overview, no choice of leads.
  await expect(employeePage.getByRole('tab', { name: 'Team overview' })).toHaveCount(0);
  await expect(employeePage.getByRole('button', { name: 'Task leads' })).toHaveCount(0);

  await expect(card(employeePage, TASK_TITLE)).toHaveAttribute('draggable', 'true');
  await expect(card(employeePage, LEAD_ONLY_TASK)).toHaveAttribute('draggable', 'false');
  await card(column(employeePage, 'To do'), TASK_TITLE).dragTo(column(employeePage, 'In progress'));
  await expect(card(column(employeePage, 'In progress'), TASK_TITLE)).toBeVisible();

  await card(employeePage, TASK_TITLE).getByRole('button').click();
  const reopened = employeePage.getByRole('dialog', { name: new RegExp(TASK_TITLE) });
  await expect(reopened.getByLabel('Status')).toHaveValue('IN_PROGRESS');
  await reopened.getByLabel('Add a comment').fill(COMMENT);
  await reopened.getByRole('button', { name: 'Comment' }).click();
  const activity = reopened.getByRole('list', { name: 'Activity' });
  await expect(activity.getByText(COMMENT)).toBeVisible();
  await expect(activity.getByText('changed the status from To do to In progress')).toBeVisible();
  await reopened.getByRole('button', { name: 'Close' }).click();
  await expect(reopened).toHaveCount(0);

  // Filters
  await employeePage.getByLabel('Assignee', { exact: true }).selectOption({ label: 'Unassigned' });
  await expect(card(employeePage, TASK_TITLE)).toHaveCount(0);
  await expect(card(employeePage, LEAD_ONLY_TASK)).toBeVisible();
  await employeePage.getByLabel('Assignee', { exact: true }).selectOption({ label: 'Me' });
  await expect(card(employeePage, TASK_TITLE)).toBeVisible();
  await expect(card(employeePage, LEAD_ONLY_TASK)).toHaveCount(0);
  await employeePage.getByLabel('Type', { exact: true }).selectOption({ label: 'Story' });
  await expect(card(employeePage, TASK_TITLE)).toHaveCount(0);
  await employeePage.getByLabel('Type', { exact: true }).selectOption({ label: 'Any' });

  // A member's task goes to the backlog: there is no sprint to choose.
  await employeePage.getByRole('button', { name: 'Create task' }).click();
  const memberDialog = employeePage.getByRole('dialog', { name: 'Create a task' });
  await expect(memberDialog.getByLabel('Sprint', { exact: true })).toHaveCount(0);
  await memberDialog.getByLabel('Title').fill(MEMBER_TASK);
  await memberDialog.getByRole('button', { name: 'Create task' }).click();
  await expect(employeePage.getByText('Task created')).toBeVisible();
  await employeePage.getByRole('tab', { name: 'Backlog' }).click();
  await employeePage.getByLabel('Assignee', { exact: true }).selectOption({ label: 'Everyone' });
  await expect(employeePage.getByRole('region', { name: 'Backlog' }).getByText(MEMBER_TASK)).toBeVisible();
  await expect(employeePage.getByRole('button', { name: 'Complete sprint' })).toHaveCount(0);

  // --- The head finishes the task and completes the sprint -----------------------------------------
  await headPage.reload();
  await expect(card(column(headPage, 'In progress'), TASK_TITLE)).toBeVisible();
  await card(column(headPage, 'In progress'), TASK_TITLE).dragTo(column(headPage, 'Done'));
  await expect(card(column(headPage, 'Done'), TASK_TITLE)).toBeVisible();
  await headPage.getByRole('tab', { name: 'Backlog' }).click();
  headPage.once('dialog', (dialog) => dialog.accept());
  await headPage.getByRole('region', { name: 'Sprint 1' }).getByRole('button', { name: 'Complete sprint' }).click();
  await expect(headPage.getByText('Sprint saved')).toBeVisible();
  const backlog = headPage.getByRole('region', { name: 'Backlog' });
  await expect(backlog.getByText(LEAD_ONLY_TASK)).toBeVisible();
  await expect(backlog.getByText(MEMBER_TASK)).toBeVisible();
  await expect(backlog.getByText(TASK_TITLE)).toHaveCount(0);
  await headPage.getByRole('tab', { name: 'Active sprint' }).click();
  await expect(headPage.getByText('No sprint is active').first()).toBeVisible();

  // --- The head names the employee a task lead ---------------------------------------------------------
  await setEmployeeAsLead(headPage, true);

  // --- The employee, now a lead, reads the team overview ----------------------------------------------
  await employeePage.reload();
  await expect(employeePage.getByText('Task lead', { exact: true })).toBeVisible();
  await expect(employeePage.getByRole('button', { name: 'Task leads' })).toHaveCount(0);
  await employeePage.getByRole('tab', { name: 'Team overview' }).click();
  await expect(employeePage).toHaveURL(/\?view=team$/);
  await expect(employeePage.getByText(`Task leads: ${KNOWLEDGE_HEAD.name}, ${EMPLOYEE.name}`)).toBeVisible();

  const employeeRow = employeePage.getByRole('row', { name: new RegExp(EMPLOYEE.name) });
  await expect(employeeRow.getByRole('cell')).toHaveText(['0', '0', '0', '1', '3 / 3']);
  await expect(employeePage.getByText('2 backlog tasks have no owner')).toBeVisible();
  const alerts = employeePage.getByRole('list', { name: 'Unassigned backlog tasks' }).getByRole('listitem');
  await expect(alerts).toHaveCount(2);
  await expect(alerts.first()).toContainText(LEAD_ONLY_TASK);
  await expect(alerts.first()).toContainText('High');
  await expect(alerts.nth(1)).toContainText(MEMBER_TASK);

  await employeePage.getByLabel('Showing').selectOption({ label: 'Sprint 1 (completed)' });
  await expect(employeePage.getByRole('img', { name: 'Burndown of Sprint 1: 0 of 3 points still open' })).toBeVisible();
  await expect(employeePage.getByText('All points done')).toBeVisible();
  await expect(employeeRow.getByRole('cell')).toHaveText(['0', '0', '0', '1', '3 / 3']);

  await employeePage.getByLabel('Showing').selectOption({ label: 'Backlog' });
  await alerts
    .first()
    .getByRole('button', { name: new RegExp(LEAD_ONLY_TASK) })
    .click();
  const backlogTaskDialog = employeePage.getByRole('dialog', { name: new RegExp(LEAD_ONLY_TASK) });
  await expect(backlogTaskDialog.getByLabel('Title')).toHaveValue(LEAD_ONLY_TASK);
  await expect(backlogTaskDialog.getByLabel('Sprint', { exact: true })).toBeEnabled();
  await employeePage.keyboard.press('Escape');
  await expect(backlogTaskDialog).toHaveCount(0);

  // --- The head takes the role back; the overview is gone, even by address ----------------------------
  await setEmployeeAsLead(headPage, false);
  await employeePage.reload();
  await expect(employeePage.getByRole('tab', { name: 'Active sprint' })).toHaveAttribute('aria-selected', 'true');
  await expect(employeePage.getByRole('tab', { name: 'Team overview' })).toHaveCount(0);
  await expect(employeePage.getByText('Task lead', { exact: true })).toHaveCount(0);

  expect(employeeProblems, employeeProblems.join('\n')).toEqual([]);
  expect(headProblems, headProblems.join('\n')).toEqual([]);
  await employeeContext.close();
  await headContext.close();
});
