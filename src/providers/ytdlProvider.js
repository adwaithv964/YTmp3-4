import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PYTHON_CMD, DATA_DIR } from '../config.js';

import { ProviderError, UnsupportedSourceError } from '../errors.js';
import { logger } from '../logger.js';
import { createFormatPlans } from '../services/formatPlanService.js';
import { getCommonYtdlpArgs } from '../services/cookieService.js';

// ─── Info-JSON cache ──────────────────────────────────────────────────────────
// After a successful --dump-json call, we save the raw JSON to disk so the
// download phase can pass --load-info-json and skip re-fetching YouTube's API
// entirely (avoiding 429s without routing large video bytes through the proxy).

const INFO_CACHE_DIR = path.join(DATA_DIR, 'info-cache');
const INFO_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — signed CDN URLs last ~6 h

/**
 * Save raw yt-dlp JSON to the info-cache directory.
 * Silently ignores errors (cache write failure must never break metadata).
 */
async function saveInfoCache(videoId, raw) {
  try {
    await fsp.mkdir(INFO_CACHE_DIR, { recursive: true });
    // Only store alphanumeric IDs — never write attacker-controlled filenames
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return;
    const filePath = path.join(INFO_CACHE_DIR, `${safeId}.json`);
    await fsp.writeFile(filePath, raw, 'utf8');
    logger.debug('Info-JSON cached', { videoId: safeId, path: filePath });
  } catch (e) {
    logger.warn('Failed to write info-cache (non-fatal)', { error: e.message });
  }
}

/**
 * Returns the path to a cached info-JSON file if it exists and is fresh,
 * otherwise returns null.
 *
 * Called by processingService to decide whether to use --load-info-json.
 *
 * @param {string} videoId
 * @returns {Promise<string|null>}
 */
export async function getInfoCachePath(videoId) {
  try {
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return null;
    const filePath = path.join(INFO_CACHE_DIR, `${safeId}.json`);
    const stat = await fsp.stat(filePath);
    if (Date.now() - stat.mtimeMs > INFO_CACHE_TTL_MS) {
      // Stale — delete and skip
      await fsp.unlink(filePath).catch(() => {});
      return null;
    }
    return filePath;
  } catch {
    return null; // file does not exist
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format seconds into M:SS or H:MM:SS */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Pick the best available thumbnail from yt-dlp format */
function bestThumbnail(info) {
  const thumbs = info.thumbnails;
  if (Array.isArray(thumbs) && thumbs.length > 0) {
    // Prefer thumbnails with preference closest to 0 (highest quality in yt-dlp ordering)
    const sorted = [...thumbs].sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0));
    const best = sorted.find(t => t.url && t.url.startsWith('https://'));
    if (best) return best.url;
  }
  return info.thumbnail || '';
}

/**
 * Run yt-dlp with the given arguments and return stdout as a string.
 * stderr is captured and used for error reporting only.
 *
 * SECURITY: args must NEVER include raw user input concatenated as a string.
 * Each argument is a separate array element — the shell is never invoked.
 *
 * @param {string[]} args - Arguments to pass to `python -m yt_dlp`
 * @param {number}   timeoutMs
 * @returns {Promise<string>} Raw stdout
 */
function runYtdlp(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-m', 'yt_dlp', ...getCommonYtdlpArgs(), ...args];
    const proc = spawn(PYTHON_CMD, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // never use shell
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new ProviderError('Metadata request timed out. Please try again.'));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        // Extract a user-safe error message from stderr
        const safeMsg = extractSafeError(stderr);
        logger.warn('yt-dlp non-zero exit', { code, safeMsg, rawStderr: stderr.slice(0, 300) });
        reject(new ProviderError(safeMsg));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      logger.error('Failed to spawn yt-dlp', { error: err.message });
      reject(new ProviderError('Media provider is unavailable. Please try again later.'));
    });
  });
}

/**
 * Translate yt-dlp stderr into a safe user-facing message.
 * Never expose file paths, credentials, or internal details.
 */
