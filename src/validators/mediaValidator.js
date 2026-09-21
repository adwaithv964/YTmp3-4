import { ALLOWED_HOSTS, ALLOWED_FORMATS, isValidQuality, ALLOWED_BITRATES, PRIVATE_IP_RE } from '../config.js';
import { ValidationError, BlockedSourceError } from '../errors.js';
import { getFormatPlan } from '../services/formatPlanService.js';

// ─── URL validation ───────────────────────────────────────────────────────────

/**
 * Validates a candidate URL for SSRF safety and allowed-host membership.
 *
 * Checks performed (all server-side, never trust client validation):
 *  1. Is a non-empty string
 *  2. Parses as a valid URL
 *  3. Uses https: or http: scheme only
 *  4. Hostname is not a private/loopback/link-local IP
 *  5. Hostname is in the ALLOWED_HOSTS set
 *
 * @param {unknown} rawUrl - Raw input from the request body.
 * @returns {{ url: URL, host: string }} Parsed URL and normalised host.
 * @throws {ValidationError | BlockedSourceError}
 */
export function validateUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new ValidationError('URL is required.', 'MISSING_URL');
  }

  const input = rawUrl.trim().slice(0, 2048); // hard cap on length

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new ValidationError('The URL is not valid. Please enter a full YouTube URL.', 'INVALID_URL');
  }

  // Scheme: only http/https
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BlockedSourceError('Only https:// and http:// URLs are permitted.');
  }

  // Reject credentials in URLs
  if (parsed.username || parsed.password) {
    throw new BlockedSourceError('Credentials in URLs are not permitted.');
  }

  // Reject non-standard ports
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new BlockedSourceError('Non-standard ports are not permitted.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Block private / loopback / link-local IPs
  if (PRIVATE_IP_RE.test(hostname)) {
    throw new BlockedSourceError('This address is not accessible.');
  }

  // Block plain "localhost" and variants
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
    throw new BlockedSourceError('This address is not accessible.');
  }

  // Host allowlist — only YouTube domains are supported
  const rootHost = hostname.replace(/^www\./, '');
  const matchedHost = [...ALLOWED_HOSTS].find(h => hostname === h || hostname.endsWith('.' + h));
  if (!matchedHost) {
    throw new ValidationError(
      'Only YouTube URLs are supported (youtube.com, youtu.be).',
      'UNSUPPORTED_DOMAIN',
    );
  }

  return { url: parsed, host: hostname };
}

// ─── Format, quality, bitrate validation ─────────────────────────────────────

/**
 * @param {unknown} format
 * @returns {'mp4' | 'mp3'}
 */
export function validateFormat(format) {
  if (!ALLOWED_FORMATS.has(format)) {
    throw new ValidationError(
      `Format must be one of: ${[...ALLOWED_FORMATS].join(', ')}.`,
      'INVALID_FORMAT',
    );
  }
  return format;
}

/**
 * @param {unknown} quality
 * @returns {string}
 */
export function validateQuality(quality) {
  if (!isValidQuality(quality)) {
    throw new ValidationError(
      'Quality must be "best" or a valid video height (e.g. 360, 720, 1080, 1608).',
      'INVALID_QUALITY',
    );
  }
  return quality;
}

/**
 * @param {unknown} bitrate
 * @returns {string}
 */
export function validateBitrate(bitrate) {
  if (!ALLOWED_BITRATES.has(bitrate)) {
    throw new ValidationError(
      `Bitrate must be one of: ${[...ALLOWED_BITRATES].join(', ')} kbps.`,
      'INVALID_BITRATE',
    );
  }
  return bitrate;
}

/**
 * Validates all job creation fields together.
 * Supports both immutable format plans (preferred) and legacy parameters.
 *
 * @param {{ planId?: unknown, url?: unknown, format?: unknown, quality?: unknown, bitrate?: unknown }} body
 * @returns {{ planId: string | null, urlString: string, format: string, quality: string, bitrate: string, formatPlan: object | null }}
 */
export function validateJobRequest(body) {
  const { planId, url, format, quality, bitrate } = body ?? {};

  if (planId) {
    if (typeof planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(planId)) {
      throw new ValidationError('Invalid format plan ID.', 'INVALID_PLAN_ID');
    }
    const plan = getFormatPlan(planId);
    validateUrl(plan.source.url);

    return {
      planId:     plan.planId,
      urlString:  plan.source.url,
      format:     plan.type,
      quality:    plan.quality?.tier || 'best',
      bitrate:    plan.audio?.outputBitrateKbps ? String(plan.audio.outputBitrateKbps) : '192',
      formatPlan: plan,
    };
  }

  validateUrl(url);                      // throws if invalid
  const validFormat  = validateFormat(format);
  const validQuality = validFormat === 'mp4' ? validateQuality(quality)  : 'best';
  const validBitrate = validFormat === 'mp3' ? validateBitrate(bitrate)  : '192';

  return {
    planId:     null,
    urlString:  String(url).trim(),
    format:     validFormat,
    quality:    validQuality,
    bitrate:    validBitrate,
    formatPlan: null,
  };
}
