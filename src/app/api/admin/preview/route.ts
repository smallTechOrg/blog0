import type { PreviewResponse } from '@/lib/api/dto';
import { previewBody } from '@/server/articles/schemas';
import { previewArticle } from '@/server/articles/service';
import { withApi } from '@/server/http/api';

// POST /api/admin/preview — live Read preview (same renderer as the public page; not cached).

export const dynamic = 'force-dynamic';

export const POST = withApi(
  {
    auth: 'admin',
    body: previewBody,
    summarizeInput: (b) => ({ titleChars: b.title.length, dekChars: b.dek.length, bodyChars: b.bodyMd.length }),
    summarizeOutput: (d) => {
      const p = d as PreviewResponse;
      return { blocks: p.blocks.length, warnings: p.warnings.length, words: p.stats.words, sentences: p.sentenceCount };
    },
  },
  async ({ body }): Promise<PreviewResponse> => previewArticle(body),
);
