import crypto from 'node:crypto';
import { TOKEN_SECRET } from '../config.js';
import { FormatPlanNotFoundError, FormatPlanExpiredError } from '../errors.js';
import { logger } from '../logger.js';

// ─── Constants ───────────────────────────────────────────────────────────────
export const PLAN_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const TIER_ORDER = ['2160', '1440', '1080', '720', '480', '360', '240'];

export const TIER_CONFIG = {
  '2160': { label: '4K Ultra HD', resolution: '2160p', minW: 3840, minH: 1600 },
  '1440': { label: '1440p QHD',   resolution: '1440p', minW: 2560, minH: 1000 },
  '1080': { label: '1080p Full HD',resolution: '1080p', minW: 1920, minH: 750 },
  '720':  { label: '720p HD',     resolution: '720p',  minW: 1280, minH: 500 },
  '480':  { label: '480p',        resolution: '480p',  minW: 854,  minH: 350 },
  '360':  { label: '360p',        resolution: '360p',  minW: 640,  minH: 250 },
  '240':  { label: '240p',        resolution: '240p',  minW: 426,  minH: 144 },
};

// ─── In-memory Plan Store ────────────────────────────────────────────────────
// Map<string, { plan: object, signature: string, expiresAt: number }>
const planStore = new Map();

// Periodic cleanup of expired plans (every 5 minutes)
setInterval(() => {
  cleanupExpiredPlans();
}, 5 * 60 * 1000).unref();

export function cleanupExpiredPlans() {
  const now = Date.now();
  let deleted = 0;
  for (const [planId, entry] of planStore.entries()) {
    if (entry.expiresAt <= now) {
      planStore.delete(planId);
      deleted++;
    }
  }
  if (deleted > 0) {
    logger.debug('Cleaned up expired format plans', { deleted, remaining: planStore.size });
  }
}

// ─── HMAC Signature ─────────────────────────────────────────────────────────
function signPlan(plan) {
  const canonical = JSON.stringify({
    planId: plan.planId,
    type: plan.type,
    url: plan.source.url,
    videoId: plan.source.videoId,
    videoFormatId: plan.video?.formatId ?? null,
    audioFormatId: plan.audio?.formatId ?? plan.audio?.sourceFormatId ?? null,
    expiresAt: plan.source.expiresAt,
  });
  return crypto.createHmac('sha256', TOKEN_SECRET).update(canonical).digest('hex');
}