function extractSafeError(stderr) {
  if (!stderr) return 'The media provider returned an error.';

  if (/invalid Netscape format|cookiejar bug|CookieLoadError/i.test(stderr))
    return 'The provided YouTube cookies are invalid or corrupted. Please check your cookies formatting or re-export.';
  if (/Video unavailable|This video is not available/i.test(stderr))
    return 'This video is unavailable.';
  if (/Private video/i.test(stderr))
    return 'This video is private.';
  if (/Age.?restricted|Sign in to confirm your age/i.test(stderr))
    return 'This video is age-restricted and cannot be processed.';
  if (/members.only|Join this channel/i.test(stderr))
    return 'This video is for channel members only.';
  if (/This live event will begin/i.test(stderr))
    return 'Live premieres are not supported. Please try after the premiere ends.';
  if (/live stream|isLive/i.test(stderr))
    return 'Live streams cannot be downloaded.';
  if (/Requested format is not available/i.test(stderr))
    return 'The requested quality is not available for this video.';
  if (/HTTP Error 429|Too Many Requests/i.test(stderr))
    return 'YouTube rate-limited the request. Please wait a moment and try again.';
  if (/Sign in|bot|cookies/i.test(stderr))
    return 'YouTube requires verification for datacenter IPs. Set your YOUTUBE_COOKIES environment variable in Render dashboard.';
  if (/copyright|removed/i.test(stderr))
    return 'This video has been removed or blocked due to copyright.';

  return 'The media provider returned an error. The video may be unavailable.';
}

// ─── Quality resolution ───────────────────────────────────────────────────────

/**
 * Given the raw yt-dlp format list, return which of our quality options
 * are actually available for video.
 */
// Standard resolution tiers and labels
const TIER_ORDER = ['2160', '1440', '1080', '720', '480', '360', '240'];
const TIER_LABELS = {
  '2160': '4K Ultra HD (2160p)',
  '1440': '1440p QHD',
  '1080': '1080p Full HD',
  '720':  '720p HD',
  '480':  '480p',
  '360':  '360p',
  '240':  '240p',
};

/**
 * Classifies any YouTube format into a standard resolution tier.
 * Accounts for widescreen cinema aspect ratios (e.g. 2.39:1, 3840x1608 -> 2160p).
 */
function getFormatTier(fmt) {
  const note = String(fmt.format_note || '').toLowerCase();
  const noteMatch = note.match(/^(\d+)p/);
  if (noteMatch) {
    const p = parseInt(noteMatch[1], 10);
    if (p >= 2160) return '2160';
    if (p >= 1440) return '1440';
    if (p >= 1080) return '1080';
    if (p >= 720)  return '720';
    if (p >= 480)  return '480';
    if (p >= 360)  return '360';
    if (p >= 240)  return '240';
  }

  const w = fmt.width || 0;
  const h = fmt.height || 0;
  if (w >= 3840 || h >= 1600) return '2160';
  if (w >= 2560 || h >= 1000) return '1440';
  if (w >= 1920 || h >= 750)  return '1080';
  if (w >= 1280 || h >= 500)  return '720';
  if (w >= 854  || h >= 350)  return '480';
  if (w >= 640  || h >= 250)  return '360';
  if (w >= 426  || h >= 144)  return '240';
  return null;
}

/**
 * Returns quality options based on the ACTUAL formats yt-dlp found.
 * Groups by standard YouTube resolution tier (2160, 1440, 1080, 720, 480, 360).
 * Includes exact estimated download size in bytes.
 *
 * @param {object[]} formats  Raw yt-dlp format array from --dump-json
 * @param {number}   duration Video duration in seconds
 * @returns {QualityOption[]}
 */
