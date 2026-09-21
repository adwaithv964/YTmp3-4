import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, YOUTUBE_COOKIES, COOKIES_FILE, YTDLP_PROXY, YTDLP_EXTRACTOR_ARGS } from '../config.js';
import { logger } from '../logger.js';

let _resolvedCookiePath = null;
let _initialized = false;

/**
 * Sanitizes Netscape format cookie string:
 * - Decodes base64 if applicable
 * - Strips enclosing quotes or YOUTUBE_COOKIES= variable prefixes
 * - Normalizes space-separated columns to proper TAB (\t) delimiters required by Python http.cookiejar
 * - Ensures valid Netscape header comment
 *
 * @param {string} raw Raw cookie string
 * @returns {string | null} Sanitized Netscape cookie file content, or null if invalid
 */
export function sanitizeNetscapeCookies(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Strip enclosing quotes if copied with quotes
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  // Strip leading variable prefix if accidentally copied
  if (text.startsWith('YOUTUBE_COOKIES=')) {
    text = text.slice(16).trim();
  }

  // Check if base64 encoded
  if (!text.includes('\n') && !text.includes('\t') && text.length > 50) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.includes('youtube.com') || decoded.includes('\t') || decoded.includes('# Netscape')) {
        text = decoded.trim();
      }
    } catch {
      // Not valid base64, proceed as raw text
    }
  }

  const outLines = ['# Netscape HTTP Cookie File', '# Generated and normalized by YTmp3/4 cookieService', ''];
  const rawLines = text.split(/\r?\n/);
  let validRecords = 0;

  for (let line of rawLines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('YOUTUBE_COOKIES=')) {
      line = line.slice(16).trim();
    }

    // Try splitting by tabs first
    let parts = line.split('\t').map(s => s.trim()).filter(Boolean);

    // If web UI or copy-paste converted tabs to spaces
    if (parts.length < 7) {
      parts = line.split(/\s+/);
    }

    if (parts.length >= 7) {
      const domain = parts[0];
      const includeSubdomains = parts[1].toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
      const cookiePath = parts[2] || '/';
      const secure = parts[3].toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
      const expiry = parts[4] || '0';
      const name = parts[5];
      // Value may contain spaces
      const value = parts.slice(6).join(' ');

      // Netscape requires initial dot for subdomains if specified
      outLines.push([domain, includeSubdomains, cookiePath, secure, expiry, name, value].join('\t'));
      validRecords++;
    }
  }

  if (validRecords === 0) {
    return null;
  }

  return outLines.join('\n') + '\n';
}

/**
 * Initializes cookie file from environment variable or configured path.
 * Checks Render secret file, explicit path, data/cookies.txt, or YOUTUBE_COOKIES.
 *
 * @returns {string | null} Absolute path to cookie file, or null if none available.
 */
export function initCookies() {
  if (_initialized) return _resolvedCookiePath;
  _initialized = true;

  // 1. Explicit file path via COOKIES_FILE
  if (COOKIES_FILE) {
    const resolved = path.resolve(COOKIES_FILE);
    if (fs.existsSync(resolved)) {
      _resolvedCookiePath = resolved;
      logger.info('Using YouTube cookies from COOKIES_FILE', { path: resolved });
      return _resolvedCookiePath;
    }
  }

  // 2. Render Secret File (/etc/secrets/cookies.txt)
  const renderSecretPath = '/etc/secrets/cookies.txt';
  if (fs.existsSync(renderSecretPath)) {
    _resolvedCookiePath = renderSecretPath;
    logger.info('Using YouTube cookies from Render Secret File', { path: renderSecretPath });
    return _resolvedCookiePath;
  }

  // 3. YOUTUBE_COOKIES environment variable (raw text or base64)
  if (YOUTUBE_COOKIES && typeof YOUTUBE_COOKIES === 'string' && YOUTUBE_COOKIES.trim().length > 0) {
    try {
      const sanitized = sanitizeNetscapeCookies(YOUTUBE_COOKIES);
      if (sanitized) {
        if (!fs.existsSync(DATA_DIR)) {
          fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        const defaultCookieFile = path.join(DATA_DIR, 'cookies.txt');
        fs.writeFileSync(defaultCookieFile, sanitized, { mode: 0o600, encoding: 'utf8' });
        _resolvedCookiePath = defaultCookieFile;
        logger.info('Successfully generated normalized cookies.txt from YOUTUBE_COOKIES environment variable');
        return _resolvedCookiePath;
      } else {
        logger.warn('YOUTUBE_COOKIES was provided but contained no valid cookie entries');
      }
    } catch (err) {
      logger.error('Failed to create cookies.txt from YOUTUBE_COOKIES', { error: err.message });
    }
  }

  // 4. Existing data/cookies.txt (e.g. locally placed)
  const defaultCookieFile = path.join(DATA_DIR, 'cookies.txt');
  if (fs.existsSync(defaultCookieFile)) {
    _resolvedCookiePath = defaultCookieFile;
    logger.info('Using existing YouTube cookies from data/cookies.txt', { path: defaultCookieFile });
    return _resolvedCookiePath;
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

