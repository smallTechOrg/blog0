import 'server-only';

import type { FormatAdapter } from './types';

// Listen arrives in Phase 3 (S3.3 takes this file over). Phase 1: always `unavailable`.

export const listenAdapter: FormatAdapter = {
  kind: 'listen',
  computeStatus: () => 'unavailable',
  isPublished: () => false,
  hasUnpublishedChanges: () => false,
  validateForPublish: () => ({ ok: true }),
  publish: async () => {},
};
