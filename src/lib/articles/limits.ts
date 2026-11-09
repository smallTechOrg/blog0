// Article field limits (spec/api.md → PATCH /api/admin/articles/:id), shared by the server schemas
// and the editor forms. Pure + isomorphic.

export const ARTICLE_LIMITS = { title: 200, dek: 400, topic: 40, slug: 80, byline: 80, body: 200_000 } as const;
