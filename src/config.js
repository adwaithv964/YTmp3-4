import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ─── Allowed sources ──────────────────────────────────────────────────────────
export const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
]);

// ─── Allowed output options ───────────────────────────────────────────────────
export const ALLOWED_FORMATS = new Set(['mp4', 'mp3']);

// Quality is now any actual video height (e.g. 360, 480, 720, 1080, 1608, 2160…)
// Validated server-side as a positive integer ≤ 9999.
export const ALLOWED_QUALITIES_LEGACY = new Set(['best', '360', '480', '720', '1080', '1440', '2160']);
export function isValidQuality(q) {
  if (q === 'best') return true;
  const n = parseInt(q, 10);
  return Number.isInteger(n) && n >= 144 && n <= 9999 && String(n) === q;
}


export const ALLOWED_BITRATES = new Set(['128', '192', '256', '320']);

// ─── Quality metadata for UI ─────────────────────────────────────────────────
export const QUALITY_LABELS = {
  best:  'Best available',
  '360': '360p SD',
  '480': '480p SD',
  '720': '720p HD',
  '1080': '1080p Full HD',
  '1440': '1440p 2K',
  '2160': '2160p 4K',
};

// ─── Server ───────────────────────────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const HOST = process.env.HOST || '0.0.0.0';

// ─── Origins ──────────────────────────────────────────────────────────────────
export const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ─── Storage ──────────────────────────────────────────────────────────────────
export const DATA_DIR     = process.env.DATA_DIR || path.join(root, 'data');
export const JOBS_DIR     = path.join(DATA_DIR, 'jobs');
export const TMP_DIR      = path.join(DATA_DIR, 'tmp');

// ─── Limits ───────────────────────────────────────────────────────────────────
export const MAX_OUTPUT_BYTES  = parseInt(process.env.MAX_OUTPUT_BYTES || String(500 * 1024 * 1024), 10);
export const MAX_JOB_SECONDS   = parseInt(process.env.MAX_JOB_SECONDS  || '300', 10);
export const JOB_EXPIRY_MS     = parseInt(process.env.JOB_EXPIRY_MINUTES || '60', 10) * 60 * 1000;

// ─── Security ─────────────────────────────────────────────────────────────────
// If not set, a random secret is generated at startup (tokens won't survive restarts).
// For production, always set this in the environment.
import { randomBytes } from 'node:crypto';
export const TOKEN_SECRET = process.env.DOWNLOAD_TOKEN_SECRET || randomBytes(32).toString('hex');

// ─── Runtime ──────────────────────────────────────────────────────────────────
export const PYTHON_CMD = process.env.PYTHON_CMD || 'python3';
export const LOG_LEVEL  = process.env.LOG_LEVEL  || 'info';

// ─── Cloud & YouTube Anti-Bot Options ─────────────────────────────────────────
export const COOKIES_FILE          = process.env.COOKIES_FILE || '';
export const YOUTUBE_COOKIES       = process.env.YOUTUBE_COOKIES || '';
export const YTDLP_PROXY           = process.env.YTDLP_PROXY || process.env.HTTP_PROXY || '';
export const YTDLP_EXTRACTOR_ARGS  = process.env.YTDLP_EXTRACTOR_ARGS || '';

// ─── Private IP regex used by SSRF protection ─────────────────────────────────
// Covers loopback, RFC-1918, link-local, CGNAT, documentation ranges.
export const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/i;
