// Direct-to-schema article seeding for the public (reader) integration tests: rows are inserted
// with the schema (no articles service) and every revision is rendered with the real pipeline, so
// fingerprints/stats match what a save would compute.
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { renderArticle } from '@/server/content';
import { getDb } from '@/server/db/client';
import { appUser, article, articleFormat, articleRevision } from '@/server/db/schema';

export type Rendered = Awaited<ReturnType<typeof renderArticle>>;

/** The site's seed writer (created on first use; one per site). */
export async function seedUser(siteId: string): Promise<string> {
  const [u] = await getDb()
    .insert(appUser)
    .values({ siteId, email: `w-${siteId.slice(0, 8)}@example.test`, displayName: 'Writer', passwordHash: '$x$' })
    .onConflictDoNothing()
    .returning({ id: appUser.id });
  if (u) return u.id;
  const [existing] = await getDb().select({ id: appUser.id }).from(appUser).where(eq(appUser.siteId, siteId));
  return existing.id;
}

async function insertRevision(input: { siteId: string; articleId: string; number: number; title: string; dek: string; bodyMd: string; by: string }) {
  const { by, ...values } = input;
  const r = await renderArticle({ title: input.title, dek: input.dek, bodyMd: input.bodyMd });
  const [rev] = await getDb()
    .insert(articleRevision)
    .values({
      ...values,
      bodyFingerprint: r.fingerprints.body,
      paragraphsFingerprint: r.fingerprints.paragraphs,
      sentencesFingerprint: r.fingerprints.sentences,
      wordCount: r.stats.words,
      eligibleSentenceCount: r.sentences.length,
      createdBy: by,
    })
    .returning();
  return { rev, rendered: r };
}

export interface SeedArticle {
  siteId: string;
  slug: string;
  title: string;
  dek?: string;
  topic?: string;
  bylineName?: string;
  bodyMd: string;
  status?: 'draft' | 'submitted' | 'approved' | 'published';
  firstPublishedAt?: Date | null;
  lastPublishedAt?: Date | null;
  inProgress?: boolean;
  /** Published TLDR payload (raw jsonb), or null for none. */
  deck?: unknown;
  /** Draft TLDR payload (never visible to readers). */
  draftDeck?: unknown;
  /** A later, unpublished revision (title/body) saved after publishing. */
  laterEdit?: { title: string; bodyMd: string };
  /** When false the article never had a published revision. */
  withPublishedRevision?: boolean;
  /** Listen payloads (raw jsonb): published and/or draft; omitted → no listen row. */
  listen?: { published?: unknown; draft?: unknown };
}

/** One article (revision 1 = the published one unless withPublishedRevision is false) + optional format rows. */
export async function seedArticle(a: SeedArticle) {
  const { siteId } = a;
  const by = await seedUser(siteId);
  const status = a.status ?? 'published';
  const firstPublishedAt = a.firstPublishedAt === undefined ? (status === 'published' ? new Date() : null) : a.firstPublishedAt;
  const [row] = await getDb()
    .insert(article)
    .values({
      siteId,
      slug: a.slug,
      status,
      topic: a.topic ?? 'Analysis',
      bylineName: a.bylineName ?? 'Sai Krishna V',
      createdBy: by,
      inProgress: a.inProgress ?? false,
      firstPublishedAt,
      lastPublishedAt: a.lastPublishedAt === undefined ? firstPublishedAt : a.lastPublishedAt,
    })
    .returning();
  const dek = a.dek ?? 'A short standfirst.';
  const first = await insertRevision({ siteId, articleId: row.id, number: 1, title: a.title, dek, bodyMd: a.bodyMd, by });
  const later = a.laterEdit
    ? await insertRevision({ siteId, articleId: row.id, number: 2, title: a.laterEdit.title, dek, bodyMd: a.laterEdit.bodyMd, by })
    : null;
  const publishedRevisionId = a.withPublishedRevision === false ? null : first.rev.id;
  await getDb()
    .update(article)
    .set({ currentRevisionId: (later ?? first).rev.id, publishedRevisionId })
    .where(eq(article.id, row.id));
  const formats: Array<[string, { draft?: unknown; published?: unknown } | undefined]> = [
    ['tldr', a.deck !== undefined || a.draftDeck !== undefined ? { draft: a.draftDeck, published: a.deck } : undefined],
    ['listen', a.listen],
  ];
  for (const [kind, f] of formats) {
    if (!f) continue;
    await getDb()
      .insert(articleFormat)
      .values({
        siteId,
        articleId: row.id,
        kind,
        draftPayload: f.draft ?? null,
        publishedPayload: f.published ?? null,
        publishedRevisionId: f.published ? first.rev.id : null,
        publishedAt: f.published ? new Date() : null,
      });
  }
  return { id: row.id, revisionId: first.rev.id, rendered: first.rendered, laterRendered: later?.rendered ?? null };
}

/** A deck payload built from the rendered article's own sentences. */
export function deckFrom(rendered: Rendered, picks: number[], sources?: Array<'jev' | 'writer'>, extra: { reason?: string; generationId?: string | null } = {}) {
  return {
    slides: picks.map((i, k) => ({
      sid: rendered.sentences[i].sid,
      text: rendered.sentences[i].text,
      source: sources?.[k] ?? 'jev',
      reason: extra.reason ?? 'because',
    })),
    generationId: extra.generationId ?? null,
  };
}

/** An uploaded-and-published Listen payload (spec/data.md) with no stored marks unless given. */
export function listenPayload(
  durationMs: number,
  opts: { ext?: 'mp3' | 'm4a'; bytes?: number; fp?: string; marks?: Array<{ pid: string; tMs: number }> } = {},
) {
  const ext = opts.ext ?? 'mp3';
  return {
    audio: {
      assetId: randomUUID(),
      key: `blog0/audio/2026/10/${randomUUID()}.${ext}`,
      mimeType: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4',
      bytes: opts.bytes ?? 1234,
      durationMs,
    },
    marks: opts.marks ?? [],
    syncFingerprint: null,
    uploadFingerprint: opts.fp ?? 'fp-upload',
  };
}

/** 09:00 Asia/Kolkata on 2026-09-<n>. */
export const day = (n: number) => new Date(Date.UTC(2026, 8, n, 3, 30));
