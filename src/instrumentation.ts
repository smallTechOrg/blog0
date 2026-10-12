// Next.js boot hook: validate config (fail fast: log every problem, exit 1) and log `app.boot`.
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

  const { version, node } = runtimeInfo();
  log.info('app.boot', {
    msg: `blog0 ${version} booting on port ${config.port}`,
    version,
    port: config.port,
    node,
    site_slug: config.siteSlug,
  });
}
