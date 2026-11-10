/**
 * Department agents, end to end in two browsers: the department head adds a document; an employee
 * asks the department's agent and reads the streamed answer with its source, rates it, then asks
 * something the documents do not cover, which goes to the department. The head is notified live,
 * opens the question from the bell, answers it and saves it as an FAQ; the employee is notified live
 * and reads the reply in their conversation; the FAQ becomes a knowledge base document.
 * One sign-in per person: sign-ins are limited per account and other specs use these accounts too.
 * Runs after knowledgeHub.spec.js (files run in name order), which needs the Engineering agent not
 * yet opened by anyone.
 */

import { expect, test } from '@playwright/test';

import { DEPARTMENT_NAME, EMPLOYEE, KNOWLEDGE_HEAD } from './environment.js';
import { mainNavigation, signIn, watchForPageProblems } from './helpers.js';
import { STAND_IN_TRIGGERS } from './standInAiService.js';

const POLICY = 'Every employee gets 24 days of earned leave a year.';
const UNCOVERED_QUESTION = `What is the adoption leave policy? It is ${STAND_IN_TRIGGERS.NOT_IN_HANDBOOK}.`;
const LEAD_ANSWER = 'Adoption leave is 12 weeks, fully paid. Ask HR for the form.';
const AGENT_NAME = `${DEPARTMENT_NAME} Department Agent`;

const bell = (page) => page.getByRole('banner').getByRole('button', { name: /^Notifications/ });

test('an employee asks a department agent, and the department answers what it could not', async ({ browser }) => {
  test.setTimeout(120_000);

  // --- The head adds the document the agent answers from -----------------------------------------
  const headContext = await browser.newContext();
  const headPage = await headContext.newPage();
  const headProblems = watchForPageProblems(headPage);
  await signIn(headPage, KNOWLEDGE_HEAD.email);
  await mainNavigation(headPage).getByRole('link', { name: "My department's knowledge base" }).click();
  await expect(headPage).toHaveURL(/\/knowledge\/[0-9a-f]{24}$/);
  await headPage.getByRole('tab', { name: 'Documents' }).click();
  await headPage.getByLabel('Documents to upload').setInputFiles({
    name: 'Leave policy.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# Leave policy\n\n${POLICY}\n`),
  });
  const policyRow = headPage.getByRole('row').filter({ hasText: 'Leave policy.md' });
  await expect(policyRow.getByText('Ready')).toBeVisible({ timeout: 20_000 });

  // --- The employee asks, and reads the answer with its source ------------------------------------
  const employeeContext = await browser.newContext();
  const employeePage = await employeeContext.newPage();
  const employeeProblems = watchForPageProblems(employeePage);
  await signIn(employeePage, EMPLOYEE.email);
  await mainNavigation(employeePage).getByRole('link', { name: 'Ask an agent' }).click();
  await expect(employeePage.getByRole('heading', { level: 1, name: 'Ask an agent' })).toBeVisible();
  await employeePage.getByRole('link', { name: `Ask ${AGENT_NAME}` }).click();
  await expect(employeePage.getByRole('heading', { level: 1, name: AGENT_NAME })).toBeVisible();

  const question = employeePage.getByLabel('Your question');
  await question.fill('How many days of leave do I get?');
  await question.press('Enter');
  const conversation = employeePage.getByRole('list', { name: 'Conversation' });
  await expect(conversation.getByText('How many days of leave do I get?')).toBeVisible();
  await expect(employeePage).toHaveURL(/\?conversation=[0-9a-f]{24}$/);
  // The answer appears as it is written, before it is complete.
  await expect(conversation.locator('[aria-busy="true"]')).toContainText('According to');
  await expect(conversation.getByText(/According to the handbook: Every employee gets 24 days/)).toBeVisible();
  const sources = conversation.getByRole('list', { name: 'Sources' });
  await expect(sources.getByText('Leave policy.md')).toBeVisible();
  await expect(sources.getByText(POLICY)).toBeVisible();
  await expect(conversation.getByRole('link', { name: 'Source 1' })).toBeVisible();

  await conversation.getByRole('button', { name: 'Helpful', exact: true }).click();
  await expect(conversation.getByRole('button', { name: 'Helpful', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(conversation.getByText('Thanks for your feedback')).toBeVisible();

  // --- Something the documents do not cover goes to the department --------------------------------
  await question.fill(UNCOVERED_QUESTION);
  await employeePage.getByRole('button', { name: 'Send question' }).click();
  await expect(
    conversation.getByText(`so I sent your question to the ${DEPARTMENT_NAME} team`, { exact: false }),
  ).toBeVisible();
  await expect(conversation.getByText('Sent to the department. You will be notified when they reply.')).toBeVisible();

  // --- The head is told at once, and answers from the Questions tab -------------------------------
  await expect(bell(headPage)).toHaveAccessibleName(/1 unread/);
  await bell(headPage).click();
  await headPage
    .getByRole('dialog', { name: 'Notifications' })
    .getByRole('button', { name: new RegExp(`New question for ${DEPARTMENT_NAME}`) })
    .click();
  await expect(headPage).toHaveURL(/\/knowledge\/[0-9a-f]{24}\?tab=questions&question=[0-9a-f]{24}$/);
  const questionCard = headPage.getByRole('listitem', { name: `Question from ${EMPLOYEE.name}` });
  await expect(questionCard.getByText(UNCOVERED_QUESTION)).toBeVisible();
  await questionCard.getByRole('textbox', { name: 'Your answer' }).fill(LEAD_ANSWER);
  await questionCard.getByText('Save as FAQ').click();
  await expect(questionCard.getByLabel('FAQ question')).toHaveValue(UNCOVERED_QUESTION);
  await questionCard.getByLabel('FAQ question').fill('How long is adoption leave?');
  await questionCard.getByRole('button', { name: 'Send answer' }).click();
  await expect(headPage.getByText('Answer sent')).toBeVisible();
  await headPage.getByRole('tab', { name: /Answered/ }).click();
  const answeredCard = headPage.getByRole('listitem', { name: `Question from ${EMPLOYEE.name}` });
  await expect(answeredCard.getByText(LEAD_ANSWER)).toBeVisible();
  await expect(answeredCard.getByText('Saved as FAQ')).toBeVisible();

  // --- The employee is told at once, and reads the reply in their conversation --------------------
  await expect(bell(employeePage)).toHaveAccessibleName(/1 unread/);
  await bell(employeePage).click();
  await employeePage
    .getByRole('dialog', { name: 'Notifications' })
    .getByRole('button', { name: new RegExp(`${DEPARTMENT_NAME} answered your question`) })
    .click();
  await expect(bell(employeePage)).toHaveAccessibleName('Notifications');
  await expect(conversation.getByText(LEAD_ANSWER)).toBeVisible();
  await expect(
    conversation.getByText(`Reply from ${KNOWLEDGE_HEAD.name} (${DEPARTMENT_NAME})`, { exact: false }),
  ).toBeVisible();
  await expect(conversation.getByText('The department replied below.')).toBeVisible();

  // --- The FAQ is a knowledge base document, processed like any upload ----------------------------
  await headPage.getByRole('tab', { name: 'Documents' }).click();
  const faqRow = headPage.getByRole('row').filter({ hasText: 'FAQ - How long is adoption leave.md' });
  await expect(faqRow.getByText('Ready')).toBeVisible({ timeout: 20_000 });

  expect(employeeProblems, employeeProblems.join('\n')).toEqual([]);
  expect(headProblems, headProblems.join('\n')).toEqual([]);
  await employeeContext.close();
  await headContext.close();
});
