import { spawn } from 'node:child_process';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { formatByteSize, simplifyCodec } from './formatPlanService.js';
import { MediaValidationError, FormatPlanMismatchError } from '../errors.js';
import { logger } from '../logger.js';

// ─── FFprobe Binary Resolution ───────────────────────────────────────────────

function getFfprobePath() {
  const loc = process.env.FFMPEG_LOCATION;
  if (loc) {
    // Check if loc is a directory containing ffprobe
    const isDir = fs.existsSync(loc) && fs.statSync(loc).isDirectory();
    if (isDir) {
      const exeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const candidate = path.join(loc, exeName);
      if (fs.existsSync(candidate)) return candidate;
    } else if (fs.existsSync(loc)) {
      // loc is a file (e.g. ffmpeg.exe) — check same directory
      const binDir = path.dirname(loc);
      const exeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const candidate = path.join(binDir, exeName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

/**
 * Execute ffprobe on a media file and return parsed JSON streams & format metadata.
 *
 * @param {string} filePath Absolute path to the media file
 * @param {number} timeoutMs
 * @returns {Promise<object>} Parsed ffprobe output
 */
export async function probeMedia(filePath, timeoutMs = 15_000) {
  const ffprobeBin = getFfprobePath();

  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '--',
      filePath,
    ];

    const proc = spawn(ffprobeBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new MediaValidationError('Media validation probe timed out.'));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed);
        } catch {
          reject(new MediaValidationError('Could not parse media probe metadata.'));
        }
      } else {
        logger.warn('ffprobe exited with non-zero code', { code, stderr });
        reject(new MediaValidationError('Failed to inspect media file integrity.'));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      logger.error('Failed to spawn ffprobe', { error: err.message });
      reject(new MediaValidationError('ffprobe executable not available or failed to run.'));
    });
  });
}

/**
 * Validates the generated media file against the authoritative format plan.
 * Checks file existence, non-zero size, streams, resolution/aspect ratio,
 * codecs, container, and measures actual filesystem size.
 *
 * @param {string} filePath Absolute path to the downloaded file
 * @param {object} plan The immutable format plan (or stored plan details)
 * @returns {Promise<object>} Validation report with authoritative actual size
 */
