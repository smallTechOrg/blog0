import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { NewsletterAuditBundle, NewsletterSettingsResponse } from '@/lib/api/dto';

import { withTestDb } from './helpers/db';
import { createArticleApi, e2eAdmin, originOf, publishApi, signIn } from './helpers/admin';
import { logFileNotWired, readServerLog } from './helpers/logs';
import {
  confirmedCount,
  eventKinds,
  insertLegacySubscriber,
  latestConfirmUrl,
  messagesTo,
  NL_CONFIRM_BUTTON,
  NL_CONFIRMED,
  NL_DONE,
  NL_EXPIRED,
  NL_UNSUBSCRIBE_BUTTON,
  NL_UNSUBSCRIBED,
  pathOf,
  subscriberByEmail,
  suppressionRows,
  unsubscribeUrlIn,
} from './helpers/newsletter';

// Newsletter end to end (capabilities newsletter-list + newsletter-issues → E2E criteria), on the
// production server with the recording stubs: BLOG0_SMTP_HOST empty (stub mail transport — the
// `newsletter_message` row is the delivery) and BLOG0_NEWSLETTER_SENDER=stub (playwright.config.ts).
// One serial walk over one address: footer signup → pending with proof → confirm link → confirmed
// + timeline → link reused → exports → Site → Newsletter per post → publish → draft issue →
// preview HTML/Text → test send → send → log + stats → the issue's unsubscribe link → unsubscribed
// + suppression → re-signup starts a fresh double opt-in and keeps the history. Plus the legacy
// one-time confirmation. Runs after `smoke` (its own data; the reader walk's pending signup stays
// pending, so this walk's address is the only confirmed one).

test.describe.configure({ mode: 'serial' });

const RUN = Date.now();
const EMAIL = `nl-walk-${RUN}@example.test`;
const NAME = 'E2E Newsletter Reader';
const LEGACY_EMAIL = `nl-legacy-${RUN}@example.test`;
const ERASE_EMAIL = `nl-erase-${RUN}@example.test`;
const ARTICLE_TITLE = `Owning the list ${RUN}`;
const ARTICLE_DEK = 'Why the subscriber list lives next to the posts.';
const ARTICLE_BODY = 'A newsletter is a promise kept by email.\n\nThis post exists so the per-post issue has something to carry.\n';

/** Shared across the serial steps. */
const walk: { subscriberId: string; issueId: string; articleSlug: string; unsubscribeUrl: string; firstConfirmUrl: string } = {
  subscriberId: '',
  issueId: '',
  articleSlug: '',
  unsubscribeUrl: '',
  firstConfirmUrl: '',
};

function dd(scope: Locator, term: string): Locator {
  return scope.locator(`.admin-dl dt:text-is("${term}") + dd`);
}

async function signupInFooter(page: Page, email: string, name?: string): Promise<void> {
  await page.goto('/');
  const form = page.locator('#newsletter');
  await form.scrollIntoViewIfNeeded();
  if (name) await form.getByLabel('Name (optional)').fill(name);
  await form.getByLabel('Email').fill(email);
  await form.getByRole('button', { name: 'Subscribe' }).click();
  await expect(form.getByRole('status')).toHaveText(NL_DONE);
}

async function openSubscriber(page: Page, id: string, email: string): Promise<Locator> {
  await page.goto(`/admin/subscribers/${id}`);
  const main = page.locator('main.desk-main');
  await expect(main.getByRole('heading', { level: 1, name: email })).toBeVisible();
  return main;
}

async function settings(page: Page): Promise<NewsletterSettingsResponse> {
  const res = await page.request.get('/api/admin/newsletter/settings');
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { data: NewsletterSettingsResponse }).data;
}

