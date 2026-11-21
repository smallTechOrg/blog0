import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { createArticleApi, originOf, signIn } from './helpers/admin';
import { clearProvider, saveProviderOutOfBand } from './helpers/ai';

// The writing assistant end to end (SMA-43), against a local fake OpenAI-compatible endpoint (the
// server under test really calls it over HTTP): no provider → the panel points at Site → AI provider;
// with one → typing ~40 words makes the assistant read on its own and show the comments; a finished
// sentence reads again (after the cooldown) and the first round moves under "Earlier"; off means no
// calls; edited instructions in Admin → Site reach the model. The real model is covered elsewhere.

interface Seen {
  auth: string | undefined;
  system: string;
  user: string;
}

const seen: Seen[] = [];
let server: Server;
let baseUrl = '';

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const json = JSON.parse(await body(req)) as { messages: Array<{ role: string; content: string }> };
    const system = json.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = json.messages.find((m) => m.role === 'user')?.content ?? '';
    seen.push({ auth: req.headers.authorization, system, user });
    const n = seen.length;
    const content = JSON.stringify({
      comments: [{ kind: n === 1 ? 'accuracy' : 'missing', quote: n === 1 ? 'in 1887' : '', text: `Fake comment ${n}.` }],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `fake-${n}`, choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

test.afterAll(async () => {
  await clearProvider();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

test('the writing assistant comments while you write (fake provider)', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await clearProvider();
  await signIn(page);
  const article = await createArticleApi(page.request, originOf(testInfo), {
    title: 'Assistant walk',
    topic: 'Notes',
    bodyMd: 'The lighthouse was built in 1887.',
  });
  await page.goto(`/admin/articles/${article.id}`);
  const side = page.locator('.split__side');
  await side.getByRole('button', { name: /^Assistant/ }).click();

  // No provider: the panel says how to turn it on.
  const status = side.getByTestId('assist-status');
  await expect(status).toContainText('Set up an AI provider to use the assistant.');
  await expect(status.getByRole('link', { name: 'Site → AI provider' })).toHaveAttribute('href', '/admin/site#ai');

  await saveProviderOutOfBand({ baseUrl, model: 'fake/assistant', apiKey: 'fake-e2e-assistant-key' });
  await page.reload();
  await side.getByRole('button', { name: /^Assistant/ }).click();
  await expect(status).toContainText('Watching');
  expect(seen).toHaveLength(0); // opening the editor never reads

  // ~40 new words → it reads on its own after a pause in typing.
  const area = page.locator('.mdedit__area');
  await area.fill(`The lighthouse was built in 1887.\n\n${words(42)}`);
  const list = side.getByTestId('assist-comments');
  await expect(list).toContainText('Fake comment 1.', { timeout: 15_000 });
  await expect(list.locator('.assist__kind')).toHaveText('Accuracy');
  await expect(list.locator('.assist__quote')).toHaveText('in 1887');
  expect(seen[0].auth).toBe('Bearer fake-e2e-assistant-key');
  expect(seen[0].user).toContain('word41');
  expect(seen[0].user).toMatch(/<changed>\n[\s\S]*word0[\s\S]*<\/changed>/);
  expect(seen[0].system).toContain('{"comments":');

  // A finished sentence reads again (after the 15 s cooldown); the first round moves under Earlier.
  await area.press('ControlOrMeta+End');
  await area.pressSequentially(' Then the keeper wrote it all down for us.');
  await expect(list).toContainText('Fake comment 2.', { timeout: 30_000 });
  await expect(side.locator('.assist__earlier summary')).toHaveText('Earlier (1)');
  expect(seen[1].user).toContain('Then the keeper wrote it all down for us.');

  // Off: no calls, whatever changes.
  await side.getByLabel('On').uncheck();
  await expect(status).toContainText('Off');
  await area.fill(`${await area.inputValue()}\n\n${words(60)}`);
  await page.waitForTimeout(3000);
  expect(seen).toHaveLength(2);

  // Edited instructions (Admin → Site → Writing assistant) reach the model on the next read.
  // Leave without saving the typed text (accept the unsaved-changes prompt).
  page.once('dialog', (d) => void d.accept());
  await page.goto('/admin/site#assistant');
  const card = page.locator('#assistant');
  await card.getByLabel(/^Instructions/).fill('Only check dates and numbers.');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByTestId('assistant-note')).toContainText('Saved');
  await page.goto(`/admin/articles/${article.id}`);
  await side.getByRole('button', { name: /^Assistant/ }).click();
  await side.getByLabel('On').check();
  await side.getByRole('button', { name: 'Review now' }).click();
  await expect(list).toContainText('Fake comment 3.', { timeout: 15_000 });
  expect(seen[2].system.startsWith('Only check dates and numbers.')).toBe(true);
});
