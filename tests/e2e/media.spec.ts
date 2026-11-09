// Admin media (capabilities media-images → "Pasted Markdown", media-library): Markdown pasted into
// the editor with an image embedded as a data URL is uploaded and rewritten to its /media/ address;
// Admin → Media lists the image with the article that uses it, and Replace swaps the file behind the
// same address. Needs the admin the global setup seeded; runs after the Listen walk (config order).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { createArticleApi, originOf, signIn } from './helpers/admin';
import { IMAGE_FIXTURE } from './helpers/upload';

const JPG = path.join(process.cwd(), 'tests', 'fixtures', 'images', 'sample.jpg');

test('paste Markdown with an embedded image → uploaded and swapped; Media lists it; Replace keeps the address', async ({ page }, testInfo) => {
  await signIn(page);
  const article = await createArticleApi(page.request, originOf(testInfo), { title: 'Pasted image walk', topic: 'Analysis', bodyMd: 'Start.' });

  await page.goto(`/admin/articles/${article.id}`);
  const area = page.locator('textarea.mdedit__area');
  await area.click();
  await area.fill('');
  const dataUri = 'data:image/png;base64,' + readFileSync(IMAGE_FIXTURE.png).toString('base64');
  const markdown = `Before the picture, a paragraph long enough to read.\n\n![Walk chart][img1]\n\nAfter the picture.\n\n[img1]: <${dataUri}>\n`;
  await area.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, markdown);

  await expect(area).toHaveValue(/\[img1\]: <\/media\/blog0\/image\/\d{4}\/\d{2}\/[0-9a-f-]+\.png>/);
  const body = await area.inputValue();
  expect(body).not.toContain('base64');
  expect(body).toContain('![Walk chart][img1]');
  await expect(page.getByText('Uploaded 1 pasted image.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live preview' }).locator('figure.mdfig img')).toHaveAttribute('src', /^\/media\//);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.pubbar__state')).toHaveText(/Saved · rev \d+/);

  await page.getByRole('navigation', { name: 'Desk' }).getByRole('link', { name: 'Media' }).click();
  await expect(page).toHaveURL(/\/admin\/media$/);
  // by the article that uses it: the filename changes when the file is replaced
  const card = page.getByTestId('media-card').filter({ hasText: 'Pasted image walk' });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('pasted-image-1.png');
  await expect(card).toContainText('PNG');
  await expect(card.getByRole('link', { name: 'Pasted image walk' })).toBeVisible();

  const address = (await card.locator('img').first().getAttribute('src'))!.split('?')[0];
  const before = await page.request.get(address);
  expect(before.headers()['content-type']).toBe('image/png');
  expect(before.headers()['cache-control']).toBe('public, no-cache');

  await card.getByTestId('media-replace-input').setInputFiles(JPG);
  await card.getByTestId('media-confirm').click();
  await expect(card).toContainText('JPEG');
  await expect(card).toContainText('sample.jpg');

  const after = await page.request.get(address);
  expect(after.status()).toBe(200);
  expect(after.headers()['content-type']).toBe('image/jpeg');
  expect(after.headers().etag).not.toBe(before.headers().etag);
  expect((await after.body()).equals(readFileSync(JPG))).toBe(true);
});
