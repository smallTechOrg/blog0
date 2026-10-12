// Next.js boot hook: validate config (fail fast: log every problem, exit 1), open an embedded
// PGlite database before the first request, and log `app.boot` (engine, data dir, Jev key state).
// Skipped during `next build` so the build stays env-free.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { exitProcess, getConfig, runtimeInfo } = await import('./server/config');
  const { log } = await import('./server/log');

  let config;
  try {
    config = getConfig();
  } catch (error) {
    log.error('error', {
      msg: 'blog0 cannot start: invalid configuration',
      err_message: error instanceof Error ? error.message : String(error),
    });
    // Fail fast: Next.js would otherwise log the throw and keep serving.
    return exitProcess(1);
  }

  const engine = config.database;
  if (engine.engine === 'pglite') {
    // Boot the WASM backend now (≈ 0.3 s; 1.5 s on the very first initdb) instead of on the first
    // request. A damaged data dir is fatal: say how to start over.
    const { initDb } = await import('./server/db/client');
    try {
      await initDb();
    } catch (error) {
      log.error('error', {
        msg: `blog0 cannot open the embedded database at ${engine.dir} — stop other blog0 processes using it, or start over with: rm -rf ${engine.dir}`,
        err_message: error instanceof Error ? error.message : String(error),
      });
      return exitProcess(1);
    }
  }

  const { version, node } = runtimeInfo();
  log.info('app.boot', {
    msg: `blog0 ${version} booting on port ${config.port}`,
    version,
    port: config.port,
    node,
    site_slug: config.siteSlug,
    db_engine: config.dbEngine,
    ...(engine.engine === 'pglite'
      ? {
          db_dir: engine.dir,
          notice: config.databaseUrlDefaulted
            ? `BLOG0_DATABASE_URL not set — using embedded PGlite at ${engine.dir}`
            : config.isProduction
              ? `designer mode (explicit pglite:// in production) — embedded PGlite at ${engine.dir}`
              : `designer mode — embedded PGlite at ${engine.dir}`,
          session_secret: config.sessionSecretSource,
        }
      : {}),
    openrouter_key: config.openrouterApiKey === null ? 'not configured (Jev disabled)' : 'configured',
  });
}
