// Direct reads of blog0_test from the E2E workers (the server under test writes it).
import postgres from 'postgres';

function testDatabaseUrl(): string {
  const url = (process.env.BLOG0_TEST_DATABASE_URL ?? '').trim();
  if (!url) throw new Error('BLOG0_TEST_DATABASE_URL is not set');
  return url;
}

export async function withTestDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(testDatabaseUrl(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Every ai_generation row for an article (status, model, prompt version, tokens). */
export async function generationRows(articleId: string): Promise<
  Array<{ id: string; status: string; model: string; prompt_version: string; total_tokens: number | null }>
> {
  return withTestDb(
    (sql) => sql`
      select id, status, model, prompt_version, total_tokens
      from ai_generation where article_id = ${articleId} order by started_at`,
  );
}
