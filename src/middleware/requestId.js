import crypto from 'node:crypto';

/**
 * Attaches a unique X-Request-ID to every request/response.
 * Used for log correlation. Never exposes sensitive data.
 */
export function requestId(req, res, next) {
  const id = crypto.randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}