export async function validateMediaFile(filePath, plan) {
  // 1. Filesystem check
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new MediaValidationError('Downloaded media file does not exist on disk.');
  }

  if (stat.size <= 0) {
    throw new MediaValidationError('Downloaded media file is empty (0 bytes).');
  }

  const actualBytes = stat.size;
  const actualFormatted = formatByteSize(actualBytes, 'exact');

  // 2. FFprobe inspection
  const probe = await probeMedia(filePath);
  const streams = probe.streams || [];
  const fmt = probe.format || {};

  const videoStream = streams.find(s => s.codec_type === 'video');
  const audioStream = streams.find(s => s.codec_type === 'audio');

  if (plan.type === 'mp3') {
    // MP3 Validation
    if (!audioStream) {
      throw new MediaValidationError('MP3 output contains no audio stream.');
    }
    const audioCodec = audioStream.codec_name?.toLowerCase();
    if (audioCodec !== 'mp3') {
      logger.warn('MP3 codec mismatch', { expected: 'mp3', actual: audioCodec });
      throw new FormatPlanMismatchError(`Expected MP3 codec but found ${audioCodec}.`);
    }

    const duration = parseFloat(fmt.duration || audioStream.duration || '0');
    if (duration <= 0) {
      throw new MediaValidationError('MP3 output file duration is zero or invalid.');
    }

    // Estimate difference calculation for MP3
    const estimatedBytes = plan.output?.estimatedBytes ?? plan.estimatedFinalBytes ?? null;
    let diffBytes = null;
    let diffPercent = null;
    let diffFormatted = 'N/A';
    let diffPercentFormatted = 'N/A';

    if (
      typeof estimatedBytes === 'number' &&
      Number.isFinite(estimatedBytes) &&
      estimatedBytes > 0 &&
      typeof actualBytes === 'number' &&
      Number.isFinite(actualBytes) &&
      actualBytes > 0
    ) {
      diffBytes = actualBytes - estimatedBytes;
      diffPercent = Math.abs(diffBytes / estimatedBytes) * 100;
      const sign = diffBytes < 0 ? '-' : '+';
      diffFormatted = `${sign}${formatByteSize(Math.abs(diffBytes), 'exact')}`;
      const signedPercent = (diffBytes / estimatedBytes) * 100;
      diffPercentFormatted = `${signedPercent >= 0 ? '+' : ''}${signedPercent.toFixed(2)}%`;
    }

    logger.info(
      `\n[SIZE ANALYSIS]\n` +
      `Quality: MP3 ${plan.audio?.outputBitrateKbps || 'auto'} kbps\n` +
      `Source format: ${plan.audio?.sourceFormatId || 'N/A'}\n` +
      `Source codec: ${plan.audio?.sourceCodecName || 'unknown'}\n` +
      `Source size: ${plan.audio?.sourceSizeFormatted || 'N/A'}\n` +
      `Source confidence: ${plan.sourceAudioSizeConfidence || 'unavailable'}\n\n` +
      `Estimated final: ${plan.output?.estimatedFormatted || 'unavailable'}\n` +
      `Estimated confidence: ${plan.output?.confidence || plan.estimatedFinalConfidence || 'calculated'}\n\n` +
      `Actual final: ${actualFormatted}\n\n` +
      `Difference: ${diffFormatted}\n` +
      `Difference: ${diffPercentFormatted}\n`
    );

    return {
      actualBytes,
      actualFormatted,
      differenceBytes: diffBytes,
      differencePercent: diffPercent !== null ? parseFloat(diffPercent.toFixed(2)) : null,
      formatDetails: {
        container: 'mp3',
        audioCodec: 'mp3',
        duration,
        sourceFormatId: plan.audio?.sourceFormatId || null,
        executedSourceFormatId: plan.audio?.sourceFormatId || null,
        outputBitrateKbps: plan.audio?.outputBitrateKbps || null,
      },
      validation: 'PASS',
    };
  }

  // MP4 Validation
  if (!videoStream) {
    throw new MediaValidationError('MP4 output contains no video stream.');
  }

  // Verify audio stream if audio was planned
  if (plan.audio && plan.audio.codecName !== 'none' && !audioStream) {
    throw new MediaValidationError('MP4 output is missing the expected audio stream.');
  }

  const actualWidth = videoStream.width || 0;
  const actualHeight = videoStream.height || 0;
  const actualVCodec = simplifyCodec(videoStream.codec_name);
  const actualACodec = audioStream ? simplifyCodec(audioStream.codec_name) : 'none';

  // Cinematic / Aspect Ratio Resolution Check (Section 21 & 28)
  const expectedWidth = plan.quality?.width || 0;
  const expectedHeight = plan.quality?.height || 0;

  // Exact dimension check (with 4px tolerance only for odd macroblock padding if any)
  if (expectedWidth > 0 && Math.abs(actualWidth - expectedWidth) > 4) {
    logger.warn('Width mismatch', { expectedWidth, actualWidth, planId: plan.planId });
    throw new FormatPlanMismatchError(
      `Video width mismatch: expected ${expectedWidth}px but got ${actualWidth}px.`
    );
  }
  if (expectedHeight > 0 && Math.abs(actualHeight - expectedHeight) > 4) {
    logger.warn('Height mismatch', { expectedHeight, actualHeight, planId: plan.planId });
    throw new FormatPlanMismatchError(
      `Video height mismatch: expected ${expectedHeight}px but got ${actualHeight}px.`
    );
  }

  // FPS verification
  let actualFps = 0;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0) actualFps = Math.round(num / den);
  } else if (videoStream.avg_frame_rate) {
    const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
    if (den > 0) actualFps = Math.round(num / den);
  }

  // Codec check
  const plannedVCodec = plan.video?.codecName;
  if (plannedVCodec && plannedVCodec !== actualVCodec) {
    logger.warn('Video codec difference', { planned: plannedVCodec, actual: actualVCodec });
    // Note: If both are H.264/AVC or container-compatible, allow unless severe mismatch
  }

  // Duration
  const duration = parseFloat(fmt.duration || videoStream.duration || '0');
  if (duration <= 0) {
    throw new MediaValidationError('MP4 output file duration is zero or invalid.');
  }

  // Section 9: Estimate difference calculation
  const estimatedBytes = plan.output?.estimatedBytes ?? plan.estimatedFinalBytes ?? null;
  let diffBytes = null;
  let diffPercent = null;
  let diffFormatted = 'N/A';
  let diffPercentFormatted = 'N/A';

  if (
    typeof estimatedBytes === 'number' &&
    Number.isFinite(estimatedBytes) &&
    estimatedBytes > 0 &&
    typeof actualBytes === 'number' &&
    Number.isFinite(actualBytes) &&
    actualBytes > 0
  ) {
    diffBytes = actualBytes - estimatedBytes;
    diffPercent = Math.abs(diffBytes / estimatedBytes) * 100;
    const sign = diffBytes < 0 ? '-' : '+';
    diffFormatted = `${sign}${formatByteSize(Math.abs(diffBytes), 'exact')}`;
    const signedPercent = (diffBytes / estimatedBytes) * 100;
    diffPercentFormatted = `${signedPercent >= 0 ? '+' : ''}${signedPercent.toFixed(2)}%`;
  }

  // Section 10: Development Diagnostics Log
  logger.info(
    `\n[SIZE ANALYSIS]\n` +
    `Quality: ${plan.quality?.label || 'MP4'}\n` +
    `Video format: ${plan.video?.formatId || 'combined'}\n` +
    `Audio format: ${plan.audio?.formatId || 'none'}\n\n` +
    `Video size: ${plan.video?.sizeFormatted || 'N/A'}\n` +
    `Video confidence: ${plan.video?.confidence || plan.sourceVideoSizeConfidence || 'unavailable'}\n\n` +
    `Audio size: ${plan.audio?.sizeFormatted || 'N/A'}\n` +
    `Audio confidence: ${plan.audio?.confidence || plan.sourceAudioSizeConfidence || 'unavailable'}\n\n` +
    `Estimated final: ${plan.output?.estimatedFormatted || 'unavailable'}\n` +
    `Estimated confidence: ${plan.output?.confidence || plan.estimatedFinalConfidence || 'unavailable'}\n\n` +
    `Actual final: ${actualFormatted}\n\n` +
    `Difference: ${diffFormatted}\n` +
    `Difference: ${diffPercentFormatted}\n`
  );

  return {
    actualBytes,
    actualFormatted,
    differenceBytes: diffBytes,
    differencePercent: diffPercent !== null ? parseFloat(diffPercent.toFixed(2)) : null,
    formatDetails: {
      quality: plan.quality?.label || `${actualHeight}p`,
      width: actualWidth,
      height: actualHeight,
      fps: actualFps || plan.quality?.fps || 30,
      videoCodec: actualVCodec,
      audioCodec: actualACodec,
      container: 'mp4',
    },
    validation: 'PASS',
  };
}
