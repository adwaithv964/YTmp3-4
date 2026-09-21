/**
 * Application error classes.
 *
 * Each class carries a machine-readable `code` (sent to client),
 * a human-readable `message` (also sent to client — keep it safe),
 * and an HTTP `status`.
 *
 * Internal details (stack traces, file paths, provider errors) must
 * NEVER reach the client; the error handler strips them.
 */

export class AppError extends Error {
  /**
   * @param {string} code   - Machine-readable error code e.g. 'INVALID_URL'
   * @param {string} message - Safe, user-facing message
   * @param {number} status  - HTTP status code
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

// ─── Validation errors (400) ──────────────────────────────────────────────────
export class ValidationError extends AppError {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(code, message, 400);
    this.name = 'ValidationError';
  }
}

// ─── SSRF / blocked source errors (400) ──────────────────────────────────────
export class BlockedSourceError extends AppError {
  constructor(message = 'This source cannot be accessed.') {
    super('BLOCKED_SOURCE', message, 400);
    this.name = 'BlockedSourceError';
  }
}

// ─── Unsupported source (422) ─────────────────────────────────────────────────
export class UnsupportedSourceError extends AppError {
  constructor(message = 'This source is not supported by the configured provider.') {
    super('UNSUPPORTED_SOURCE', message, 422);
    this.name = 'UnsupportedSourceError';
  }
}

// ─── Provider errors (502) ───────────────────────────────────────────────────
export class ProviderError extends AppError {
  constructor(message = 'The media provider returned an error. The source may be unavailable.') {
    super('PROVIDER_ERROR', message, 502);
    this.name = 'ProviderError';
  }
}

// ─── Job not found (404) ─────────────────────────────────────────────────────
export class JobNotFoundError extends AppError {
  constructor() {
    super('JOB_NOT_FOUND', 'Job not found or token is invalid.', 404);
    this.name = 'JobNotFoundError';
  }
}

// ─── Forbidden (403) ─────────────────────────────────────────────────────────
export class ForbiddenError extends AppError {
  constructor(message = 'Access denied.') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

// ─── Processing errors (500) ─────────────────────────────────────────────────
export class ProcessingError extends AppError {
  constructor(message = 'Media processing failed. Please try again.') {
    super('PROCESSING_ERROR', message, 500);
    this.name = 'ProcessingError';
  }
}

// ─── Rate limit (429) ────────────────────────────────────────────────────────
// Note: express-rate-limit handles 429 itself; this class is for programmatic use.
export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please wait before trying again.') {
    super('RATE_LIMITED', message, 429);
    this.name = 'RateLimitError';
  }
}

// ─── Storage full / size limit (413) ─────────────────────────────────────────
export class FileTooLargeError extends AppError {
  constructor(message = 'The output file exceeds the maximum allowed size.') {
    super('FILE_TOO_LARGE', message, 413);
    this.name = 'FileTooLargeError';
  }
}

// ─── Format Plan Errors ───────────────────────────────────────────────────────
export class FormatPlanNotFoundError extends AppError {
  constructor(message = 'Format plan not found. Please refresh and select a format again.') {
    super('FORMAT_PLAN_NOT_FOUND', message, 400);
    this.name = 'FormatPlanNotFoundError';
  }
}

export class FormatPlanExpiredError extends AppError {
  constructor(message = 'This format selection has expired. Refresh the video information and try again.') {
    super('FORMAT_PLAN_EXPIRED', message, 410);
    this.name = 'FormatPlanExpiredError';
  }
}

export class FormatPlanMismatchError extends AppError {
  constructor(message = 'Downloaded media characteristics did not match the selected format plan.') {
    super('FORMAT_PLAN_MISMATCH', message, 500);
    this.name = 'FormatPlanMismatchError';
  }
}

export class MediaValidationError extends AppError {
  constructor(message = 'Downloaded media validation failed.') {
    super('MEDIA_VALIDATION_FAILED', message, 500);
    this.name = 'MediaValidationError';
  }
}

export class FfmpegUnavailableError extends AppError {
  constructor(message = 'FFmpeg is required for media processing but is unavailable.') {
    super('FFMPEG_UNAVAILABLE', message, 500);
    this.name = 'FfmpegUnavailableError';
  }
}
