import express      from 'express';
import helmet       from 'helmet';
import compression  from 'compression';
import path         from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, CLIENT_ORIGINS } from './src/config.js';
import { requestId }   from './src/middleware/requestId.js';
import { errorHandler } from './src/middleware/errorHandler.js';
import mediaRoutes      from './src/routes/mediaRoutes.js';
import { startCleanup } from './src/services/cleanupService.js';
import { checkAvailability } from './src/providers/ytdlProvider.js';
import { recoverOrphanedJobs } from './src/services/jobService.js';
import { initCookies } from './src/services/cookieService.js';
import { logger } from './src/logger.js';

import { apiLimiter }    from './src/middleware/rateLimiter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ─── Security: Hide framework identity ────────────────────────────────────────
app.disable('x-powered-by');

// ─── Trust proxy (Render / Vercel / reverse proxies) ──────────────────────────
app.set('trust proxy', 1);

// ─── Security headers (Helmet) ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'"],
      scriptSrcAttr:   ["'none'"],
      // Google Fonts requires 'unsafe-inline' for @font-face style injection
      styleSrc:        ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      styleSrcAttr:    ["'unsafe-inline'"],
      fontSrc:         ["'self'", 'https://fonts.gstatic.com'],
      // YouTube thumbnail CDN domains
      imgSrc:          ["'self'", 'data:', 'https://i.ytimg.com', 'https://img.youtube.com'],
      connectSrc:      ["'self'"],
      objectSrc:       ["'none'"],
      frameAncestors:  ["'none'"],
      formAction:      ["'self'"],
      baseUri:         ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  originAgentCluster:        true,
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  hsts: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true,
  },
}));

// ─── Permissions Policy (Disable unused browser features) ─────────────────────
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || CLIENT_ORIGINS.includes('*') || CLIENT_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Job-Token');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ─── General middleware ───────────────────────────────────────────────────────
app.use(compression());
app.use(requestId);
app.use(express.json({ limit: '16kb' })); // strict payload limit

// ─── Global API rate limiter ──────────────────────────────────────────────────
app.use('/api', apiLimiter);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/v1/media', mediaRoutes);

// ─── Health endpoint ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'ytmp34', ts: new Date().toISOString() });
});

// ─── Static frontend ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  extensions: ['html'],
}));

// SPA fallback
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handler (must be last) ────────────────────────────────────────────
app.use(errorHandler);

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  // Initialize YouTube cookies if provided via environment
  initCookies();

  // Verify yt-dlp is reachable before accepting requests
  try {
    await checkAvailability();
  } catch (err) {
    logger.error('Startup check failed', { error: err.message });
    logger.warn('Server will start but media processing will be unavailable until yt-dlp is installed.');
  }

  // Recover any jobs that were RUNNING when the server last crashed/restarted
  try {
    const recovered = await recoverOrphanedJobs();
    if (recovered > 0) logger.warn(`Recovered ${recovered} orphaned job(s) from previous session`);
  } catch (err) {
    logger.warn('Job recovery scan failed (non-fatal)', { error: err.message });
  }

  // Start background cleanup
  startCleanup();

  app.listen(PORT, HOST, () => {
    logger.info('YTmp3/4 server started', { port: PORT, host: HOST, node: process.version });
  });
}

start().catch(err => {
  logger.error('Fatal startup error', { error: err.message });
  process.exit(1);
});
