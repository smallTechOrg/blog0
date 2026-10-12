// Site settings (S2.2) against real blog0_test: GET/PATCH /api/admin/site, validation and guards,
// the reader-facing site record (getCurrentSite cache invalidated on save, so home and /about show
// the edit on next load), state surviving a cold cache, and the idempotent legacy-brand upgrade
// that `pnpm db:seed` applies to rows seeded before the brand became blog0.
// No LLM is involved anywhere in this capability.
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET as getRoute, PATCH as patchRoute } from '@/app/api/admin/site/route';
import type { SiteSettingsDto, SiteSettingsResponse } from '@/lib/api/dto-phase2';
import type { Envelope, Err } from '@/lib/api/envelope';
import { siteViewModelFrom } from '@/lib/view-models';
import { getDb } from '@/server/db/client';
import { site } from '@/server/db/schema';
import { getCurrentSite, resetCurrentSiteForTests } from '@/server/site/current';
import { SITE_DEFAULTS } from '@/server/site/defaults';
import { getSiteSettings, upgradeLegacyBrand } from '@/server/site/service';

import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';

const ORIGIN = 'http://localhost:3410';

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call<T>(
  handler: Handler,
  method: 'GET' | 'PATCH',
  opts: { cookie?: string | null; body?: unknown; origin?: string | null; rawBody?: string } = {},
): Promise<{ status: number; env: Envelope<T> }> {
  const headers: Record<string, string> = { host: 'localhost:3410' };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? ORIGIN;
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}/api/admin/site`, { method, headers, body }), { params: Promise.resolve({}) });
  return { status: res.status, env: (await res.json()) as Envelope<T> };
}

function data<T>(env: Envelope<T>): T {
  if (!env.ok) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

function err(env: Envelope<unknown>): Err['error'] {
  if (env.ok) throw new Error('expected an error envelope');
  return env.error;
}

async function siteRow() {
  const slug = (await getCurrentSite()).slug;
  const [row] = await getDb().select().from(site).where(eq(site.slug, slug)).limit(1);
  return row;
}

const patch = (who: TestLogin, body: unknown) => call<SiteSettingsResponse>(patchRoute, 'PATCH', { cookie: who.cookie, body });

let admin: TestLogin;

beforeEach(async () => {
  await resetDb();
  admin = await loginAs({ displayName: 'Site Editor' });
});

describe('GET /api/admin/site', () => {
  it('returns exactly the editable fields with the seeded values', async () => {
    const { status, env } = await call<SiteSettingsResponse>(getRoute, 'GET', { cookie: admin.cookie });

    expect(status).toBe(200);
    const expected: SiteSettingsDto = {
      tagline: SITE_DEFAULTS.tagline,
      contactEmail: 'hello@logzero.blog',
      aboutStrap: 'Less noise. More signal.',
      aboutStand: SITE_DEFAULTS.aboutStand,
      aboutBodyMd: SITE_DEFAULTS.aboutBodyMd,
      socialXUrl: null,
      socialLinkedinUrl: null,
    };
    expect(data(env).site).toEqual(expected);
  });

  it('answers 401 UNAUTHENTICATED without a session', async () => {
    const { status, env } = await call(getRoute, 'GET', { cookie: null });

    expect(status).toBe(401);
    expect(err(env).code).toBe('UNAUTHENTICATED');
  });
});

describe('PATCH /api/admin/site — happy path', () => {
  it('saves a subset, leaves the other fields alone, and the reader site shows it on next load', async () => {
    const before = await getCurrentSite(); // warm the 60 s cache, like a live server would

    const { status, env } = await patch(admin, {
      aboutStrap: '  Fewer words. Better ones.  ',
      socialXUrl: 'https://x.com/smalltech',
    });

    expect(status).toBe(200);
    const saved = data(env).site;
    expect(saved.aboutStrap).toBe('Fewer words. Better ones.');
    expect(saved.socialXUrl).toBe('https://x.com/smalltech');
    expect(saved.tagline).toBe(before.tagline);
    expect(saved.aboutBodyMd).toBe(SITE_DEFAULTS.aboutBodyMd);

    const row = await siteRow();
    expect(row.aboutStrap).toBe('Fewer words. Better ones.');
    expect(row.socialXUrl).toBe('https://x.com/smalltech');
    expect(row.wordmark).toBe('blog0');
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

    // Same process, same request cycle as home and /about: the cache was invalidated by the save.
    const current = await getCurrentSite();
    expect(current.aboutStrap).toBe('Fewer words. Better ones.');
    const vm = siteViewModelFrom(current, { topics: [], year: 2026 });
    expect(vm.aboutStrap).toBe('Fewer words. Better ones.');
    expect(vm.socialXUrl).toBe('https://x.com/smalltech');
  });

  it('rewrites the About body into paragraphs the pages render one by one', async () => {
    const body = 'First paragraph about us.\n\nSecond paragraph,\nwrapped over two lines.\n\n\nThird.';

    const { status, env } = await patch(admin, { aboutBodyMd: body, aboutStand: 'A new stand.' });

    expect(status).toBe(200);
    expect(data(env).site.aboutBodyMd).toBe(body);
    const vm = siteViewModelFrom(await getCurrentSite(), { topics: [], year: 2026 });
    expect(vm.aboutBodyParagraphs).toEqual(['First paragraph about us.', 'Second paragraph, wrapped over two lines.', 'Third.']);
    expect(vm.aboutStand).toBe('A new stand.');
  });

  it('keeps every edit across several saves by different admins, and survives a cold cache', async () => {
    const other = await loginAs({ displayName: 'Second Admin' });

    expect((await patch(admin, { tagline: 'signal over noise' })).status).toBe(200);
    expect((await patch(other, { contactEmail: 'Desk@SmallTech.in' })).status).toBe(200);
    expect((await patch(admin, { socialLinkedinUrl: 'https://www.linkedin.com/company/smalltech' })).status).toBe(200);

    resetCurrentSiteForTests(); // as after a server restart
    const settings = await getSiteSettings((await getCurrentSite()).id);
    expect(settings).toMatchObject({
      tagline: 'signal over noise',
      contactEmail: 'Desk@SmallTech.in',
      socialLinkedinUrl: 'https://www.linkedin.com/company/smalltech',
      aboutStrap: SITE_DEFAULTS.aboutStrap,
    });
  });
});

describe('PATCH /api/admin/site — edge cases', () => {
  it('clears a social URL with an empty string or null (the footer hides the icon)', async () => {
    await patch(admin, { socialXUrl: 'https://x.com/smalltech', socialLinkedinUrl: 'https://linkedin.com/company/smalltech' });

    const { status, env } = await patch(admin, { socialXUrl: '   ', socialLinkedinUrl: null });

    expect(status).toBe(200);
    expect(data(env).site).toMatchObject({ socialXUrl: null, socialLinkedinUrl: null });
    const row = await siteRow();
    expect(row.socialXUrl).toBeNull();
    expect(row.socialLinkedinUrl).toBeNull();
  });

  it('treats an empty body as "nothing to change" and writes nothing', async () => {
    const before = await siteRow();

    const { status, env } = await call<SiteSettingsResponse>(patchRoute, 'PATCH', { cookie: admin.cookie, rawBody: '' });

    expect(status).toBe(200);
    expect(data(env).site.aboutStrap).toBe(SITE_DEFAULTS.aboutStrap);
    expect((await siteRow()).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('accepts text at the maximum length and rejects one character more', async () => {
    const ok = await patch(admin, { aboutStrap: 'x'.repeat(120) });
    const tooLong = await patch(admin, { aboutStrap: 'x'.repeat(121) });

    expect(ok.status).toBe(200);
    expect(tooLong.status).toBe(400);
    expect(err(tooLong.env).code).toBe('VALIDATION_FAILED');
    expect((await siteRow()).aboutStrap).toBe('x'.repeat(120));
  });
});

describe('PATCH /api/admin/site — errors', () => {
  it('rejects an invalid email, a blank required text and a javascript: URL with field errors, writing nothing', async () => {
    const before = await siteRow();

    const { status, env } = await patch(admin, {
      contactEmail: 'not-an-email',
      aboutStrap: '   ',
      socialXUrl: 'javascript:alert(1)',
      tagline: 'would be fine on its own',
    });

    expect(status).toBe(400);
    const e = err(env);
    expect(e.code).toBe('VALIDATION_FAILED');
    const fields = (e.details as { fieldErrors: Record<string, string[]> }).fieldErrors;
    expect(Object.keys(fields).sort()).toEqual(['aboutStrap', 'contactEmail', 'socialXUrl']);
    const row = await siteRow();
    expect(row.tagline).toBe(before.tagline);
    expect(row.contactEmail).toBe(before.contactEmail);
  });

  it('refuses fields that are not editable here (wordmark, slug, timezone)', async () => {
    const { status, env } = await patch(admin, { wordmark: 'log0', aboutStrap: 'ok' });

    expect(status).toBe(400);
    expect(err(env).code).toBe('VALIDATION_FAILED');
    expect((await siteRow()).wordmark).toBe('blog0');
    expect((await siteRow()).aboutStrap).toBe(SITE_DEFAULTS.aboutStrap);
  });

  it('rejects malformed JSON and a non-object body', async () => {
    const garbled = await call(patchRoute, 'PATCH', { cookie: admin.cookie, rawBody: '{"aboutStrap":' });
    const array = await patch(admin, ['aboutStrap']);

    expect(garbled.status).toBe(400);
    expect(err(garbled.env).code).toBe('VALIDATION_FAILED');
    expect(array.status).toBe(400);
  });

  it('answers 401 without a session and 403 FORBIDDEN_ORIGIN cross-origin, changing nothing', async () => {
    const anon = await call(patchRoute, 'PATCH', { cookie: null, body: { aboutStrap: 'anon' } });
    const cross = await call(patchRoute, 'PATCH', { cookie: admin.cookie, body: { aboutStrap: 'cross' }, origin: 'https://evil.example' });
    const noOrigin = await call(patchRoute, 'PATCH', { cookie: admin.cookie, body: { aboutStrap: 'none' }, origin: null });

    expect(anon.status).toBe(401);
    expect(err(anon.env).code).toBe('UNAUTHENTICATED');
    expect(cross.status).toBe(403);
    expect(err(cross.env).code).toBe('FORBIDDEN_ORIGIN');
    expect(noOrigin.status).toBe(403);
    expect((await siteRow()).aboutStrap).toBe(SITE_DEFAULTS.aboutStrap);
  });
});

describe('legacy brand upgrade (pnpm db:seed on a Phase 1 database)', () => {
  it('turns a log0 row into blog0 once, keeps admin edits, and is a no-op on re-run', async () => {
    const slug = (await getCurrentSite()).slug;
    await getDb().update(site).set({ wordmark: 'log0', brandName: 'log0', aboutStrap: 'Edited by an admin.' }).where(eq(site.slug, slug));

    const first = await upgradeLegacyBrand(getDb(), slug);
    const afterFirst = await siteRow();
    const second = await upgradeLegacyBrand(getDb(), slug);

    expect(first).toEqual({ updated: true });
    expect(afterFirst).toMatchObject({ wordmark: 'blog0', brandName: 'blog0', aboutStrap: 'Edited by an admin.' });
    expect(second).toEqual({ updated: false });
    expect((await siteRow()).updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    resetCurrentSiteForTests();
    expect((await getCurrentSite()).wordmark).toBe('blog0');
  });

  it('does nothing for an unknown slug', async () => {
    expect(await upgradeLegacyBrand(getDb(), 'no-such-site')).toEqual({ updated: false });
  });
});
