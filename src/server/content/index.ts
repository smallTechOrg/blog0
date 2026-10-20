import 'server-only';

// Public surface of the content pipeline (consumed by Jev, the format adapters, articles API and
// public pages). Types live in src/lib/content/types.ts.

export { renderArticle, RENDER_VERSION } from './render';
export { getRenderedRevision, renderCacheKey, renderCacheSize, resetRenderCacheForTests, RENDER_CACHE_MAX } from './cache';
export { splitSentences, buildSentences, ABBREVIATIONS, MIN_ELIGIBLE_WORDS } from './sentences';
export { paragraphHash, plainText } from './paragraph-ids';
export { computeFingerprints, normalizeText, sha256Hex } from './fingerprint';
export { computeStats, countWords, WORDS_PER_MINUTE } from './stats';
