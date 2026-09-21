import { LOG_LEVEL } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(level, message, meta = {}) {
  if ((LEVELS[level] ?? 99) > currentLevel) return;

  // Redact any field that looks like a secret or path
  const safe = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/secret|key|token|password|auth/i.test(k)) {
      safe[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 300) {
      safe[k] = v.slice(0, 300) + '…';
    } else {
      safe[k] = v;
    }
  }

  const entry = JSON.stringify({
    ts:    new Date().toISOString(),
    level,
    msg:   message,
    ...safe,
  });

  if (level === 'error' || level === 'warn') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }
}

export const logger = {
  error: (msg, meta) => log('error', msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
};
