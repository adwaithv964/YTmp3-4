import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, YOUTUBE_COOKIES, COOKIES_FILE, YTDLP_PROXY, YTDLP_EXTRACTOR_ARGS } from '../config.js';
import { logger } from '../logger.js';

let _resolvedCookiePath = null;
let _initialized = false;

/**
 * Initializes cookie file from environment variable or configured path.
 * If YOUTUBE_COOKIES contains raw Netscape cookie content or base64,
 * it writes it to a secure file in DATA_DIR.
 *
 * @returns {string | null} Absolute path to cookie file, or null if none available.
 */
export function initCookies() {
  if (_initialized) return _resolvedCookiePath;
  _initialized = true;

  // 1. Explicit file path
  if (COOKIES_FILE) {
    const resolved = path.resolve(COOKIES_FILE);
    if (fs.existsSync(resolved)) {
      _resolvedCookiePath = resolved;
      logger.info('Using YouTube cookies from COOKIES_FILE', { path: resolved });
      return _resolvedCookiePath;
    }
  }

  // 2. Default data/cookies.txt
  const defaultCookieFile = path.join(DATA_DIR, 'cookies.txt');
  if (fs.existsSync(defaultCookieFile)) {
    _resolvedCookiePath = defaultCookieFile;
    logger.info('Using YouTube cookies from data/cookies.txt', { path: defaultCookieFile });
    return _resolvedCookiePath;
  }

  // 3. YOUTUBE_COOKIES environment variable (raw text or base64)
  if (YOUTUBE_COOKIES && typeof YOUTUBE_COOKIES === 'string' && YOUTUBE_COOKIES.trim().length > 0) {
    try {
      let content = YOUTUBE_COOKIES.trim();

      // Check if it's base64 encoded
      if (!content.includes('\n') && !content.includes('\t') && content.length > 50) {
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf8');
          if (decoded.includes('# Netscape') || decoded.includes('.youtube.com') || decoded.includes('\t')) {
            content = decoded;
          }
        } catch {
          // keep as is
        }
      }

      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      fs.writeFileSync(defaultCookieFile, content, { mode: 0o600, encoding: 'utf8' });
      _resolvedCookiePath = defaultCookieFile;
      logger.info('Successfully generated cookies.txt from YOUTUBE_COOKIES environment variable');
      return _resolvedCookiePath;
    } catch (err) {
      logger.error('Failed to create cookies.txt from YOUTUBE_COOKIES', { error: err.message });
    }
  }

  return null;
}

/**
 * Returns arguments array to pass to yt-dlp for cookies, extractor clients, and proxies.
 *
 * @returns {string[]}
 */
export function getCommonYtdlpArgs() {
  const args = [];

  const cookiePath = initCookies();
  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }

  if (YTDLP_EXTRACTOR_ARGS) {
    args.push('--extractor-args', YTDLP_EXTRACTOR_ARGS);
  }

  if (YTDLP_PROXY) {
    args.push('--proxy', YTDLP_PROXY);
  }

  return args;
}
