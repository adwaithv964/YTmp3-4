/**
 * streamService.js
 *
 * Streams yt-dlp output directly to the HTTP response.
 * The user's browser starts receiving bytes immediately — no waiting for
 * the full file to be downloaded and stored on disk first.
 *
 * Supported modes:
 *   MP3  → yt-dlp (bestaudio) | FFmpeg (-f mp3) → response
 *   MP4  → yt-dlp (-f best[height<=N]) → response  (pre-merged, fastest)
 *        → yt-dlp video + audio | FFmpeg merge → response  (1080p+)
 */
import { spawn }  from 'node:child_process';
import path       from 'node:path';
import { PYTHON_CMD } from '../config.js';
import { logger }    from '../logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ffmpegBin() {
  const dir = process.env.FFMPEG_LOCATION || '';
  if (!dir) return 'ffmpeg';
  return path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

function baseYtArgs() {
  const args = [
    '-m', 'yt_dlp',
    '--no-playlist',
    '--no-update',
    '--no-cache-dir',
    '--socket-timeout', '60',
    '--js-runtimes', 'node',
  ];
  if (process.env.FFMPEG_LOCATION) {
    args.push('--ffmpeg-location', process.env.FFMPEG_LOCATION);
  }
  return args;
}

// ─── MP3 streaming ────────────────────────────────────────────────────────────

/**
 * Pipe: yt-dlp (bestaudio) → FFmpeg → response (MP3)
 */
function streamMp3(urlString, bitrate, res) {
  const ytArgs = [
    ...baseYtArgs(),
    '-f', 'bestaudio/best',
    '-o', '-',   // stdout
    '--', urlString,
  ];

  const ffArgs = [
    '-loglevel', 'error',
    '-i', 'pipe:0',           // read from stdin
    '-vn',                    // no video
    '-f', 'mp3',
    '-ab', `${bitrate || 192}k`,
    '-ar', '44100',
    '-y',
    'pipe:1',                 // write to stdout
  ];

  const ytdlp  = spawn(PYTHON_CMD, ytArgs,  { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const ffmpeg = spawn(ffmpegBin(), ffArgs, { stdio: ['pipe',   'pipe', 'pipe'], shell: false });

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);

  ytdlp.stderr.on('data',  d => logger.debug('yt-dlp stderr',  { msg: d.toString().trim() }));
  ffmpeg.stderr.on('data', d => logger.debug('ffmpeg stderr',  { msg: d.toString().trim() }));

  let errorSent = false;
  function onError(err) {
    if (errorSent) return;
    errorSent = true;
    logger.warn('Stream error', { error: err.message });
    if (!res.headersSent) res.status(500).json({ success: false, error: { message: 'Stream failed.' } });
    else res.end();
    if (!ytdlp.killed)  ytdlp.kill('SIGKILL');
    if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
  }

  ytdlp.on('error',  onError);
  ffmpeg.on('error', onError);
  ytdlp.on('close', code => { if (code !== 0) onError(new Error(`yt-dlp exit ${code}`)); });

  return { ytdlp, ffmpeg };
}

// ─── MP4 streaming ────────────────────────────────────────────────────────────


/**
 * Stream MP4 directly to response.
 * Uses ONLY pre-merged streams (no FFmpeg) for true lossless direct download.
 * quality = actual pixel height (e.g. '1608', '720', '480', '360')
 */
function streamMp4(urlString, quality, res) {
  const h = parseInt(quality, 10) || 720;

  // Priority: pre-merged mp4 -> merged mp4 -> fallback
  const formatArg = [
    `best[format_note*="${h}p"][ext=mp4]`,
    `best[height=${h}][ext=mp4]`,
    `best[height<=${h}][ext=mp4]`,
    `bestvideo[format_note*="${h}p"][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[format_note*="${h}p"]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}]+bestaudio`,
    'best',
  ].join('/');

  const ytdlp = spawn(PYTHON_CMD,
    [...baseYtArgs(), '-f', formatArg, '-o', '-', '--', urlString],
    { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', d => logger.debug('yt-dlp stderr', { msg: d.toString().trim() }));

  let errorSent = false;
  function onError(err) {
    if (errorSent) return;
    errorSent = true;
    logger.warn('Stream MP4 error', { error: err.message });
    if (!res.headersSent) res.status(500).json({ success: false, error: { message: 'Stream failed.' } });
    else res.end();
    if (!ytdlp.killed) ytdlp.kill('SIGKILL');
  }

  ytdlp.on('error', onError);
  ytdlp.on('close', code => {
    if (code !== 0) onError(new Error(`yt-dlp exit ${code}`));
  });

  return { ytdlp };
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Stream media directly to an HTTP response.
 * Caller must set Content-Disposition and Content-Type headers before calling.
 *
 * @param {string} urlString   Validated YouTube URL
 * @param {string} format      'mp3' | 'mp4'
 * @param {string} quality     'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'
 * @param {string} bitrate     MP3 bitrate ('128'|'192'|'256'|'320')
 * @param {import('express').Response} res
 * @returns Spawned process handles (for cleanup on disconnect)
 */
export function streamToResponse(urlString, format, quality, bitrate, res) {
  if (format === 'mp3') return streamMp3(urlString, bitrate, res);
  return streamMp4(urlString, quality, res);
}
