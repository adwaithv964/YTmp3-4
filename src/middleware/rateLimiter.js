import rateLimit from 'express-rate-limit';

const handler = (req, res) => {
  res.status(429).json({
    success: false,
    error: {
      code:    'RATE_LIMITED',
      message: 'Too many requests. Please wait before trying again.',
    },
  });
};

/** Lightweight validation — 60 req/min per IP */
export const validateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/** Metadata fetch — 20 req/min per IP (calls yt-dlp) */
export const metadataLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/** Job creation — 20 per 5 min per IP (spawns a process) */
export const createJobLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/** Job status polling — 180 req/min per IP */
export const pollLimiter = rateLimit({
  windowMs: 60_000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/** Download endpoint — 30 req/min per IP */
export const downloadLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/** General API rate limit — 180 req/min per IP */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});
