import './scripts/lib/allow-server-only'; // schema.ts imports 'server-only'

import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only diffs src/server/db/schema.ts against the migrations folder;
// it needs no database connection. The URL is passed through for `drizzle-kit studio`/`check`.
loadEnvConfig(process.cwd());

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dbCredentials: { url: process.env.BLOG0_DATABASE_URL ?? 'postgres://sai@localhost:5432/blog0_dev' },
  strict: true,
  verbose: true,
});
