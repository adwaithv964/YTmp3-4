import { AppError } from '../errors.js';
import { logger }   from '../logger.js';

/**
 * Global error handler.
 *
 * SECURITY: Never expose stack traces, file paths, or internal error details.
 * Only the `code` and `message` from AppError subclasses are sent to the client.
 * All other errors produce a generic 500.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const requestId = req.requestId || 'unknown';

  if (err instanceof AppError) {
    // Known, safe error — log at warn level and return the safe message
    logger.warn('Request error', {
      requestId,
      code:   err.code,
      status: err.status,
      msg:    err.message,
    });

    return res.status(err.status).json({
      success: false,
      error: {
        code:    err.code,
        message: err.message,
      },
    });
  }

  // Unknown error — log internally but return a generic message
  logger.error('Unhandled error', {
    requestId,
    error: err.message,
    // Stack logged server-side only, never sent to client
  });

  return res.status(500).json({
    success: false,
    error: {
      code:    'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again.',
    },
  });
}
