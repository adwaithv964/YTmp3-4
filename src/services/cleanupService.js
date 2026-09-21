import fsp from 'node:fs/promises';
import { JOBS_DIR, MAX_JOB_SECONDS } from '../config.js';
import { logger }   from '../logger.js';
import { readManifest } from './jobService.js';
import { removeJobDir, isExpired } from './storageService.js';
import { STATUS } from './jobService.js';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

/**
 * Runs a single cleanup sweep:
 * - Removes EXPIRED jobs (completed but past their TTL)
 * - Removes FAILED/CANCELLED jobs older than 30 minutes
 * - Removes orphaned directories with no valid manifest
 */
async function runCleanup() {
  let entries;
  try {
    entries = await fsp.readdir(JOBS_DIR, { withFileTypes: true });
  } catch {
    return; // jobs dir may not exist yet
  }

  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    if (!/^[0-9a-f-]{36}$/.test(jobId)) continue; // skip non-UUID dirs

    try {
      const manifest = await readManifest(jobId);

      // Orphaned directory (no manifest)
      if (!manifest) {
        await removeJobDir(jobId);
        removed++;
        continue;
      }

      // Expired completed job
      if (manifest.status === STATUS.COMPLETED && isExpired(manifest)) {
        await removeJobDir(jobId);
        removed++;
        continue;
      }

      // Failed or cancelled jobs — remove after 30 min
      if (
        (manifest.status === STATUS.FAILED || manifest.status === STATUS.CANCELLED) &&
        now - new Date(manifest.updatedAt).getTime() > 30 * 60 * 1000
      ) {
        await removeJobDir(jobId);
        removed++;
        continue;
      }

      // Stale RUNNING jobs (process died but manifest not updated) — remove after MAX_JOB_SECONDS + 60s
      if (manifest.status === STATUS.RUNNING) {
        if (now - new Date(manifest.updatedAt).getTime() > (MAX_JOB_SECONDS + 60) * 1000) {
          await removeJobDir(jobId);
          removed++;
        }
      }
    } catch {
      // Skip individual errors — don't let one bad manifest stop the whole sweep
    }
  }

  if (removed > 0) {
    logger.info('Cleanup sweep complete', { removed });
  }
}

/**
 * Starts the periodic cleanup loop.
 * Call once at server startup.
 * Returns the interval ID so callers can stop it in tests.
 */
export function startCleanup() {
  // Run once immediately after a short delay to avoid startup pressure
  const immediate = setTimeout(() => runCleanup().catch(() => {}), 10_000);

  const interval = setInterval(() => {
    runCleanup().catch(err => logger.error('Cleanup error', { error: err.message }));
  }, CLEANUP_INTERVAL_MS);

  // unref() so this interval won't prevent graceful shutdown
  interval.unref();

  logger.info('Cleanup service started', { intervalMs: CLEANUP_INTERVAL_MS });
  return interval;
}
