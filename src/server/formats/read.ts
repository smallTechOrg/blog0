import 'server-only';

import type { FormatAdapter } from './types';

// Read is implied by the revision itself (no article_format row).

export const readAdapter: FormatAdapter = {
  kind: 'read',
  computeStatus: ({ currentRevision }) => (currentRevision.bodyMd.trim() === '' ? 'missing' : 'ready'),
  isPublished: ({ article }) => article.status === 'published' && article.publishedRevisionId !== null,
  hasUnpublishedChanges: ({ article }) =>
    article.status === 'published' && article.currentRevisionId !== article.publishedRevisionId,
  validateForPublish: () => ({ ok: true }),
  publish: async () => {},
};
