import { Router } from 'express';
import path       from 'node:path';
import fs         from 'node:fs';
import { validateUrl }        from '../validators/mediaValidator.js';
import { validateJobRequest } from '../validators/mediaValidator.js';
import { getMetadata }        from '../providers/ytdlProvider.js';
import {
  createJob, getJob, cancelJob, STATUS, readManifest,
} from '../services/jobService.js';
import { processJob, killProcess } from '../services/processingService.js';
import { streamToResponse }       from '../services/streamService.js';
import { jobDir, safeFilename }    from '../services/storageService.js';
import {
  validateLimiter, metadataLimiter, createJobLimiter,
  pollLimiter, downloadLimiter,
} from '../middleware/rateLimiter.js';
import { logger } from '../logger.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

/** Extract job token from header or query param. */
function extractToken(req) {
  return (
    req.headers['x-job-token'] ||
    req.query.token ||
    null
  );
}

// ─── POST /api/v1/media/validate ─────────────────────────────────────────────
router.post('/validate', validateLimiter, (req, res, next) => {
  try {
    const { url: parsedUrl, host } = validateUrl(req.body?.url);
    return ok(res, {
      valid:   true,
      domain:  host,
      scheme:  parsedUrl.protocol.replace(':', ''),
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/media/metadata ─────────────────────────────────────────────
router.post('/metadata', metadataLimiter, async (req, res, next) => {
  try {
    validateUrl(req.body?.url); // throws if invalid
    const meta = await getMetadata(String(req.body.url).trim());
    return ok(res, meta);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/media/stream ────────────────────────────────────────────────
// Instant streaming download — yt-dlp pipes directly to the browser.
// Download starts in seconds. No disk storage on server.
router.post('/stream', downloadLimiter, async (req, res, next) => {
  try {
    const validated = validateJobRequest(req.body);
    const { urlString, format, quality, bitrate } = validated;
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 200) : 'download';

    const filename = safeFilename(title, format);
    const mimeType = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    logger.info('Stream download started', { format, quality, requestId: req.requestId });

    const procs = streamToResponse(urlString, format, quality, bitrate, res);

    // Kill all spawned processes when client disconnects prematurely
    res.on('close', () => {
      if (!res.writableEnded) {
        Object.values(procs).forEach(p => { if (p && !p.killed) p.kill('SIGKILL'); });
      }
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/media/jobs ─────────────────────────────────────────────────
router.post('/jobs', createJobLimiter, async (req, res, next) => {

  try {
    const validated = validateJobRequest(req.body);

    // Title comes from the client (already fetched via /metadata) — no extra yt-dlp spawn needed
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 200) : '';

    const { jobId, token, expiresAt } = await createJob({ ...validated, title });

    // Fire-and-forget: process runs in background; client polls
    processJob(jobId).catch(err =>
      logger.error('processJob unhandled rejection', { jobId, error: err.message }),
    );

    logger.info('Job queued', { jobId, format: validated.format, requestId: req.requestId });

    return ok(res, { jobId, token, expiresAt }, 201);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/media/jobs/:id ──────────────────────────────────────────────
router.get('/jobs/:id', pollLimiter, async (req, res, next) => {
  try {
    const token   = extractToken(req);
    const manifest = await getJob(req.params.id, token);

    const responseData = {
      jobId:         manifest.jobId,
      planId:        manifest.planId || null,
      formatPlan:    manifest.formatPlan || null,
      status:        manifest.status,
      progress:      manifest.progress,
      format:        manifest.format,
      quality:       manifest.quality,
      bitrate:       manifest.bitrate,
      title:         manifest.title,
      createdAt:     manifest.createdAt,
      expiresAt:     manifest.expiresAt,
      formatDetails: manifest.formatDetails || (manifest.formatPlan ? {
        quality:    manifest.formatPlan.quality?.label || manifest.quality,
        width:      manifest.formatPlan.quality?.width || 0,
        height:     manifest.formatPlan.quality?.height || 0,
        fps:        manifest.formatPlan.quality?.fps || 30,
        videoCodec: manifest.formatPlan.video?.codecName || '',
        audioCodec: manifest.formatPlan.audio?.codecName || '',
        container:  manifest.formatPlan.output?.container || manifest.format,
      } : null),
      size: manifest.size || (manifest.formatPlan ? {
        estimatedBytes:     manifest.formatPlan.output?.estimatedBytes || 0,
        estimatedFormatted: manifest.formatPlan.output?.estimatedFormatted || '',
        actualBytes:        manifest.actualSizeBytes || manifest.fileSizeBytes || 0,
        actualFormatted:    manifest.actualSizeFormatted || '',
      } : null),
    };

    // Only expose download URL and file info when completed
    if (manifest.status === STATUS.COMPLETED && manifest.artifactReady) {
      responseData.filename       = safeFilename(manifest.title, manifest.format);
      responseData.fileSizeBytes  = manifest.fileSizeBytes;
      responseData.actualBytes    = manifest.actualSizeBytes || manifest.fileSizeBytes;
      responseData.actualFormatted= manifest.actualSizeFormatted || '';
      responseData.downloadUrl    = `/api/v1/media/jobs/${manifest.jobId}/download?token=${encodeURIComponent(token)}`;
    }

    // Include error details for failed jobs
    if (manifest.status === STATUS.FAILED) {
      responseData.errorCode    = manifest.errorCode;
      responseData.errorMessage = manifest.errorMessage;
    }

    return ok(res, responseData);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/media/jobs/:id/cancel ──────────────────────────────────────
router.post('/jobs/:id/cancel', pollLimiter, async (req, res, next) => {
  try {
    const token      = extractToken(req);
    const prevStatus = await cancelJob(req.params.id, token);

    // Kill any running process
    if (prevStatus === STATUS.RUNNING) {
      killProcess(req.params.id);
    }

    return ok(res, { cancelled: true });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/media/jobs/:id/download ─────────────────────────────────────
router.get('/jobs/:id/download', downloadLimiter, async (req, res, next) => {
  try {
    const token    = extractToken(req);
    const manifest = await getJob(req.params.id, token);

    if (manifest.status !== STATUS.COMPLETED || !manifest.artifactReady) {
      return res.status(409).json({
        success: false,
        error: { code: 'NOT_READY', message: 'The artifact is not ready for download.' },
      });
    }

    const filePath  = path.join(jobDir(manifest.jobId), manifest.outputFile);
    const filename  = safeFilename(manifest.title, manifest.format);
    const mimeType  = manifest.format === 'mp3' ? 'audio/mpeg' : 'video/mp4';

    // Verify file still exists (may have been cleaned up)
    if (!fs.existsSync(filePath)) {
      return res.status(410).json({
        success: false,
        error: { code: 'ARTIFACT_GONE', message: 'The file has been deleted. Please create a new job.' },
      });
    }

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(manifest.fileSizeBytes));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    logger.info('Download started', { jobId: manifest.jobId, format: manifest.format, requestId: req.requestId });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end('Download failed.');
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/media/history ───────────────────────────────────────────────
// Client-driven history: client sends a list of {jobId, token} pairs and we
// return their current statuses. This avoids server-side session storage.
router.post('/history', pollLimiter, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.jobs) ? req.body.jobs.slice(0, 20) : [];
    const results = await Promise.all(
      items.map(async ({ jobId, token }) => {
        try {
          const manifest = await getJob(jobId, token);
          return {
            jobId:     manifest.jobId,
            status:    manifest.status,
            title:     manifest.title,
            format:    manifest.format,
            createdAt: manifest.createdAt,
            expiresAt: manifest.expiresAt,
          };
        } catch {
          return { jobId, status: 'NOT_FOUND' };
        }
      }),
    );
    return ok(res, { jobs: results });
  } catch (err) {
    next(err);
  }
});

export default router;
