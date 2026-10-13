// The admin a global setup seeded, UI sign-in, and the admin API calls the walks share.
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Where tests/e2e/global-setup.ts hands its admin to the workers. */
export const E2E_ADMIN_ENV = {
  email: 'BLOG0_E2E_ADMIN_EMAIL',
  password: 'BLOG0_E2E_ADMIN_PASSWORD',
  name: 'BLOG0_E2E_ADMIN_NAME',
} as const;

export interface E2eAdmin {
  email: string;
  password: string;
  displayName: string;
}

/**
 * The admin a global setup put in the environment (`env` names the variables; the designer-mode
 * setup has no name variable, so `displayName` is the fallback).
 */
export function e2eAdmin(
  env: { email: string; password: string; name?: string } = E2E_ADMIN_ENV,
  displayName = '',
): E2eAdmin {
  const email = process.env[env.email] ?? '';
  const password = process.env[env.password] ?? '';
  if (!email || !password) throw new Error(`E2E admin credentials missing (${env.email}) — the global setup did not run`);
  return { email, password, displayName: (env.name ? process.env[env.name] : '') || displayName };
}

/** Fills the sign-in form on /admin/login and waits for the desk. */
export async function signInThroughForm(page: Page, admin: E2eAdmin = e2eAdmin()): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to the desk' })).toBeVisible();
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Desk', exact: true })).toBeVisible();
}

/** Opens /admin/login and signs in (lands on the desk). */
export async function signIn(page: Page, admin: E2eAdmin = e2eAdmin()): Promise<void> {
  await page.goto('/admin/login?next=%2Fadmin');
  await signInThroughForm(page, admin);
}

/** The origin of the project's baseURL — the `origin` header the CSRF check wants on writes. */
export function originOf(testInfo: { project: { use: { baseURL?: string } } }): string {
  const base = testInfo.project.use.baseURL;
  if (!base) throw new Error('baseURL missing from the Playwright config');
  return new URL(base).origin;
}

export interface CreatedArticle {
  id: string;
  slug: string;
  currentRevision: { id: string };
}

/** POST /api/admin/articles (signed-in `request`) → 201 with the new article. */
export async function createArticleApi(
  request: APIRequestContext,
  origin: string,
  data: { title: string; topic?: string; dek?: string; bodyMd?: string },
): Promise<CreatedArticle> {
  const res = await request.post('/api/admin/articles', { headers: { origin }, data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).data.article as CreatedArticle;
}

/** POST /api/admin/articles/:id/publish for a revision → 200. */
export async function publishApi(request: APIRequestContext, origin: string, articleId: string, revisionId: string): Promise<void> {
  const res = await request.post(`/api/admin/articles/${articleId}/publish`, { headers: { origin }, data: { revisionId } });
  expect(res.status(), await res.text()).toBe(200);
}
