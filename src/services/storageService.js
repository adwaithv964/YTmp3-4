import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { JOBS_DIR, TMP_DIR, TOKEN_SECRET, JOB_EXPIRY_MS } from '../config.js';

// ─── Initialisation ───────────────────────────────────────────────────────────

/** Create data directories synchronously at module load (safe on startup). */
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR,  { recursive: true });

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Validates a jobId is a safe UUID v4 to prevent path traversal. */
function assertSafeJobId(jobId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new Error(`Unsafe jobId rejected: ${String(jobId).slice(0, 64)}`);
  }
}

export function jobDir(jobId) {
  assertSafeJobId(jobId);
  return path.join(JOBS_DIR, jobId);
}
export function manifestPath(jobId){ return path.join(jobDir(jobId), 'manifest.json'); }
export function tmpDir()           { return TMP_DIR; }

// ─── Token helpers ────────────────────────────────────────────────────────────

/** Generate a cryptographically random hex token tied to a jobId via HMAC. */
export function generateJobToken(jobId) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const mac   = crypto.createHmac('sha256', TOKEN_SECRET).update(`${jobId}:${nonce}`).digest('hex');
  return `${nonce}.${mac}`;
}

/** Verify a token was generated for this jobId. Constant-time comparison. */
export function verifyJobToken(jobId, token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [nonce] = token.split('.');
  if (!nonce || nonce.length !== 32) return false;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(`${jobId}:${nonce}`).digest('hex');
  const actual   = token.split('.')[1] || '';
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

// ─── Unique filenames ─────────────────────────────────────────────────────────

/** Generate a safe output filename. Extension is determined by format. */
export function generateOutputFilename(format) {
  const ext = format === 'mp3' ? 'mp3' : 'mp4';
  return `output.${ext}`;
}

/**
 * Build a safe user-facing download filename from the video title.
 * Strips path separators, control characters, and limits length.
 */
export function safeFilename(title, format) {
  const ext   = format === 'mp3' ? 'mp3' : 'mp4';
  const clean = (title || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // illegal filesystem chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
  return `${clean || 'download'}.${ext}`;
}

// ─── File size check ──────────────────────────────────────────────────────────

/** Returns file size in bytes, or 0 if file doesn't exist. */
export async function getFileSizeBytes(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/** Safely remove a directory and all its contents. Ignores errors. */
export async function removeJobDir(jobId) {
  try {
    assertSafeJobId(jobId);
    await fsp.rm(jobDir(jobId), { recursive: true, force: true });
  } catch {}
}

/** Safely remove a single file. Ignores errors. */
export async function removeFile(filePath) {
  try { await fsp.unlink(filePath); } catch {}
}

// ─── Expiry ───────────────────────────────────────────────────────────────────

export function calcExpiresAt() {
  return new Date(Date.now() + JOB_EXPIRY_MS).toISOString();
}

export function isExpired(manifest) {
  return Date.now() > new Date(manifest.expiresAt).getTime();
}
