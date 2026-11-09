// Share helpers for the reader walk (spec/capabilities/paragraph-share.md): the six menu
// options, clipboard access, a stubbed navigator.share for mobile emulation, and the share text a
// paragraph is expected to produce (computed the same way the reader does: footnote markers
// removed, whitespace collapsed).
import type { BrowserContext, Locator, Page } from '@playwright/test';

export const BRAND = 'blog0';

/** Menu order (spec/capabilities/paragraph-share.md "Targets"). */
export const SHARE_OPTIONS = ['LinkedIn', 'X', 'WhatsApp', 'Notes', 'Notion', 'Copy link'] as const;

export const SHARE_STATUS = {
  passage: 'Copied, with a link to this passage',
  titleAndLink: 'Copied — title and link',
} as const;

/** Grants clipboard read/write for the app's origin. */
export async function grantClipboard(context: BrowserContext, baseURL: string): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin });
}

export async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Clears the clipboard so a later read proves the share wrote it. */
export async function clearClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText(''));
}

/** The visible option labels of the open `.hlmenu`, in DOM order. */
export async function menuOptionLabels(menu: Locator): Promise<string[]> {
  return (await menu.locator('.hlmenu__opt').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}

export interface NativeShareCall {
  title?: string;
  text?: string;
  url?: string;
}

/**
 * Installs a `navigator.share` stub before any page script runs. Calls are recorded on
 * `window.__blog0Shares`; `outcome: 'reject'` makes the stub reject with `new Error('x')`
 * (the menu fallback), `'resolve'` resolves (the sheet "opened").
 */
export async function stubNativeShare(context: BrowserContext, outcome: 'resolve' | 'reject'): Promise<void> {
  await context.addInitScript((mode: string) => {
    const w = window as unknown as { __blog0Shares: unknown[] };
    w.__blog0Shares = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: unknown) => {
        w.__blog0Shares.push(data);
        return mode === 'reject' ? Promise.reject(new Error('x')) : Promise.resolve();
      },
    });
  }, outcome);
}

export async function nativeShareCalls(page: Page): Promise<NativeShareCall[]> {
  return page.evaluate(() => (window as unknown as { __blog0Shares?: NativeShareCall[] }).__blog0Shares ?? []);
}

/**
 * The id of the first plain paragraph in the reading column — a `<p class="para">` with no link,
 * button, code, footnote ref or figure inside, so a click on it is a share and not something else.
 */
export async function plainParagraphId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const paras = Array.from(document.querySelectorAll<HTMLElement>('.readbody p.para[id]'));
    const plain = paras.find(
      (p) => !p.querySelector('a, button, code, sup, figure, input') && (p.textContent ?? '').trim().length > 40,
    );
    return plain?.id ?? null;
  });
  if (!id) throw new Error('no plain paragraph found in .readbody');
  return id;
}

/** `“<paragraph text>” — blog0` as the reader builds it for a paragraph share. */
export async function expectedParagraphText(paragraph: Locator, brand: string = BRAND): Promise<string> {
  const text = await paragraph.evaluate((el) => {
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('a[data-footnote-ref]').forEach((a) => (a.closest('sup') ?? a).remove());
    return clone.textContent ?? '';
  });
  return '“' + text.replace(/\s+/g, ' ').trim() + '” — ' + brand;
}
