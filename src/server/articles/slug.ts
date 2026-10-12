import 'server-only';

// Slugs (spec/data.md → article.slug): `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 80, unique per site,
// derived from the title with `-2`, `-3`… on collision; locked once first published.

export const SLUG_MAX = 80;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FALLBACK_SLUG = 'article';

function trimToMax(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > max / 2 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
}

/** "AI is Expensive — Part 2!" → "ai-is-expensive-part-2" (diacritics folded, ≤ 80 chars). */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = trimToMax(base, SLUG_MAX);
  return slug === '' ? FALLBACK_SLUG : slug;
}

/** First of `base`, `base-2`, `base-3`… not in `taken` (each ≤ 80 chars). */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${trimToMax(base, SLUG_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX && SLUG_RE.test(slug);
}