function resolveAvailableVideoQualities(formats, duration) {
  if (!Array.isArray(formats) || formats.length === 0) {
    return [{ value: 'best', label: 'Best available', needsFFmpeg: true, estimatedBytes: 0 }];
  }

  const dur = duration || 0;
  function estimateSize(fmt) {
    const tbr = fmt.tbr || fmt.vbr || 0;
    if (tbr > 0 && dur > 0) return Math.round((tbr * 1000 / 8) * dur);
    return fmt.filesize || fmt.filesize_approx || 0;
  }

  // Best audio stream size for calculating merged output size
  const audioFormats = formats.filter(f =>
    (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none',
  );
  const bestAudioBytes = Math.max(0, ...audioFormats.map(estimateSize));

  // Find best format per standard tier
  const byTier = new Map();
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none') continue;
    const tier = getFormatTier(f);
    if (!tier) continue;

    const prev = byTier.get(tier);
    if (!prev) { byTier.set(tier, f); continue; }

    function score(fmt) {
      let s = 0;
      if (fmt.protocol?.startsWith('https')) s += 2000;
      if (fmt.ext === 'mp4') s += 1000;
      if (fmt.vcodec?.startsWith('avc1')) s += 800;
      if (fmt.vcodec?.startsWith('av01')) s += 600;
      if (fmt.acodec && fmt.acodec !== 'none') s += 500;
      s += (fmt.vbr || fmt.tbr || 0);
      return s;
    }

    if (score(f) > score(prev)) {
      byTier.set(tier, f);
    }
  }

  const result = [];
  for (const tier of TIER_ORDER) {
    const fmt = byTier.get(tier);
    if (!fmt) continue;

    const hasMuxedAudio = fmt.acodec && fmt.acodec !== 'none';
    const videoBytes = estimateSize(fmt);
    const estimatedBytes = hasMuxedAudio ? videoBytes : videoBytes + bestAudioBytes;

    result.push({
      value: tier,
      label: TIER_LABELS[tier] || `${tier}p`,
      estimatedBytes,
      needsFFmpeg: !hasMuxedAudio,
      formatId: fmt.format_id,
      height: fmt.height || 0,
      width: fmt.width || 0,
    });
  }

  if (result.length === 0) {
    result.push({ value: 'best', label: 'Best available', needsFFmpeg: true, estimatedBytes: 0 });
  }

  return result;
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Quickly validates that the URL points to a supported, accessible source.
 * Does not download anything. Throws on failure.
 *
 * @param {string} urlString
 */
export async function validateSource(urlString) {
  // --simulate extracts just enough info to check availability without downloading
  await runYtdlp([
    '--simulate',
    '--quiet',
    '--no-playlist',
    '--socket-timeout', '20',
    '--',          // end of options sentinel
    urlString,     // URL always last and always a separate argument
  ], 25_000);
}

/**
 * Fetches full metadata for the given URL.
 *
 * @param {string} urlString
 * @returns {Promise<import('./providerInterface.js').MediaMetadata>}
 */
export async function getMetadata(urlString) {
  let raw;
  try {
    raw = await runYtdlp([
      '--dump-json',
      '--no-download',
      '--no-playlist',
      '--no-update',
      '--js-runtimes', 'node',
      '--socket-timeout', '20',
      '--',
      urlString,
    ], 45_000);
  } catch (err) {
    throw err; // already a ProviderError with safe message
  }

  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new ProviderError('Could not parse video information. Please try again.');
  }

  // Cache the raw JSON for reuse by the download phase (--load-info-json)
  if (info.id) {
    saveInfoCache(info.id, raw); // fire-and-forget
  }

  // Reject live streams — they cannot be reliably downloaded
  if (info.is_live || info.live_status === 'is_live') {
    throw new UnsupportedSourceError('Live streams cannot be downloaded.');
  }
  if (info.live_status === 'is_upcoming') {
    throw new UnsupportedSourceError('This is a scheduled premiere. Try again after it has started.');
  }

  const qualities = resolveAvailableVideoQualities(info.formats, info.duration || 0);
  const formatPlans = createFormatPlans(info, urlString);

  const videoMeta = {
    title:          String(info.title || 'Unknown Title').slice(0, 200),
    thumbnail:      bestThumbnail(info),
    duration:       info.duration || 0,
    durationString: formatDuration(info.duration),
    uploader:       String(info.uploader || info.channel || 'Unknown').slice(0, 100),
    videoId:        String(info.id || ''),
  };

  return {
    ...videoMeta,
    video: videoMeta,
    formatPlans,
    isLive:                  false,
    availableVideoQualities: qualities,
    availableAudioBitrates:  ['128', '192', '256', '320'],
  };
}

/**
 * Returns static capability descriptor for this provider.
 *
 * @returns {import('./providerInterface.js').ProviderCapabilities}
 */
export function getCapabilities() {
  return {
    supportsVideo:    true,
    supportsAudio:    true,
    supportedFormats: ['mp4', 'mp3'],
  };
}

/**
 * Checks that yt-dlp is available via the configured Python command.
 * Called at server startup. Throws if unavailable.
 */
export async function checkAvailability() {
  try {
    const version = await runYtdlp(['--version'], 10_000);
    logger.info('yt-dlp available', { version: version.trim() });
  } catch {
    throw new Error(
      `yt-dlp is not available via '${PYTHON_CMD} -m yt_dlp'. ` +
      `Ensure Python and yt-dlp are installed. ` +
      `Install with: pip install yt-dlp`,
    );
  }
}
