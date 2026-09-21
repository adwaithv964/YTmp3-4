import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  jobDir, manifestPath, generateJobToken, verifyJobToken,
  calcExpiresAt, isExpired, generateOutputFilename, removeJobDir,
} from './storageService.js';
import { JOBS_DIR } from '../config.js';
import { JobNotFoundError, ForbiddenError } from '../errors.js';
import { logger } from '../logger.js';

// ─── Job status constants ─────────────────────────────────────────────────────
export const STATUS = Object.freeze({
  QUEUED:    'QUEUED',
  RUNNING:   'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED:    'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED:   'EXPIRED',
});

// ─── Manifest read / write ────────────────────────────────────────────────────

export async function writeManifest(manifest) {
  const dir = jobDir(manifest.jobId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(manifestPath(manifest.jobId), JSON.stringify(manifest, null, 2), 'utf8');
}

async function readManifest(jobId) {
  try {
    const raw = await fsp.readFile(manifestPath(jobId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a new job record on disk.
 *
 * @param {{ planId?: string, formatPlan?: object, urlString: string, format: string, quality: string, bitrate: string, title?: string }} opts
 * @returns {Promise<{ jobId: string, token: string, expiresAt: string }>}
 */
export async function createJob({ planId = null, formatPlan = null, urlString, format, quality, bitrate, title = '' }) {
  const jobId    = crypto.randomUUID();
  const token    = generateJobToken(jobId);
  const expiresAt = calcExpiresAt();

  const manifest = {
    jobId,
    token,              // stored for ownership verification — treated as secret
    planId,
    formatPlan,
    urlString,
    format,
    quality,
    bitrate,
    title,
    status:       STATUS.QUEUED,
    progress:     { percent: 0, phase: 'queued', phaseLabel: 'Queued' },
    errorCode:    null,
    errorMessage: null,
    outputFile:   generateOutputFilename(format),
    artifactReady: false,
    fileSizeBytes: 0,
    actualSizeBytes: 0,
    actualSizeFormatted: '',
    formatDetails: null,
    size: null,
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    expiresAt,
  };

  await writeManifest(manifest);
  logger.info('Job created', { jobId, planId, format, quality, bitrate });
  return { jobId, token, expiresAt };
}

/**
 * Retrieves a job, verifying the token.
 *
 * @param {string} jobId
 * @param {string} token
 * @returns {Promise<Object>} The manifest
 * @throws {JobNotFoundError | ForbiddenError}
 */
export async function getJob(jobId, token) {
  const manifest = await readManifest(jobId);
  if (!manifest) throw new JobNotFoundError();

  if (!verifyJobToken(jobId, token) || manifest.token !== token) {
    throw new ForbiddenError('Invalid job token.');
  }

  // Transparently mark expired jobs
  if (manifest.status === STATUS.COMPLETED && isExpired(manifest)) {
    await updateJobStatus(jobId, STATUS.EXPIRED);
    manifest.status = STATUS.EXPIRED;
    manifest.artifactReady = false;
  }

  return manifest;
}

/**
 * Update job status (no token check — internal use only).
 */
export async function updateJobStatus(jobId, status) {
  const manifest = await readManifest(jobId);
  if (!manifest) return;
  manifest.status    = status;
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(manifest);
}

/**
 * Update job progress (no token check — internal use only).
 */
export async function updateJobProgress(jobId, progress) {
  const manifest = await readManifest(jobId);
  if (!manifest) return;
  manifest.progress  = progress;
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(manifest);
}

/**
 * Mark a job as COMPLETED with artifact info.
 */
export async function completeJob(jobId, { fileSizeBytes, title, formatDetails, size }) {
  const manifest = await readManifest(jobId);
  if (!manifest) return;
  manifest.status        = STATUS.COMPLETED;
  manifest.artifactReady = true;
  manifest.fileSizeBytes = fileSizeBytes;
  manifest.actualSizeBytes = fileSizeBytes;
  manifest.title         = title || manifest.title;
  if (formatDetails) manifest.formatDetails = formatDetails;
  if (size) manifest.size = size;
  manifest.progress      = { percent: 100, phase: 'done', phaseLabel: 'Complete' };
  manifest.updatedAt     = new Date().toISOString();
  await writeManifest(manifest);
  logger.info('Job completed', { jobId, fileSizeBytes, formatDetails });
}

/**
 * Mark a job as FAILED with a safe error message.
 */
export async function failJob(jobId, { errorCode, errorMessage }) {
  const manifest = await readManifest(jobId);
  if (!manifest) return;
  manifest.status        = STATUS.FAILED;
  manifest.artifactReady = false;
  manifest.errorCode     = errorCode || 'PROCESSING_ERROR';
  manifest.errorMessage  = errorMessage || 'Processing failed.';
  manifest.updatedAt     = new Date().toISOString();
  // Write the FAILED manifest FIRST so the frontend can read it
  await writeManifest(manifest);
  logger.warn('Job failed', { jobId, errorCode, errorMessage });
  // Clean up only the partial output file — keep the manifest so status is readable
  try {
    const outputPath = path.join(jobDir(jobId), manifest.outputFile);
    await fsp.unlink(outputPath);
  } catch { /* file may not exist yet — ignore */ }
}

/**
 * Cancel a job. Returns the current status so the caller knows if a process
 * needs to be killed.
 *
 * @param {string} jobId
 * @param {string} token
 * @returns {Promise<string>} The status at the time of cancellation
 */
export async function cancelJob(jobId, token) {
  const manifest = await getJob(jobId, token); // throws if not found / wrong token
  const prevStatus = manifest.status;

  if ([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.EXPIRED].includes(prevStatus)) {
    return prevStatus; // already terminal — nothing to do
  }

  manifest.status    = STATUS.CANCELLED;
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(manifest);
  logger.info('Job cancelled', { jobId });

  // Caller is responsible for killing any running process
  return prevStatus;
}

/**
 * Return the full path to the job's output artifact.
 * Does NOT verify token — caller must have already verified.
 */
export async function getArtifactPath(jobId) {
  const manifest = await readManifest(jobId);
  if (!manifest || !manifest.artifactReady) return null;
  return path.join(jobDir(jobId), manifest.outputFile);
}

/**
 * List all job IDs from the jobs directory (for cleanup).
 */
export async function listAllJobIds() {
  try {
    const entries = await fsp.readdir(JOBS_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => /^[0-9a-f-]{36}$/.test(n));
  } catch {
    return [];
  }
}

/**
 * On server startup, find any jobs left in RUNNING or QUEUED state
 * (meaning the previous server crashed or was restarted) and mark them FAILED.
 * This prevents the client from polling forever with no result.
 */
export async function recoverOrphanedJobs() {
  const ids = await listAllJobIds();
  let count = 0;
  for (const jobId of ids) {
    const manifest = await readManifest(jobId);
    if (!manifest) continue;
    if (manifest.status === STATUS.RUNNING || manifest.status === STATUS.QUEUED) {
      manifest.status        = STATUS.FAILED;
      manifest.errorCode     = 'SERVER_RESTART';
      manifest.errorMessage  = 'The server restarted while your job was processing. Please try again.';
      manifest.artifactReady = false;
      manifest.updatedAt     = new Date().toISOString();
      await writeManifest(manifest);
      logger.warn('Orphaned job recovered', { jobId, wasStatus: manifest.status });
      count++;
    }
  }
  return count;
}

export { readManifest };