function verifySignature(plan, signature) {
  const expected = signPlan(plan);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Helpers: Size Calculation ──────────────────────────────────────────────
/**
 * Confidence levels for media sizes:
 * - "exact": Measured byte size from format.filesize
 * - "approximate": Estimated by provider from format.filesize_approx
 * - "calculated": Bitrate * duration estimate
 * - "unavailable": Missing, zero, or invalid metadata
 */

/**
 * Resolves stream size following priority:
 * 1. format.filesize > 0 -> "exact"
 * 2. format.filesize_approx > 0 -> "approximate"
 * 3. bitrate * duration -> "calculated"
 * 4. unavailable
 *
 * All zero, negative, NaN, undefined, or null values safely resolve to "unavailable".
 *
 * @param {object} fmt yt-dlp format object
 * @param {number} durationSeconds Video duration in seconds
 * @returns {{ bytes: number | null, confidence: 'exact' | 'approximate' | 'calculated' | 'unavailable' }}
 */
export function resolveStreamSize(fmt, durationSeconds = 0) {
  if (!fmt || typeof fmt !== 'object') {
    return { bytes: null, confidence: 'unavailable' };
  }

  // 1. filesize (exact)
  if (typeof fmt.filesize === 'number' && Number.isFinite(fmt.filesize) && fmt.filesize > 0) {
    return {
      bytes: Math.round(fmt.filesize),
      confidence: 'exact',
    };
  }

  // 2. filesize_approx (approximate)
  if (typeof fmt.filesize_approx === 'number' && Number.isFinite(fmt.filesize_approx) && fmt.filesize_approx > 0) {
    return {
      bytes: Math.round(fmt.filesize_approx),
      confidence: 'approximate',
    };
  }

  // 3. bitrate * duration (calculated)
  const bitrateKbps = fmt.tbr || fmt.vbr || fmt.abr || 0;
  if (
    typeof bitrateKbps === 'number' &&
    Number.isFinite(bitrateKbps) &&
    bitrateKbps > 0 &&
    typeof durationSeconds === 'number' &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    const calcBytes = Math.round((bitrateKbps * 1000 * durationSeconds) / 8);
    if (calcBytes > 0) {
      return {
        bytes: calcBytes,
        confidence: 'calculated',
      };
    }
  }

  // 4. unavailable
  return {
    bytes: null,
    confidence: 'unavailable',
  };
}

/**
 * Derives output size confidence for separate muxed video + audio streams.
 * Rules:
 * - Either input is "calculated" -> "calculated"
 * - Neither calculated, but at least one is "approximate" -> "approximate"
 * - Both inputs are "exact" -> "approximate" (muxing separate streams cannot be byte-exact in advance)
 * - Both unavailable -> "unavailable"
 * - One unavailable and other has size -> inherits other's confidence (or "calculated" / "approximate")
 */
export function deriveMuxedConfidence(vConf, aConf) {
  if (vConf === 'unavailable' && aConf === 'unavailable') {
    return 'unavailable';
  }
  if (vConf === 'calculated' || aConf === 'calculated') {
    return 'calculated';
  }
  // If either or both are exact/approximate, the output of a mux is approximate
  return 'approximate';
}

/**
 * Formats byte size according to confidence level:
 * - exact: "92.4 MB" (standard precision, no ~)
 * - approximate: "~92.4 MB" (~ prefix)
 * - calculated: "~418 MB" for >= 10 MB (avoids false decimal precision from VBR bitrate), "~4.2 MB" for < 10 MB
 * - unavailable: "Size unavailable" (never "0 MB", never "Unknown MB")
 *
 * @param {number|null} bytes
 * @param {'exact' | 'approximate' | 'calculated' | 'unavailable'} confidence
 * @returns {string}
 */
export function formatByteSize(bytes, confidence = 'unavailable') {
  if (confidence === true) confidence = 'exact';
  if (confidence === false) confidence = 'approximate';

  if (
    confidence === 'unavailable' ||
    typeof bytes !== 'number' ||
    !Number.isFinite(bytes) ||
    bytes <= 0
  ) {
    return 'Size unavailable';
  }

  const ONE_KB = 1024;
  const ONE_MB = 1024 * 1024;
  const ONE_GB = 1024 * 1024 * 1024;
  const TEN_MB = 10 * ONE_MB;

  if (confidence === 'exact') {
    if (bytes < ONE_KB) return `${bytes} B`;
    if (bytes < ONE_MB) return `${(bytes / ONE_KB).toFixed(1)} KB`;
    if (bytes < ONE_GB) return `${(bytes / ONE_MB).toFixed(1)} MB`;
    return `${(bytes / ONE_GB).toFixed(2)} GB`;
  }

  if (confidence === 'approximate') {
    if (bytes < ONE_KB) return `~${bytes} B`;
    if (bytes < ONE_MB) return `~${(bytes / ONE_KB).toFixed(1)} KB`;
    if (bytes < ONE_GB) return `~${(bytes / ONE_MB).toFixed(1)} MB`;
    return `~${(bytes / ONE_GB).toFixed(2)} GB`;
  }

  if (confidence === 'calculated') {
    if (bytes < ONE_KB) return `~${bytes} B`;
    if (bytes < ONE_MB) return `~${Math.round(bytes / ONE_KB)} KB`;
    if (bytes < TEN_MB) {
      // Small files: 1 decimal place
      return `~${(bytes / ONE_MB).toFixed(1)} MB`;
    }
    if (bytes < ONE_GB) {
      // >= 10 MB: integer MB to avoid false precision (e.g. "~418 MB", not "~418.2 MB")
      return `~${Math.round(bytes / ONE_MB)} MB`;
    }
    // >= 1 GB
    return `~${(bytes / ONE_GB).toFixed(1)} GB`;
  }

  return 'Size unavailable';
}

// ─── Helpers: Format & Codec Detection ──────────────────────────────────────
export function simplifyCodec(codecStr) {
  if (!codecStr || codecStr === 'none') return 'none';
  const c = codecStr.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'H.264';
  if (c.startsWith('vp09') || c.startsWith('vp9'))  return 'VP9';
  if (c.startsWith('av01') || c.startsWith('av1'))  return 'AV1';
  if (c.startsWith('hev1') || c.startsWith('h265') || c.startsWith('hvc1')) return 'HEVC';
  if (c.startsWith('mp4a') || c.startsWith('aac'))  return 'AAC';
  if (c.startsWith('opus')) return 'Opus';
  return codecStr.split('.')[0];
}

/**
 * Classifies format into a standard resolution tier.
 * Accurately normalizes cinematic widescreen ratios (e.g. 3840x1608 -> 2160, 2560x1072 -> 1440, etc.).
 */
export function getFormatTier(fmt) {
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

  for (const tier of TIER_ORDER) {
    const cfg = TIER_CONFIG[tier];
    if (w >= cfg.minW || h >= cfg.minH) {
      return tier;
    }
  }

  return null;
}

// ─── Plan Generator ─────────────────────────────────────────────────────────

/**
 * Generates immutable format plans from yt-dlp metadata.
 * Analyzes all formats, matches container compatibility, estimates size,
 * stores plans in the cache, and returns structured MP4 and MP3 format plans.
 *
 * @param {object} info yt-dlp metadata info object
 * @param {string} urlSource original URL
 * @returns {{ mp4: object[], mp3: object[] }}
 */
export function createFormatPlans(info, urlSource) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const duration = typeof info.duration === 'number' ? info.duration : 0;
  const videoId = String(info.id || '');
  const title = String(info.title || 'Unknown Video').slice(0, 200);
  const now = Date.now();
  const expiresAtMs = now + PLAN_TTL_MS;
  const createdAtIso = new Date(now).toISOString();
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  // 1. Separate audio-only and video streams
  const audioStreams = [];
  const videoStreams = [];

  for (const f of formats) {
    const hasV = f.vcodec && f.vcodec !== 'none';
    const hasA = f.acodec && f.acodec !== 'none';
    if (!hasV && hasA) {
      audioStreams.push(f);
    } else if (hasV) {
      videoStreams.push(f);
    }
  }

  // 2. Determine best audio stream for MP4 container (AAC/m4a preference for stream copy)
  // M4A/AAC formats (e.g. format 140, 139) mux losslessly into MP4 with zero transcode
  let bestM4aAudio = null;
  let bestGeneralAudio = null;

  for (const a of audioStreams) {
    const abr = a.abr || a.tbr || 0;
    const isM4a = a.ext === 'm4a' || (a.acodec && (a.acodec.startsWith('mp4a') || a.acodec.startsWith('aac')));

    if (isM4a) {
      if (!bestM4aAudio || (abr > (bestM4aAudio.abr || bestM4aAudio.tbr || 0))) {
        bestM4aAudio = a;
      }
    }
    if (!bestGeneralAudio || (abr > (bestGeneralAudio.abr || bestGeneralAudio.tbr || 0))) {
      bestGeneralAudio = a;
    }
  }

  // Fallback to best general audio if no m4a found
  const defaultAudio = bestM4aAudio || bestGeneralAudio;

  // 3. Group video streams by tier
  // We want to support Maximum Compatibility (prefer H.264/avc1) and Maximum Quality
  const tierMap = new Map(); // tier -> format[]

  for (const v of videoStreams) {
    const tier = getFormatTier(v);
    if (!tier) continue;
    if (!tierMap.has(tier)) {
      tierMap.set(tier, []);
    }
    tierMap.get(tier).push(v);
  }

  const mp4Plans = [];

  for (const tier of TIER_ORDER) {
    const candidates = tierMap.get(tier);
    if (!candidates || candidates.length === 0) continue;

    // Pick best candidate for Maximum Compatibility (and fallback to best quality)
    // Priority:
    // 1. Direct combined mp4 (pre-merged with audio)
    // 2. AVC1 (H.264) in MP4 container
    // 3. AV01 (AV1) or VP9 with highest bitrate
    candidates.sort((a, b) => {
      const aMuxed = a.acodec && a.acodec !== 'none';
      const bMuxed = b.acodec && b.acodec !== 'none';
      const aAvc = a.vcodec && a.vcodec.startsWith('avc1');
      const bAvc = b.vcodec && b.vcodec.startsWith('avc1');
      const aAv01 = a.vcodec && a.vcodec.startsWith('av01');
      const bAv01 = b.vcodec && b.vcodec.startsWith('av01');
      const aExtMp4 = a.ext === 'mp4';
      const bExtMp4 = b.ext === 'mp4';
      const aBitrate = a.vbr || a.tbr || 0;
      const bBitrate = b.vbr || b.tbr || 0;

      let scoreA = 0;
      let scoreB = 0;

      if (aMuxed) scoreA += 10000;
      if (bMuxed) scoreB += 10000;
      if (aAvc) scoreA += 5000;
      if (bAvc) scoreB += 5000;
      if (aAv01) scoreA += 3000;
      if (bAv01) scoreB += 3000;
      if (aExtMp4) scoreA += 1000;
      if (bExtMp4) scoreB += 1000;
      scoreA += aBitrate;
      scoreB += bBitrate;

      return scoreB - scoreA;
    });

    const chosenVideo = candidates[0];
    const isCombined = Boolean(chosenVideo.acodec && chosenVideo.acodec !== 'none');
    const chosenAudio = isCombined ? null : defaultAudio;

    // Sizes and confidence resolution
    const vSize = resolveStreamSize(chosenVideo, duration);
    let aSize = null;
    let estimatedFinalBytes = null;
    let estimatedFinalConfidence = 'unavailable';

    if (isCombined) {
      // Direct combined stream (video + audio in single stream)
      estimatedFinalBytes = vSize.bytes;
      estimatedFinalConfidence = vSize.confidence;
    } else if (chosenAudio) {
      aSize = resolveStreamSize(chosenAudio, duration);
      if (vSize.bytes !== null && aSize.bytes !== null) {
        // Authoritative estimate is video + audio streams
        estimatedFinalBytes = vSize.bytes + aSize.bytes;
      } else if (vSize.bytes !== null) {
        estimatedFinalBytes = vSize.bytes;
      } else if (aSize.bytes !== null) {
        estimatedFinalBytes = aSize.bytes;
      } else {
        estimatedFinalBytes = null;
      }
      estimatedFinalConfidence = deriveMuxedConfidence(vSize.confidence, aSize.confidence);
    } else {
      estimatedFinalBytes = vSize.bytes;
      estimatedFinalConfidence = vSize.confidence;
    }

    const cfg = TIER_CONFIG[tier];
    const planId = crypto.randomUUID();
    const vcodecName = simplifyCodec(chosenVideo.vcodec);
    const acodecName = isCombined
      ? simplifyCodec(chosenVideo.acodec)
      : (chosenAudio ? simplifyCodec(chosenAudio.acodec) : 'none');

    // Codec policy assignment
    // maximum_compatibility: H.264/AVC + AAC into MP4
    // maximum_quality: High-efficiency streams (VP9/AV1) or direct preservation
    // source_preservation: Preserve source stream codecs without transcoding
    let selectionPolicy = 'maximum_compatibility';
    if (vcodecName === 'H.264' && acodecName === 'AAC') {
      selectionPolicy = 'maximum_compatibility';
    } else if (vcodecName === 'VP9' || vcodecName === 'AV1') {
      selectionPolicy = 'maximum_quality';
    } else {
      selectionPolicy = 'source_preservation';
    }

    const plan = {
      planId,
      source: {
        url: urlSource,
        videoId,
        title,
        createdAt: createdAtIso,
        expiresAt: expiresAtIso,
      },
      type: 'mp4',
      quality: {
        tier,
        label: cfg.label,
        resolution: cfg.resolution,
        width: chosenVideo.width || 0,
        height: chosenVideo.height || 0,
        fps: chosenVideo.fps || 30,
        hdr: Boolean(chosenVideo.dynamic_range && chosenVideo.dynamic_range !== 'SDR'),
      },
      sourceVideoBytes: vSize.bytes,
      sourceAudioBytes: aSize ? aSize.bytes : null,
      sourceVideoSizeConfidence: vSize.confidence,
      sourceAudioSizeConfidence: aSize ? aSize.confidence : (isCombined ? 'exact' : 'unavailable'),
      estimatedFinalBytes,
      estimatedFinalConfidence,
      actualFinalBytes: null,
      video: {
        formatId: String(chosenVideo.format_id),
        codec: chosenVideo.vcodec,
        codecName: vcodecName,
        container: chosenVideo.ext || 'mp4',
        bytes: vSize.bytes,
        confidence: vSize.confidence,
        sizeFormatted: formatByteSize(vSize.bytes, vSize.confidence),
      },
      audio: chosenAudio ? {
        formatId: String(chosenAudio.format_id),
        codec: chosenAudio.acodec,
        codecName: acodecName,
        container: chosenAudio.ext || 'm4a',
        bitrateKbps: Math.round(chosenAudio.abr || chosenAudio.tbr || 128),
        bytes: aSize?.bytes ?? null,
        confidence: aSize?.confidence ?? 'unavailable',
        sizeFormatted: formatByteSize(aSize?.bytes ?? null, aSize?.confidence ?? 'unavailable'),
      } : {
        formatId: null,
        codec: chosenVideo.acodec || 'none',
        codecName: acodecName,
        container: chosenVideo.ext || 'mp4',
        bitrateKbps: Math.round(chosenVideo.abr || 128),
        bytes: null,
        confidence: vSize.confidence,
        sizeFormatted: 'Included',
      },
      output: {
        container: 'mp4',
        estimatedBytes: estimatedFinalBytes,
        confidence: estimatedFinalConfidence,
        estimatedFormatted: formatByteSize(estimatedFinalBytes, estimatedFinalConfidence),
        needsFFmpeg: !isCombined,
        mode: isCombined ? 'direct' : 'stream-copy',
        compatibility: selectionPolicy === 'maximum_compatibility' ? 'high' : 'standard',
      },
      selectionPolicy,
    };

    // Store in planStore
    const signature = signPlan(plan);
    planStore.set(planId, { plan, signature, expiresAt: expiresAtMs });

    // Debug logging as required by section 10 & 32
    logger.debug(`[FORMAT PLAN]\n` +
      `Plan ID: ${plan.planId}\n` +
      `Quality: ${plan.quality.label}\n` +
      `Dimensions: ${plan.quality.width}x${plan.quality.height}\n` +
      `FPS: ${plan.quality.fps}\n` +
      `Video format: ${plan.video.formatId}\n` +
      `Video codec: ${plan.video.codecName} (${plan.video.codec})\n` +
      `Video size: ${plan.video.sizeFormatted} (${plan.video.confidence})\n` +
      `Audio format: ${plan.audio.formatId || 'combined'}\n` +
      `Audio codec: ${plan.audio.codecName}\n` +
      `Audio bitrate: ${plan.audio.bitrateKbps} kbps\n` +
      `Audio size: ${plan.audio.sizeFormatted} (${plan.audio.confidence})\n` +
      `Estimated final: ${plan.output.estimatedFormatted} (${plan.output.confidence})\n` +
      `Selection policy: ${plan.selectionPolicy}\n` +
      `FFmpeg mode: ${plan.output.mode}`
    );

    mp4Plans.push(plan);
  }

  // 4. Generate MP3 format plans
  // Source selection must be concrete: select the highest-quality audio stream
  // and store its exact format ID (e.g. "251" or "140"). Never store "bestaudio".
  let sourceAudioStream = bestGeneralAudio || bestM4aAudio;
  if (!sourceAudioStream) {
    // Fallback to any stream containing audio
    for (const f of formats) {
      if (f.acodec && f.acodec !== 'none') {
        const abr = f.abr || f.tbr || 0;
        if (!sourceAudioStream || abr > (sourceAudioStream.abr || sourceAudioStream.tbr || 0)) {
          sourceAudioStream = f;
        }
      }
    }
  }

  const mp3Plans = [];
  if (sourceAudioStream) {
    const concreteSourceFormatId = String(sourceAudioStream.format_id);
    const sourceAudioSize = resolveStreamSize(sourceAudioStream, duration);
    const sourceAudioCodec = simplifyCodec(sourceAudioStream.acodec);
    const sourceContainer = sourceAudioStream.ext || 'webm';
    const sourceBitrateKbps = Math.round(sourceAudioStream.abr || sourceAudioStream.tbr || 128);

    const standardBitrates = ['128', '192', '256', '320'];

    for (const kbpsStr of standardBitrates) {
      const kbps = parseInt(kbpsStr, 10);
      const estBytes = (duration > 0 && kbps > 0) ? Math.round((kbps * 1000 * duration) / 8) : null;
      const estConfidence = estBytes ? 'calculated' : 'unavailable';
      const planId = crypto.randomUUID();

      const plan = {
        planId,
        source: {
          url: urlSource,
          videoId,
          title,
          createdAt: createdAtIso,
          expiresAt: expiresAtIso,
        },
        type: 'mp3',
        sourceVideoBytes: null,
        sourceAudioBytes: sourceAudioSize?.bytes ?? null,
        sourceVideoSizeConfidence: 'unavailable',
        sourceAudioSizeConfidence: sourceAudioSize?.confidence ?? 'unavailable',
        estimatedFinalBytes: estBytes,
        estimatedFinalConfidence: estConfidence,
        actualFinalBytes: null,
        audio: {
          sourceFormatId: concreteSourceFormatId,
          sourceCodec: sourceAudioStream.acodec || 'unknown',
          sourceCodecName: sourceAudioCodec,
          sourceContainer,
          sourceBitrateKbps,
          sourceBytes: sourceAudioSize?.bytes ?? null,
          sourceSizeConfidence: sourceAudioSize?.confidence ?? 'unavailable',
          sourceConfidence: sourceAudioSize?.confidence ?? 'unavailable',
          sourceSizeFormatted: formatByteSize(sourceAudioSize?.bytes ?? null, sourceAudioSize?.confidence ?? 'unavailable'),
          outputFormat: 'mp3',
          outputBitrateKbps: kbps,
        },
        output: {
          container: 'mp3',
          format: 'mp3',
          bitrateKbps: kbps,
          estimatedBytes: estBytes,
          confidence: estConfidence,
          estimatedConfidence: estConfidence,
          estimatedFormatted: formatByteSize(estBytes, estConfidence),
          needsFFmpeg: true,
          mode: 'transcode',
        },
        selectionPolicy: 'maximum_quality',
      };

      const signature = signPlan(plan);
      planStore.set(planId, { plan, signature, expiresAt: expiresAtMs });

      // Section 10: MP3 Format Plan Development Logging
      logger.debug(`\n[MP3 FORMAT PLAN]\n` +
        `Plan ID: ${plan.planId}\n` +
        `Source format ID: ${plan.audio.sourceFormatId}\n` +
        `Source codec: ${plan.audio.sourceCodecName}\n` +
        `Source bitrate: ~${plan.audio.sourceBitrateKbps} kbps\n` +
        `Output format: MP3\n` +
        `Output bitrate: ${plan.audio.outputBitrateKbps} kbps\n` +
        `Execution selector: ${plan.audio.sourceFormatId}`
      );

      mp3Plans.push(plan);
    }
  }

  return { mp4: mp4Plans, mp3: mp3Plans };
}

// ─── Plan Retrieval & Validation ─────────────────────────────────────────────

/**
 * Retrieves and validates an immutable format plan by ID.
 * Throws FormatPlanNotFoundError or FormatPlanExpiredError if invalid or expired.
 *
 * @param {string} planId
 * @returns {object} The validated format plan
 */
export function getFormatPlan(planId) {
  if (!planId || typeof planId !== 'string') {
    throw new FormatPlanNotFoundError('A valid format plan ID is required.');
  }

  const entry = planStore.get(planId);
  if (!entry) {
    throw new FormatPlanNotFoundError();
  }

  if (entry.expiresAt <= Date.now()) {
    planStore.delete(planId);
    throw new FormatPlanExpiredError();
  }

  if (!verifySignature(entry.plan, entry.signature)) {
    logger.warn('Format plan signature mismatch — possible tampering', { planId });
    throw new FormatPlanNotFoundError('Format plan validation failed.');
  }

  return entry.plan;
}
