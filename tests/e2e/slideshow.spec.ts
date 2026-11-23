// SMA-49: a slideshow-only post. Mark an article "Slideshow only", add pictures to its TLDR deck
// by hand (no AI), publish, and read it: the page IS the deck — pictures with their captions, no
// Read / Listen capsule, no "Read the full article" — and closing it returns home.
import { expect, test } from '@playwright/test';

import { createArticleApi, originOf, signIn } from './helpers/admin';
import { IMAGE_FIXTURE } from './helpers/upload';

test('slideshow-only post: add images to the deck, publish, and the public page is the deck (title card, then full-screen pictures)', async ({ page }, testInfo) => {
  await signIn(page);
  const article = await createArticleApi(page.request, originOf(testInfo), { title: 'Pictures only walk', topic: 'Photos' });

  await page.goto(`/admin/articles/${article.id}`);
  await page.getByText('Settings', { exact: true }).click();
  await page.getByLabel(/Slideshow only/).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.pubbar__state')).toHaveText(/Saved · rev \d+/);

  await page.getByRole('tab', { name: /^TLDR/ }).click();
  const panel = page.locator('#panel-tldr');
  await panel.getByTestId('deck-image-input').setInputFiles([IMAGE_FIXTURE.png]);
  await expect(panel.locator('.deck__thumb')).toHaveCount(1);
  await panel.getByLabel('Caption for slide 1').fill('The first picture');
  await panel.getByLabel('Alt text for slide 1').fill('A test chart');
  await panel.getByRole('button', { name: 'Save deck' }).click();
  await expect(panel.getByText('Deck saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const viewLive = page.getByRole('link', { name: 'View live ↗' });
  await expect(viewLive).toBeVisible();
  const href = (await viewLive.getAttribute('href'))!;

  await page.goto(href);
  const deck = page.getByRole('dialog', { name: /Summary of Pictures only walk/ });
  await expect(deck).toBeVisible();
  // the deck opens on the title card (title + dek), like every other TLDR deck
  await expect(deck.locator('.tdeck__big')).toHaveText('Pictures only walk');
  await page.keyboard.press('ArrowRight');
  // the picture fills the slide: fitted, not cropped, with its caption and alt text
  const img = deck.locator('.tdeck__photoimg');
  await expect(img).toHaveAttribute('src', /^\/media\//);
  await expect(img).toHaveAttribute('alt', 'A test chart');
  await expect(img).toHaveCSS('object-fit', 'contain');
  await expect(deck.getByText('The first picture')).toBeVisible();
  const [frame, view] = await Promise.all([deck.locator('.tdeck__photoframe').boundingBox(), page.viewportSize()]);
  expect(frame!.width).toBeGreaterThan(view!.width * 0.8);
  expect(frame!.height).toBeGreaterThan(view!.height * 0.4);
  // no Read / Listen to hand over to
  await expect(page.getByRole('tablist', { name: 'How to take this in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Read the full article' })).toHaveCount(0);
  // the address stays /p/<slug>
  expect(new URL(page.url()).pathname).toBe(new URL(href, page.url()).pathname);

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/);
});
