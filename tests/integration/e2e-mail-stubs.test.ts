// Both Playwright web servers (pnpm test:e2e on the production build, pnpm test:e2e:design on
// designer mode) must run the newsletter walks on the stubs: an empty BLOG0_SMTP_HOST (the recording
// stub transport — an already-set variable is never overridden by .env) and BLOG0_NEWSLETTER_SENDER=stub.
// A relay or Listmonk configured in .env for the dev server must never be used by the suites.
import { describe, expect, it } from 'vitest';

import mainConfig from '../../playwright.config';
import designConfig from '../../playwright.design.config';

type WebServer = { env?: Record<string, string> };
const servers = (c: { webServer?: WebServer | WebServer[] }): WebServer[] => (c.webServer === undefined ? [] : Array.isArray(c.webServer) ? c.webServer : [c.webServer]);

describe('E2E web servers force the newsletter stubs', () => {
  it.each([
    ['playwright.config.ts', mainConfig],
    ['playwright.design.config.ts', designConfig],
  ])('%s → BLOG0_SMTP_HOST empty, BLOG0_NEWSLETTER_SENDER=stub, no SMTP/Listmonk values', (_name, config) => {
    const list = servers(config as { webServer?: WebServer | WebServer[] });
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.env?.BLOG0_SMTP_HOST).toBe('');
      expect(s.env?.BLOG0_NEWSLETTER_SENDER).toBe('stub');
      expect(Object.keys(s.env ?? {}).filter((k) => /^BLOG0_(SMTP_(?!HOST$)|LISTMONK_)/.test(k))).toEqual([]);
    }
  });
});
