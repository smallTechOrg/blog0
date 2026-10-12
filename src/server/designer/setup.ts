import 'server-only';

import { existsSync } from 'node:fs';
import path from 'node:path';

import { getConfig } from '../config';
import { closeDb, initDb } from '../db/client';
import { getMigrationStatus, runMigrations } from '../db/migrate';
import { resolvePgliteDir } from '../db/pglite';
import { DEFAULT_PGLITE_DIR, describeDatabase, isMemoryPglite } from '../db/url';
import { maskEmail } from '../log';
import { adminCredentialsFromEnv, seedAdmin, SeedError } from '../seed/admin';
import { SEED_POSTS } from '../seed/posts';
import { firstAdminId, seedPosts } from '../seed/seed-posts';
import { formatSeedTldrSummary, seedTldr } from '../seed/seed-tldr';
import { seedSite } from '../seed/site';
import { DESIGNER_ADMIN_FILE, ensureDesignerAdmin } from './admin';

/**
 * Where the designer credentials are kept: var/designer-admin.txt for the default ./var/pglite;
 * `<dir>.designer-admin.txt` for any other data dir, so a second PGlite dir (e.g. the E2E one)
 * never overwrites the designer's real credentials.
 */
export function designerAdminFileFor(dir: string): string {
  const normalized = path.normalize(dir).replace(/(.)[\\/]+$/, '$1');
  if (normalized === path.normalize(DEFAULT_PGLITE_DIR)) return DESIGNER_ADMIN_FILE;
  return `${normalized}.designer-admin.txt`;
}

// `pnpm dev:design` steps 1–5 (capability designer-mode; spec/roadmap.md → designer one-liner):
// ensure the PGlite dir → migrate → seed site + designer admin (+ BLOG0_ADMIN_* when set) → seed
// the 5 posts → seed decks (fixture when no key) → close PGlite. Idempotent: a second
// run creates nothing and prints no password. Uses the app's own handle (getDb()) so the seeders
// and any service they call share ONE PGlite instance (two instances on one dir can corrupt it).

export interface DesignerSetupOptions {
  resetDesignerPassword?: boolean;
  print?: (line: string) => void;
}

export interface DesignerSetupResult {
  dataDir: string;
  migrationsApplied: string[];
  postsCreated: number;
  adminPasswordPrinted: boolean;
  decksSeeded: number;
}

export async function runDesignerSetup(options: DesignerSetupOptions = {}): Promise<DesignerSetupResult> {
  const print = options.print ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const config = getConfig();
  if (config.database.engine !== 'pglite') {
    throw new Error('dev:design runs on embedded PGlite only — BLOG0_DATABASE_URL must be pglite://<dir> or unset.');
  }
  const target = config.database;
  const dataDir = isMemoryPglite(target) ? 'memory' : resolvePgliteDir(target.dir);
  const fresh = !isMemoryPglite(target) && !existsSync(path.join(dataDir, 'PG_VERSION'));
  print(`database: ${describeDatabase(target)} (${fresh ? 'new — first boot runs initdb' : 'existing'})`);

  try {
    // 1–2. Open (creates the dir on first use) and migrate.
    const handle = await initDb();
    const applied = await runMigrations(handle);
    const status = await getMigrationStatus(handle);
    print(
      applied.length > 0
        ? `migrations: applied ${applied.join(', ')}`
        : `migrations: up to date (latest ${status.latestApplied ?? 'none'})`,
    );
    const { db } = handle;

    // 3. Site + designer admin (+ the .env admin when BLOG0_ADMIN_* are set).
    const siteResult = await seedSite(db, config.siteSlug);
    print(`site ${config.siteSlug}: ${siteResult.status === 'created' ? 'created' : 'ok'}`);
    const adminFile = designerAdminFileFor(target.dir);
    const admin = await ensureDesignerAdmin(db, siteResult.site.id, {
      resetPassword: options.resetDesignerPassword,
      file: path.resolve(process.cwd(), adminFile),
    });
    if (admin.password !== null) {
      print(
        `designer admin: ${admin.email} / ${admin.password}   ← sign in at /admin/login (${admin.status === 'created' ? 'shown once' : 'rotated'}; kept in ${adminFile})`,
      );
    } else if (admin.fileExists) {
      print(`designer admin: ${admin.email} exists (password in ${adminFile})`);
    } else {
      print(`designer admin: ${admin.email} exists, but ${adminFile} is missing — rotate with: pnpm dev:design --reset-designer-password`);
    }
    if ((process.env.BLOG0_ADMIN_EMAIL ?? '').trim() !== '' && (process.env.BLOG0_ADMIN_PASSWORD ?? '').trim() !== '') {
      try {
        const envAdmin = await seedAdmin(db, siteResult.site.id, adminCredentialsFromEnv(process.env));
        print(`admin ${maskEmail(envAdmin.email)} (BLOG0_ADMIN_*): ${envAdmin.status === 'created' ? 'created' : 'ok'}`);
      } catch (error) {
        if (!(error instanceof SeedError)) throw error;
        print(`admin from BLOG0_ADMIN_* skipped: ${error.message}`);
      }
    }

    // 4. The 5 design articles, authored by the site's first admin.
    const authorId = (await firstAdminId(db, siteResult.site.id)) ?? admin.userId;
    const posts = await seedPosts(db, siteResult.site.id, authorId);
    print(`${SEED_POSTS.length} posts: ${posts.created.length} created`);

    // 5. Decks (fixture when no key).
    const decks = await seedTldr(db, siteResult.site.id, authorId, { source: 'auto' });
    print(formatSeedTldrSummary(decks));

    return {
      dataDir,
      migrationsApplied: applied,
      postsCreated: posts.created.length,
      adminPasswordPrinted: admin.password !== null,
      decksSeeded: decks.seeded.length,
    };
  } finally {
    // 6. Close PGlite before the dev server opens the same directory (single opener per dir).
    await closeDb();
  }
}