test('footer signup → "Almost there"; the admin shows the address Pending with its proof of consent', async ({ page }) => {
  await page.goto('/');
  // The consent line is followed by the Privacy link (fix pass); the stored consent text is the line alone.
  const consentShown = (await page.locator('#newsletter .ft-micro').innerText()).trim().replace(/\s*Privacy$/, '');
  const browserUa = await page.evaluate(() => navigator.userAgent);

  await signupInFooter(page, EMAIL, NAME);

  const row = await subscriberByEmail(EMAIL);
  walk.subscriberId = row.id;
  expect(row).toMatchObject({ status: 'pending', signup_source_url: '/', signup_user_agent: browserUa, consent_text: consentShown });
  expect(await eventKinds(row.id)).toEqual(['signup', 'confirmation_sent']);
  const confirmations = await messagesTo(EMAIL, 'confirmation');
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toMatchObject({ transport: 'stub', status: 'stubbed' });

  await signIn(page);
  const { settings: s } = await settings(page);
  expect(row.consent_version).toBe(s.consentVersion);
  expect(row.consent_text).toBe(s.consentText);

  await page.goto('/admin/subscribers');
  const tr = page.locator('.admin-table tbody tr', { hasText: EMAIL });
  await expect(tr).toContainText(NAME);
  await expect(tr.locator('.tag')).toHaveText('Pending');

  await tr.getByRole('link', { name: EMAIL }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/subscribers/${row.id}$`));
  const main = page.locator('main.desk-main');
  await expect(main.locator('.subs-head .tag')).toHaveText('Pending');
  await expect(main.locator('.consent-quote')).toHaveText(`“${s.consentText}”`);
  await expect(dd(main, 'Consent version')).toHaveText(s.consentVersion);
  await expect(dd(main, 'Signup user agent')).toHaveText(browserUa);
  await expect(dd(main, 'Source page')).toHaveText('/');
  await expect(dd(main, 'Signup IP')).toHaveText(row.signup_ip ?? 'not recorded — no trusted proxy');
  await expect(dd(main, 'Confirmation emails sent')).toHaveText('1');
  await expect(main.getByRole('button', { name: 'Resend confirmation' })).toBeVisible();
});

test('a plain GET of the confirm link (a mail scanner) leaves the subscriber Pending and the link unspent', async ({ page }) => {
  const url = await latestConfirmUrl(EMAIL);
  walk.firstConfirmUrl = url;
  const eventsBefore = await eventKinds(walk.subscriberId);

  const res = await page.request.get(pathOf(url));
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain(NL_CONFIRM_BUTTON);
  await page.request.get(pathOf(url));

  expect((await subscriberByEmail(EMAIL)).status).toBe('pending');
  expect(await eventKinds(walk.subscriberId)).toEqual(eventsBefore);

  // The stored message never keeps the real token (fix pass); the log line / transport carried it.
  const stored = (await messagesTo(EMAIL, 'confirmation'))[0];
  expect(stored.text).toContain('/newsletter/confirm?t=[redacted]');
  expect(stored.text).not.toContain(new URL(url).searchParams.get('t')!);
});

test('pressing "Confirm my subscription" → "You’re subscribed."; the admin shows Confirmed + timeline; the spent link says so', async ({ page }) => {
  const url = walk.firstConfirmUrl;

  const res = await page.goto(pathOf(url));
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Confirm your subscription');
  await page.getByRole('button', { name: NL_CONFIRM_BUTTON }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NL_CONFIRMED);

  expect((await subscriberByEmail(EMAIL)).status).toBe('confirmed');
  // The stub sender skips the provider sync (newsletter-issues.md, Assumed S7.3): no provider_* events.
  expect(await eventKinds(walk.subscriberId)).toEqual(['signup', 'confirmation_sent', 'confirmed']);

  await signIn(page);
  const main = await openSubscriber(page, walk.subscriberId, EMAIL);
  await expect(main.locator('.subs-head .tag')).toHaveText('Confirmed');
  await expect(main.getByRole('button', { name: /confirmation/i })).toHaveCount(0);
  await expect(main.locator('.timeline__label')).toHaveText([
    'Signed up from /',
    /^Confirmation email sent/,
    'Confirmed',
  ]);
  await expect(dd(main, 'Confirmed at')).not.toHaveText('—');

  // The same link again: the page offers the button, the click reports it spent, nothing changes.
  await page.goto(pathOf(url));
  await page.getByRole('button', { name: NL_CONFIRM_BUTTON }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NL_EXPIRED);
  expect(await eventKinds(walk.subscriberId)).toHaveLength(3);
});

test('/privacy renders the seeded draft text in the site chrome and the footer consent line links to it', async ({ page }) => {
  const [row] = await withTestDb((sql) => sql<{ privacy_text: string }[]>`select privacy_text from site order by created_at limit 1`);
  const firstParagraph = row.privacy_text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  expect(firstParagraph.length).toBeGreaterThan(10);

  await page.goto('/');
  await page.locator('#newsletter .ft-micro').getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(page.locator('.abt__body')).toContainText(firstParagraph);
  await expect(page.getByText('Questions or an erasure request:')).toBeVisible();
  await expect(page.locator('#newsletter')).toBeVisible(); // site chrome (footer) is present
});

test('Export CSV and Export audit (JSON) download the confirmed address with its events and consent text', async ({ page }) => {
  await signIn(page);
  const { settings: s } = await settings(page);
  await page.goto('/admin/subscribers');
  await expect(page.locator('.admin-table tbody tr', { hasText: EMAIL })).toBeVisible();

  const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
  const [header, ...lines] = readFileSync(await csvDownload.path(), 'utf8').trim().split(/\r?\n/);
  expect(header).toBe('email,name,status,subscribed_at,confirmed_at,unsubscribed_at,source,source_url,consent_version');
  const line = lines.find((l) => l.startsWith(`${EMAIL},`));
  expect(line, `CSV row for ${EMAIL}`).toBeTruthy();
  expect(line).toContain(',confirmed,');
  expect(line).toContain(NAME);

  const [auditDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export audit (JSON)' }).click()]);
  const bundle = JSON.parse(readFileSync(await auditDownload.path(), 'utf8')) as NewsletterAuditBundle;
  expect(bundle.format).toBe('blog0-newsletter-audit/1');
  expect(bundle.exportedBy).toBe(e2eAdmin().email);
  const sub = bundle.subscribers.find((x) => x.email === EMAIL);
  expect(sub, `${EMAIL} in the audit bundle`).toBeTruthy();
  expect(sub).toMatchObject({ status: 'confirmed', sourceUrl: '/', consentText: s.consentText, consentVersion: s.consentVersion });
  expect(sub!.events.map((e) => e.kind)).toEqual(['signup', 'confirmation_sent', 'confirmed']);
  expect(sub!.events[0]).toMatchObject({ source: 'footer', details: expect.objectContaining({ sourceUrl: '/' }) });
  expect(sub!.suppressions).toEqual([]);
});

test('Site → Newsletter per post, auto-send off → publishing a new article creates one Draft issue', async ({ page }, testInfo) => {
  const origin = originOf(testInfo);
  await signIn(page);
  await page.goto('/admin/site#newsletter');
  const card = page.locator('section#newsletter');
  await expect(card.getByText('Sender:')).toHaveText('Sender: Stub — issues are recorded, not delivered');
  await expect(card.getByText('Confirmation mail:')).toContainText('Stub');
  const form = card.getByRole('form', { name: 'Newsletter settings' });
  await form.getByRole('radio', { name: /Per post/ }).check();
  const autoSend = form.getByRole('checkbox', { name: /Auto-send/ });
  await expect(autoSend).not.toBeChecked();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByText('Saved', { exact: true })).toBeVisible();
  expect((await settings(page)).settings).toMatchObject({ mode: 'per_post', autoSend: false });

  const article = await createArticleApi(page.request, origin, { title: ARTICLE_TITLE, topic: 'Notes', dek: ARTICLE_DEK, bodyMd: ARTICLE_BODY });
  walk.articleSlug = article.slug;
  await publishApi(page.request, origin, article.id, article.currentRevision.id);

  await page.goto('/admin/newsletter');
  const rows = page.locator('.admin-table tbody tr', { hasText: ARTICLE_TITLE });
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('.spill')).toHaveText('Draft');
  await expect(rows).toContainText('Per post');
  await rows.getByRole('link', { name: ARTICLE_TITLE }).click();
  await expect(page).toHaveURL(/\/admin\/newsletter\/[0-9a-f-]{36}$/);
  walk.issueId = page.url().split('/').pop()!;
  // Auto-send is off: publishing wrote no issue message.
  expect(await messagesTo(EMAIL, 'issue')).toEqual([]);
});

test('the draft previews as HTML (title + unsubscribe link) and Text; Send test to me records a [Test] message', async ({ page }) => {
  const admin = e2eAdmin();
  await signIn(page);
  await page.goto(`/admin/newsletter/${walk.issueId}`);
  const main = page.locator('main.desk-main');
  await expect(main.locator('.issue-head .spill')).toHaveText('Draft');

  const frame = main.locator('iframe.issue-preview__frame');
  await expect(frame).toHaveAttribute('srcdoc', /\/newsletter\/unsubscribe\?t=/);
  const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
  expect(srcdoc).toContain(ARTICLE_TITLE);
  expect(srcdoc).toContain(`/p/${walk.articleSlug}`);
  await expect(frame.contentFrame().getByRole('link', { name: 'Unsubscribe' })).toBeVisible();

  await main.getByRole('tab', { name: 'Text' }).click();
  const text = main.locator('pre.issue-preview__text');
  await expect(text).toContainText(ARTICLE_TITLE);
  await expect(text).toContainText(`/p/${walk.articleSlug}`);
  await expect(text).toContainText('Unsubscribe: ');

  await main.getByRole('button', { name: 'Send test to me' }).click();
  await expect(main.getByText(`Test sent to ${admin.email} (stub)`)).toBeVisible();
  const tests = await messagesTo(admin.email, 'test_issue');
  expect(tests.length).toBeGreaterThanOrEqual(1);
  expect(tests.at(-1)!.subject).toBe(`[Test] ${ARTICLE_TITLE}`);
  expect(tests.at(-1)!.issue_id).toBe(walk.issueId);
  await expect(main.locator('.issue-head .spill')).toHaveText('Draft');
  await expect(main.locator('.timeline__label').last()).toHaveText(`Test sent to ${admin.email}`);
});

test('the issue page and the Send dialog warn while the postal address is empty (Send stays enabled); saving one in Site clears the warning', async ({ page }) => {
  await signIn(page);
  const siteForm = () => page.getByRole('form', { name: 'Site settings' });
  const address = siteForm().locator('#site-newsletterPostalAddress');

  // Start from an empty address (restored at the end whatever the seed was).
  await page.goto('/admin/site');
  await expect(address).toBeVisible();
  const original = await address.inputValue();
  if (original !== '') {
    await address.fill('');
    await siteForm().getByRole('button', { name: 'Save', exact: true }).click();
    await expect(siteForm().getByText(/^Saved/)).toBeVisible();
  }
  await expect(page.getByText(/must be filled before you send/)).toBeVisible();
  await expect(page.getByText(/Review the wording — the default is a draft/)).toBeVisible();

  try {
    await page.goto(`/admin/newsletter/${walk.issueId}`);
    const main = page.locator('main.desk-main');
    const warning = main.locator('.admin-warn');
    await expect(warning).toContainText('No postal address is set');
    await main.getByRole('button', { name: 'Send', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Send to / });
    await expect(dialog.locator('.admin-warn')).toContainText('No postal address is set');
    await expect(dialog.getByRole('button', { name: 'Send now' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.goto('/admin/site');
    await address.fill('1 Example Street, Springfield');
    await siteForm().getByRole('button', { name: 'Save', exact: true }).click();
    await expect(siteForm().getByText(/^Saved/)).toBeVisible();

    await page.goto(`/admin/newsletter/${walk.issueId}`);
    await expect(main.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(main.locator('.admin-warn')).toHaveCount(0);
    await main.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('dialog', { name: /^Send to / }).locator('.admin-warn')).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  } finally {
    await page.goto('/admin/site');
    await expect(address).toBeVisible();
    await address.fill(original);
    if ((await address.inputValue()) !== (await address.evaluate((el) => (el as HTMLTextAreaElement).defaultValue))) {
      await siteForm().getByRole('button', { name: 'Save', exact: true }).click();
      await expect(siteForm().getByText(/^Saved/)).toBeVisible();
    }
  }
});

test('Send → confirm → Sent · 1 recipient, the send log, stats, and the stub message carries the unsubscribe link', async ({ page }) => {
  const recipients = await confirmedCount();
  expect(recipients, 'this walk’s address is the only confirmed one').toBe(1);
  await signIn(page);
  await page.goto(`/admin/newsletter/${walk.issueId}`);
  const main = page.locator('main.desk-main');

  await main.getByRole('button', { name: 'Send', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Send to 1 confirmed subscriber?' });
  await expect(dialog).toContainText('via the stub sender — recorded, not delivered');
  await dialog.getByRole('button', { name: 'Send now' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(main.locator('.issue-head .spill')).toHaveText('Sent · 1 recipient');
  await expect(main.getByText('Sent to 1 subscriber', { exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  const log = main.locator('section[aria-labelledby="issue-log-h"] .timeline__label');
  await expect(log).toHaveText([
    'Created',
    /^Test sent to /,
    'Send requested (1 recipient)',
    `Campaign created stub-${walk.issueId}`,
    'Campaign started',
    'Sent',
  ]);

  await main.getByRole('button', { name: 'Refresh stats' }).click();
  const stat = (label: string) => main.locator('.statbox', { has: page.locator('.statbox__label', { hasText: label }) }).locator('.statbox__n');
  await expect(stat('Recipients')).toHaveText('1');
  await expect(stat('Sent')).toHaveText('1');
  await expect(stat('Opens')).toHaveText('n/a');

  // The issue list agrees.
  await page.goto('/admin/newsletter');
  const row = page.locator('.admin-table tbody tr', { hasText: ARTICLE_TITLE });
  await expect(row.locator('.spill')).toHaveText('Sent');

  // The stub sender recorded one message for the subscriber, with their own unsubscribe link.
  const delivered = await messagesTo(EMAIL, 'issue');
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ issue_id: walk.issueId, transport: 'stub_sender', status: 'stubbed', subject: ARTICLE_TITLE });
  expect(delivered[0].html).toContain(ARTICLE_TITLE);
  const link = unsubscribeUrlIn(delivered[0].html);
  expect(link, 'unsubscribe link in the delivered HTML').not.toBeNull();
  expect(link).not.toContain('t=sample');
  expect(unsubscribeUrlIn(delivered[0].text)).toBe(link);
  walk.unsubscribeUrl = link!;

  if (!logFileNotWired()) {
    await expect
      .poll(() => readServerLog().some((l) => l.event === 'newsletter.issue' && l.issue_id === walk.issueId && l.outcome === 'sent'))
      .toBe(true);
  }
});

test('a plain GET of the issue’s unsubscribe link leaves the subscriber Confirmed; pressing "Yes, unsubscribe me" unsubscribes', async ({ page }) => {
  expect(walk.unsubscribeUrl).not.toBe('');
  const get = await page.request.get(pathOf(walk.unsubscribeUrl));
  expect(get.status()).toBe(200);
  expect(await get.text()).toContain(NL_UNSUBSCRIBE_BUTTON);
  expect((await subscriberByEmail(EMAIL)).status).toBe('confirmed');
  expect(await suppressionRows(walk.subscriberId)).toEqual([]);

  const res = await page.goto(pathOf(walk.unsubscribeUrl));
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('button', { name: NL_UNSUBSCRIBE_BUTTON })).toBeVisible();
  await page.getByRole('button', { name: NL_UNSUBSCRIBE_BUTTON }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NL_UNSUBSCRIBED);

  expect((await subscriberByEmail(EMAIL)).status).toBe('unsubscribed');
  expect(await suppressionRows(walk.subscriberId)).toEqual([{ reason: 'unsubscribed', source: 'email_link' }]);

  await signIn(page);
  const main = await openSubscriber(page, walk.subscriberId, EMAIL);
  await expect(main.locator('.subs-head .tag')).toHaveText('Unsubscribed');
  await expect(main.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0);
  await expect(main.locator('.timeline__label').last()).toHaveText('Unsubscribed via email link');
  const sup = main.locator('section[aria-labelledby="subs-sup-h"] tbody tr');
  await expect(sup).toHaveCount(1);
  await expect(sup.locator('td').nth(0)).toHaveText('unsubscribed');
  await expect(sup.locator('td').nth(1)).toHaveText('email_link');
  const issueMessage = main.locator('section[aria-labelledby="subs-msg-h"] tbody tr', { hasText: ARTICLE_TITLE });
  await expect(issueMessage).toContainText('issue');
});

test('re-signup of the unsubscribed address starts a fresh double opt-in and keeps the earlier history', async ({ page }) => {
  await signupInFooter(page, EMAIL);

  const row = await subscriberByEmail(EMAIL);
  expect(row.id).toBe(walk.subscriberId);
  expect(row.status).toBe('pending');
  const kinds = await eventKinds(walk.subscriberId);
  expect(kinds).toEqual(['signup', 'confirmation_sent', 'confirmed', 'unsubscribed', 'signup', 'confirmation_sent']);
  expect(await suppressionRows(walk.subscriberId)).toHaveLength(1); // the ledger is append-only, re-signup adds none
  // A new confirmation link, different from the first one.
  const confirmations = await messagesTo(EMAIL, 'confirmation');
  expect(confirmations).toHaveLength(2);
  const fresh = await latestConfirmUrl(EMAIL);
  expect(fresh).not.toBe(walk.firstConfirmUrl);
  expect(confirmations[1].text).toContain('/newsletter/confirm?t=[redacted]');
  expect(confirmations[1].text).not.toContain(new URL(fresh).searchParams.get('t')!);

  await signIn(page);
  const main = await openSubscriber(page, walk.subscriberId, EMAIL);
  await expect(main.locator('.subs-head .tag')).toHaveText('Pending');
  const labels = main.locator('.timeline__label');
  await expect(labels.first()).toHaveText('Signed up from /');
  await expect(labels).toContainText(['Confirmed', 'Unsubscribed via email link', 'Signed up from /', /^Confirmation email sent/]);
  await expect(main.locator('section[aria-labelledby="subs-sup-h"] tbody tr')).toHaveCount(1);
});

test('a legacy_unconfirmed subscriber gets the one-time confirmation once; the button is then spent', async ({ page }) => {
  const id = await insertLegacySubscriber(LEGACY_EMAIL, 'Legacy Reader');
  await signIn(page);

  await page.goto('/admin/subscribers');
  await expect(page.locator('.subs-legacy')).toBeVisible();
  await expect(page.locator('.admin-table tbody tr', { hasText: LEGACY_EMAIL }).locator('.tag')).toHaveText('Legacy');

  const main = await openSubscriber(page, id, LEGACY_EMAIL);
  const button = main.getByRole('button', { name: 'Send the one-time confirmation' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(main.getByText(`Confirmation sent to ${LEGACY_EMAIL} (stub)`)).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /^Already sent/);

  expect(await messagesTo(LEGACY_EMAIL, 'confirmation')).toHaveLength(1);
  expect(await eventKinds(id)).toEqual(['legacy_confirmation_sent']);
  expect((await subscriberByEmail(LEGACY_EMAIL)).status).toBe('legacy_unconfirmed');

  // Survives a reload: still spent, and the API refuses a second send.
  await page.reload();
  await expect(main.getByRole('button', { name: 'Send the one-time confirmation' })).toBeDisabled();
  await expect(main.locator('.timeline__label')).toHaveText([/^One-time legacy confirmation sent/]);
  const again = await page.request.post(`/api/admin/subscribers/${id}/send-confirmation`, { headers: { origin: new URL(page.url()).origin } });
  expect(again.status()).toBe(409);
  expect(await again.json()).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_ALREADY_SENT' } });
  expect(await messagesTo(LEGACY_EMAIL, 'confirmation')).toHaveLength(1);
});

test('Erase personal data: wrong address keeps Erase disabled; the right one erases, the admin shows the tombstone, a re-signup is Pending again', async ({ page }) => {
  await signupInFooter(page, ERASE_EMAIL, 'Erase Me');
  const url = await latestConfirmUrl(ERASE_EMAIL);
  await page.goto(pathOf(url));
  await page.getByRole('button', { name: NL_CONFIRM_BUTTON }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NL_CONFIRMED);
  const row = await subscriberByEmail(ERASE_EMAIL);
  expect(row.status).toBe('confirmed');

  await signIn(page);
  const main = await openSubscriber(page, row.id, ERASE_EMAIL);
  await main.getByRole('button', { name: 'Erase personal data' }).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`^Erase ${ERASE_EMAIL}\\?`) });
  const erase = dialog.getByRole('button', { name: 'Erase', exact: true });
  await expect(erase).toBeDisabled();
  await dialog.getByLabel('Type the address to confirm').fill('someone-else@example.test');
  await expect(erase).toBeDisabled();
  await dialog.getByLabel('Type the address to confirm').fill(ERASE_EMAIL.toUpperCase());
  await expect(erase).toBeEnabled();
  await erase.click();
  await expect(dialog).toHaveCount(0);

  await expect(main.getByText(/^Erased\. Listmonk /)).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(/^erased\+[0-9a-f]+@erased\.invalid$/);
  await expect(main.locator('.timeline__label').last()).toHaveText('Personal data erased');
  await expect(main.getByRole('button', { name: 'Erase personal data' })).toHaveCount(0);
  await expect(main).not.toContainText(ERASE_EMAIL);

  // Reloading shows the same tombstone; no row keeps the address.
  await page.reload();
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(/^erased\+[0-9a-f]+@erased\.invalid$/);
  const left = await withTestDb((sql) => sql`select id from newsletter_subscriber where lower(email) = ${ERASE_EMAIL.toLowerCase()}`);
  expect(left).toHaveLength(0);

  // The same address signing up again needs a fresh double opt-in.
  await signupInFooter(page, ERASE_EMAIL.toUpperCase());
  const again = await subscriberByEmail(ERASE_EMAIL);
  expect(again.status).toBe('pending');
  await page.goto('/admin/subscribers?status=pending');
  await expect(page.locator('.admin-table tbody tr', { hasText: ERASE_EMAIL })).toBeVisible();
});
