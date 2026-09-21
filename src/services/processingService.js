import { spawn }   from 'node:child_process';
import path         from 'node:path';
import fsp          from 'node:fs/promises';
import { PYTHON_CMD, MAX_JOB_SECONDS, MAX_OUTPUT_BYTES } from '../config.js';
import { logger }   from '../logger.js';
import {
  updateJobStatus, updateJobProgress, completeJob, failJob,
  STATUS, readManifest, writeManifest,
} from './jobService.js';
import { jobDir, getFileSizeBytes, removeFile } from './storageService.js';
import { validateMediaFile } from './mediaValidationService.js';
import { getDownloadYtdlpArgs } from './cookieService.js';
import { getInfoCachePath } from '../providers/ytdlProvider.js';

// ─── YouTube ID extraction ─────────────────────────────────────────────────────
// Parses the 11-character video ID from any YouTube URL format.
// Returns null if not a recognized YouTube URL.
function extractYouTubeId(urlString) {
  try {
    const url = new URL(urlString);
    // youtu.be/VIDEOID
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    // youtube.com/watch?v=VIDEOID
    const v = url.searchParams.get('v');
    if (v) return v;
    // youtube.com/shorts/VIDEOID or /embed/VIDEOID
    const m = url.pathname.match(/\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
  } catch { /* invalid URL */ }
  return null;
}

// ─── Active process registry ──────────────────────────────────────────────────
// Maps jobId → ChildProcess so we can kill on cancellation.
const activeProcesses = new Map();

// ─── Progress throttle ────────────────────────────────────────────────────────
// Prevents concurrent manifest read/write race conditions on Windows file system.
const _lastProgressTs = new Map(); // jobId → timestamp

async function throttledProgress(jobId, progress) {
  const now = Date.now();
  if (now - (_lastProgressTs.get(jobId) || 0) < 2000) return; // max 1 update / 2s
  _lastProgressTs.set(jobId, now);
  await updateJobProgress(jobId, progress).catch(() => {});
}

// ─── Format argument builders ─────────────────────────────────────────────────

/**
 * Build yt-dlp format selector for video.
 * quality = standard resolution tier (e.g. '2160', '1440', '1080', '720', '480', '360') or 'best'.
 *
 * Priority order:
 *   1. Pre-merged mp4 stream if available (fastest direct download — no FFmpeg)
 *   2. Exact tier format note (e.g. 1080p, 720p) with MP4 preference (lossless stream copy)
 *   3. Aspect-ratio tolerant height window with MP4 preference
 */
function buildVideoFormatArg(quality) {
  if (quality === 'best') {
    return [
      'bestvideo[ext=mp4]+bestaudio[ext=m4a]',
      'bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]',
      'bestvideo+bestaudio',
      'best',
    ].join('/');
  }

  const h = parseInt(quality, 10);
  if (!h) {
    return 'bestvideo+bestaudio/best';
  }

  const minH = Math.round(h * 0.7);
  return [
    `best[format_note*="${h}p"][ext=mp4]`,
    `best[height=${h}][ext=mp4]`,
    `bestvideo[format_note*="${h}p"][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[format_note*="${h}p"]+bestaudio[ext=m4a]`,
    `bestvideo[format_note*="${h}p"]+bestaudio`,
    `bestvideo[height<=${h}][height>${minH}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}][height>${minH}]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}][height>${minH}]+bestaudio`,
    `bestvideo[height<=${h}]+bestaudio`,
    'best',
  ].join('/');
}

/**
 * Build the complete yt-dlp argument array for a given job manifest.
 * SECURITY: urlString is the last argument and always a separate array element.
 * No user-supplied value is ever concatenated into a string passed to the shell.
 *
 * @param {Object} manifest
 * @param {string} outputPath
 * @param {string|null} infoCachePath  - Path to --load-info-json file (or null)
 */
function buildArgs(manifest, outputPath, infoCachePath = null) {
  const { format, quality, bitrate, urlString, formatPlan } = manifest;
  const args = [
    '-m', 'yt_dlp',
    ...getDownloadYtdlpArgs(),

    '--no-playlist',
    '--socket-timeout', '30',
    '--retries', '10',
    '--fragment-retries', '10',
    '--no-mtime',
    '--no-cache-dir',
    '--no-update',
    '--js-runtimes', 'node',
    '-o', outputPath,
  ];

  // Tell yt-dlp exactly where FFmpeg is (survives terminal PATH changes)
  if (process.env.FFMPEG_LOCATION) {
    args.push('--ffmpeg-location', process.env.FFMPEG_LOCATION);
  }

  // If we have a fresh info-JSON from the metadata call, load it so yt-dlp
  // skips re-fetching YouTube's API entirely (no 429, no proxy bandwidth used).
  // The URL is still passed as a positional argument for safety/fallback.
  if (infoCachePath) {
    args.push('--load-info-json', infoCachePath);
  }

  if (format === 'mp3') {
    const audioFmt = formatPlan?.audio?.sourceFormatId;
    if (formatPlan && (!audioFmt || ['best', 'bestaudio', 'bestaudio/best', 'bestvideo+bestaudio'].includes(audioFmt))) {
      throw new Error(`Invalid MP3 source format ID: "${audioFmt}". Concrete format ID required by immutable plan.`);
    }
    const finalAudioFmt = audioFmt || 'bestaudio';
    const audioBitrate = formatPlan?.audio?.outputBitrateKbps || bitrate || 192;

    if (formatPlan) {
      logger.info(
        `\n[MP3 DOWNLOAD]\n` +
        `Requested source format: ${finalAudioFmt}\n` +
        `Dynamic selector used: NO\n` +
        `Fallback selector used: NO\n`
      );
    }

    args.push(
      '-f', finalAudioFmt,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', `${audioBitrate}K`,
    );
  } else {
    // MP4
    if (formatPlan?.video?.formatId) {
      const vId = formatPlan.video.formatId;
      const aId = formatPlan.audio?.formatId;
      if (aId) {
        // Separate streams: exact video format ID + exact audio format ID
        // Lossless stream-copy merge into MP4 container
        args.push(
          '-f', `${vId}+${aId}`,
          '--merge-output-format', 'mp4',
        );
      } else {
        // Combined stream: download directly without FFmpeg merge
        args.push('-f', vId);
      }
    } else {
      // Legacy fallback
      args.push(
        '-f', buildVideoFormatArg(quality),
        '--merge-output-format', 'mp4',
      );
    }
  }

  // URL is always the last, always a separate element — never interpolated
  args.push('--', urlString);

  return args;
}

// ─── Progress parsing ─────────────────────────────────────────────────────────

const DOWNLOAD_PROGRESS_RE = /\[download\]\s+(\d+\.?\d*)%/;

function parseProgress(line) {
  const dlMatch = line.match(DOWNLOAD_PROGRESS_RE);
  if (dlMatch) {
    return { percent: Math.min(99, Math.round(parseFloat(dlMatch[1]))), phase: 'downloading', phaseLabel: 'Downloading' };
  }
  if (/\[Merger\]/i.test(line)) {
    return { percent: 95, phase: 'merging', phaseLabel: 'Merging streams' };
  }
  if (/\[ExtractAudio\]/i.test(line) || /\[ffmpeg\]/i.test(line)) {
    return { percent: 97, phase: 'converting', phaseLabel: 'Converting audio' };
  }
  return null;
}

// ─── Main processor ───────────────────────────────────────────────────────────

/**
 * Processes a job asynchronously.
 * Fire-and-forget — updates manifest at each stage; client polls.
 *
 * @param {string} jobId
 */
export async function processJob(jobId) {
  const manifest = await readManifest(jobId);
  if (!manifest) {
    logger.error('processJob: manifest not found', { jobId });
    return;
  }

  // Transition to RUNNING
  await updateJobStatus(jobId, STATUS.RUNNING);
  await updateJobProgress(jobId, { percent: 2, phase: 'downloading', phaseLabel: 'Downloading' });

  const dir        = jobDir(jobId);
  const outputPath = path.join(dir, manifest.outputFile);

  // Check for a freshly-cached info-JSON (written during the /metadata call).
  // If present, yt-dlp will use it instead of re-fetching the YouTube page,
  // which eliminates the API call that would otherwise trigger a 429.
  const videoId = extractYouTubeId(manifest.urlString);
  const infoCachePath = videoId ? await getInfoCachePath(videoId) : null;
  if (infoCachePath) {
    logger.info('Using cached info-JSON for download (no YouTube API re-fetch)', { jobId, videoId });
  } else {
    logger.info('No info-cache available — yt-dlp will re-fetch YouTube page', { jobId });
  }

  const args = buildArgs(manifest, outputPath, infoCachePath);
  logger.info('Spawning yt-dlp', { jobId, format: manifest.format, quality: manifest.quality });

  // ── Run yt-dlp ─────────────────────────────────────────────────────────────
  let processFailed = false;
  let failReason    = { errorCode: 'PROCESSING_ERROR', errorMessage: 'Processing failed. Please try again.' };

  await new Promise((resolve) => {
    const proc = spawn(PYTHON_CMD, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    activeProcesses.set(jobId, proc);
    let stderr = '';

    proc.stdout.on('data', chunk => {
      chunk.toString('utf8').split('\n').forEach(line => {
        const p = parseProgress(line);
        if (p) throttledProgress(jobId, p);
      });
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      stderr += text;
      text.split('\n').forEach(line => {
        const p = parseProgress(line);
        if (p) throttledProgress(jobId, p);
      });
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      processFailed = true;
      failReason = { errorCode: 'TIMEOUT', errorMessage: 'Processing timed out. The video may be too large.' };
      resolve();
    }, MAX_JOB_SECONDS * 1000);

    proc.on('close', code => {
      clearTimeout(timeout);
      activeProcesses.delete(jobId);
      if (code !== 0) {
        processFailed = true;
        logger.warn('yt-dlp non-zero exit', { jobId, code, stderr: stderr.slice(-1000) });
        failReason = { errorCode: 'YTDLP_ERROR', errorMessage: extractSafeError(stderr) };
      }
      resolve();
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      activeProcesses.delete(jobId);
      processFailed = true;
      failReason = { errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: 'The media provider is currently unavailable.' };
      logger.error('Failed to spawn yt-dlp', { jobId, error: err.message });
      resolve();
    });
  });

  // ── Check if job was cancelled while running ───────────────────────────────
  const afterRun = await readManifest(jobId);
  if (!afterRun || afterRun.status === STATUS.CANCELLED) {
    await removeFile(outputPath);
    _lastProgressTs.delete(jobId);
    return;
  }

  // ── Handle yt-dlp failure ─────────────────────────────────────────────────
  if (processFailed) {
    await failJob(jobId, failReason);
    _lastProgressTs.delete(jobId);
    return;
  }

  // ── Verify output file ────────────────────────────────────────────────────
  let actualOutputFile = manifest.outputFile;
  let fullOutputPath   = path.join(dir, actualOutputFile);
  let sizeBytes        = await getFileSizeBytes(fullOutputPath);

  if (sizeBytes === 0) {
    // yt-dlp may have used a slightly different filename — scan the job directory
    let foundFile = null;
    try {
      const files = await fsp.readdir(dir);
      const ext = manifest.format === 'mp3' ? '.mp3' : '.mp4';
      // Prefer exact extension match
      foundFile = files.find(f => f !== 'manifest.json' && !f.endsWith('.part') && !f.endsWith('.ytdl') && f.endsWith(ext));
      if (!foundFile) {
        // Accept any non-manifest, non-partial file
        foundFile = files.find(f => f !== 'manifest.json' && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.json'));
      }
    } catch { /* ignore readdir errors */ }

    if (foundFile) {
      actualOutputFile = foundFile;
      fullOutputPath   = path.join(dir, actualOutputFile);
      sizeBytes        = await getFileSizeBytes(fullOutputPath);
    }
  }

  if (sizeBytes === 0) {
    await failJob(jobId, {
      errorCode:    'EMPTY_OUTPUT',
      errorMessage: 'No output file was produced. FFmpeg may be missing — install it with: winget install ffmpeg',
    });
    _lastProgressTs.delete(jobId);
    return;
  }

  if (sizeBytes > MAX_OUTPUT_BYTES) {
    await failJob(jobId, { errorCode: 'FILE_TOO_LARGE', errorMessage: 'The output file exceeds the maximum allowed size.' });
    await removeFile(fullOutputPath);
    _lastProgressTs.delete(jobId);
    return;
  }

  // Update manifest with actual filename if it changed
  if (actualOutputFile !== manifest.outputFile) {
    const m = await readManifest(jobId);
    if (m) { m.outputFile = actualOutputFile; await writeManifest(m); }
  }

  // ── Media Validation (ffprobe & format plan consistency) ──────────────────
  let validationResult;
  try {
    const planToValidate = manifest.formatPlan || {
      planId: manifest.jobId,
      type: manifest.format,
      quality: {
        label: `${manifest.quality}p`,
        width: 0,
        height: parseInt(manifest.quality, 10) || 0,
        fps: 30,
      },
      video: { codecName: 'H.264' },
      audio: { codecName: 'AAC', outputBitrateKbps: parseInt(manifest.bitrate, 10) || 192 },
      output: { estimatedBytes: 0, estimatedFormatted: '' },
    };
    validationResult = await validateMediaFile(fullOutputPath, planToValidate);
  } catch (valErr) {
    logger.error('Media validation failed', { jobId, error: valErr.message, code: valErr.code });
    await failJob(jobId, {
      errorCode:    valErr.code || 'MEDIA_VALIDATION_FAILED',
      errorMessage: valErr.message || 'Media validation failed. The generated file was invalid.',
    });
    _lastProgressTs.delete(jobId);
    return;
  }

  // ── Mark completed with authoritative measurements ────────────────────────
  const plan = manifest.formatPlan;
  const finalSizeMetrics = {
    sourceVideoBytes:          plan?.sourceVideoBytes ?? null,
    sourceAudioBytes:          plan?.sourceAudioBytes ?? null,
    sourceVideoSizeConfidence: plan?.sourceVideoSizeConfidence ?? 'unavailable',
    sourceAudioSizeConfidence: plan?.sourceAudioSizeConfidence ?? 'unavailable',
    estimatedFinalBytes:       plan?.estimatedFinalBytes ?? plan?.output?.estimatedBytes ?? null,
    estimatedFinalConfidence:  plan?.estimatedFinalConfidence ?? plan?.output?.confidence ?? 'unavailable',
    estimatedBytes:            plan?.estimatedFinalBytes ?? plan?.output?.estimatedBytes ?? null,
    estimatedFormatted:        plan?.output?.estimatedFormatted || '',
    actualFinalBytes:          validationResult.actualBytes,
    actualBytes:               validationResult.actualBytes,
    actualFormatted:           validationResult.actualFormatted,
    differenceBytes:           validationResult.differenceBytes,
    differencePercent:         validationResult.differencePercent,
  };

  await completeJob(jobId, {
    fileSizeBytes: validationResult.actualBytes,
    title:         manifest.title,
    formatDetails: validationResult.formatDetails,
    size:          finalSizeMetrics,
  });
  _lastProgressTs.delete(jobId);
}

// ─── Cancellation ─────────────────────────────────────────────────────────────

/**
 * Kill the running process for a job (if any).
 * jobService.cancelJob must be called first to update the manifest.
 */
export function killProcess(jobId) {
  const proc = activeProcesses.get(jobId);
  if (proc) {
    try { proc.kill('SIGKILL'); } catch {}
    activeProcesses.delete(jobId);
  }
  _lastProgressTs.delete(jobId);
}

// ─── Safe error extraction ────────────────────────────────────────────────────

function extractSafeError(stderr) {
  if (!stderr) return 'Processing failed.';
  if (/Video unavailable/i.test(stderr))             return 'This video is unavailable.';
  if (/Private video/i.test(stderr))                 return 'This video is private.';
  if (/Age.?restricted/i.test(stderr))               return 'This video is age-restricted.';
  if (/members.only/i.test(stderr))                  return 'This video is for members only.';
  if (/live stream|isLive/i.test(stderr))            return 'Live streams cannot be downloaded.';
  if (/Requested format is not available/i.test(stderr)) return 'The requested quality is unavailable for this video.';
  if (/HTTP Error 429/i.test(stderr))                return 'YouTube rate-limited the request. Please try again in a minute.';
  if (/Sign in|bot|cookies/i.test(stderr))           return 'YouTube requires sign-in for this video.';
  if (/ffmpeg/i.test(stderr) && /not found|No such file|cannot find/i.test(stderr))
    return 'FFmpeg is required but not installed. Run: winget install ffmpeg';
  return 'Processing failed. The video may be unavailable or an error occurred.';
}
