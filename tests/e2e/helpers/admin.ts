// The admin seeded by tests/e2e/global-setup.ts, and a UI sign-in helper.
import { expect, type Page } from '@playwright/test';

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

export function e2eAdmin(): E2eAdmin {
  const email = process.env[E2E_ADMIN_ENV.email] ?? '';
  const password = process.env[E2E_ADMIN_ENV.password] ?? '';
  const displayName = process.env[E2E_ADMIN_ENV.name] ?? '';
  if (!email || !password) throw new Error('E2E admin credentials missing — tests/e2e/global-setup.ts did not run');
  return { email, password, displayName };
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
