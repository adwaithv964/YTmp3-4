# YTmp3/4

YouTube to MP3 & MP4 converter. Privacy-first — files are auto-deleted after 1 hour. Part of the [MultiTool](https://multitool-hub.vercel.app/) platform.

## Features

- MP4 video download (360p → 4K, source-aware quality options)
- MP3 audio extraction (128–320 kbps CBR)
- Job progress tracking with real-time polling
- Automatic artifact cleanup (1-hour TTL)
- No accounts, no tracking

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML + CSS + JS (served by Express) |
| Backend | Node.js 22 + Express 5 |
| Media provider | yt-dlp (Python module) |
| Conversion | FFmpeg (via yt-dlp internals) |
| Storage | Local disk (JSON manifests + files in `data/`) |
| Deployment | Render (Docker) |

## Quick start

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Generate a secret key and paste it into .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Install dependencies
npm install

# 4. Start dev server (requires Python + yt-dlp installed)
npm run dev
# → http://localhost:3000
```

### Windows dev note

On Windows, set `PYTHON_CMD=python` in `.env` (Python 3 is invoked as `python`, not `python3`).

Install yt-dlp: `pip install yt-dlp`

FFmpeg: download from https://ffmpeg.org/download.html and add to PATH.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DOWNLOAD_TOKEN_SECRET` | ✅ Yes | random (not stable) | HMAC key for job ownership tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | No | `3000` | HTTP listen port |
| `HOST` | No | `0.0.0.0` | Listen address |
| `CLIENT_ORIGIN` | No | `*` | CORS allowed origins (comma-separated) |
| `MAX_OUTPUT_BYTES` | No | `524288000` | Max output file size (500 MB) |
| `MAX_JOB_SECONDS` | No | `300` | Max processing time before timeout (5 min) |
| `JOB_EXPIRY_MINUTES` | No | `60` | How long completed artifacts are kept |
| `DATA_DIR` | No | `./data` | Path to the jobs/tmp data directory |
| `PYTHON_CMD` | No | `python3` | Python command (`python3` on Linux, `python` on Windows) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

## Deployment: Render (Docker)

### 1. Create a Web Service on Render

- **Environment**: Docker
- **Dockerfile path**: `Dockerfile`
- **Port**: `3000`

### 2. Add a Render Disk

> [!IMPORTANT]
> Without a Render Disk, the `data/` directory is **ephemeral** — all job files are lost on every deploy/restart. This is acceptable for the 1-hour TTL design but means jobs created before a restart will be unrecoverable.
>
> For production: add a **Render Disk** mounted at `/app/data` and set `DATA_DIR=/app/data`.

### 3. Environment variables on Render

Set all required variables in the Render dashboard:

```
DOWNLOAD_TOKEN_SECRET = <your generated 64-hex-char key>
NODE_ENV              = production
PYTHON_CMD            = /opt/ytdlp-venv/bin/python3
DATA_DIR              = /app/data
CLIENT_ORIGIN         = *
```

### 4. Health check

Configure Render health check path: `/api/health`

Expected response: `{"ok":true,"service":"ytmp34",...}`

### 5. Docker build verification

```bash
docker build -t ytmp34 .
docker run -p 3000:3000 -e DOWNLOAD_TOKEN_SECRET=test ytmp34
```

## Deployment: Vercel (optional, frontend-only)

The frontend is served by the same Express server, so no separate Vercel deployment is needed.

If you want to deploy the frontend separately (e.g., for CDN caching):
1. Copy `public/` contents to a new Vercel static project
2. Update `API_BASE_URL` and configure CORS on the Render backend
3. Set `CLIENT_ORIGIN=https://your-vercel-url.vercel.app` on Render

## API

All responses follow `{ success: true, data: {...} }` / `{ success: false, error: { code, message } }`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/v1/media/validate` | Validate URL (fast, no network) |
| `POST` | `/api/v1/media/metadata` | Fetch video metadata from YouTube |
| `POST` | `/api/v1/media/jobs` | Create a conversion job |
| `GET` | `/api/v1/media/jobs/:id?token=TOKEN` | Poll job status |
| `POST` | `/api/v1/media/jobs/:id/cancel?token=TOKEN` | Cancel a running job |
| `GET` | `/api/v1/media/jobs/:id/download?token=TOKEN` | Download completed artifact |
| `POST` | `/api/v1/media/history` | Bulk status check for history items |

## Security

- **SSRF protection**: URL validation blocks localhost, loopback (127.x), RFC-1918 ranges (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x), CGNAT (100.64-127.x), IPv6 loopback/ULA
- **Host allowlist**: Only `youtube.com`, `youtu.be`, `m.youtube.com`, `music.youtube.com`
- **Shell injection**: All yt-dlp calls use `spawn(cmd, [args])` array form — shell is never invoked
- **Path traversal**: Job IDs are validated against UUID v4 regex before any `path.join`
- **Job isolation**: Jobs are accessed via HMAC-verified tokens; cross-user access is impossible
- **No arbitrary FFmpeg args**: Users can only select from whitelisted format/quality/bitrate options
- **Process timeout**: FFmpeg/yt-dlp killed after `MAX_JOB_SECONDS`
- **Size limit**: Output rejected if larger than `MAX_OUTPUT_BYTES`
- **Cleanup**: Artifacts deleted after `JOB_EXPIRY_MINUTES` (default 1 hour)
- **CSP**: Strict content security policy; thumbnail images from ytimg.com explicitly allowed

## Project structure

```
YT_mp3_mp4_convertion/
├── server.js                     ← Express entry point
├── src/
│   ├── config.js                 ← All environment config
│   ├── logger.js                 ← Structured JSON logger
│   ├── errors.js                 ← Error class hierarchy
│   ├── validators/
│   │   └── mediaValidator.js     ← SSRF-safe URL + option validation
│   ├── providers/
│   │   ├── providerInterface.js  ← JSDoc contract
│   │   └── ytdlProvider.js       ← yt-dlp subprocess wrapper
│   ├── services/
│   │   ├── jobService.js         ← Job CRUD (JSON manifests on disk)
│   │   ├── processingService.js  ← Async download + convert orchestrator
│   │   ├── storageService.js     ← Path helpers, tokens, cleanup utils
│   │   └── cleanupService.js     ← Periodic artifact cleanup
│   ├── middleware/
│   │   ├── requestId.js          ← X-Request-ID header
│   │   ├── rateLimiter.js        ← Per-endpoint rate limits
│   │   └── errorHandler.js       ← Safe error responses
│   └── routes/
│       └── mediaRoutes.js        ← All /api/v1/media/* routes
├── public/
│   ├── index.html                ← Full page structure
│   ├── styles.css                ← Design system + all component states
│   └── app.js                    ← Vanilla JS state machine
├── Dockerfile                    ← node:22 + ffmpeg + yt-dlp venv
├── docker-compose.yml
└── .env.example
```

## Architecture: Immutable Format Plan System

YTmp3/4 implements a deterministic **Immutable Format Plan Architecture** that bridges metadata analysis and download execution so displayed resolutions, format IDs, and downloaded files match with technical accuracy.

### End-to-End Workflow Diagram

```text
URL
 ↓
yt-dlp metadata inspection
 ↓
Format analyzer (formatPlanService)
 ↓
Immutable format plans (UUID + HMAC signature, 30-min TTL)
 ↓
Frontend quality selector (dimensions, FPS, codec, exact/approx size)
 ↓
planId
 ↓
Backend plan lookup & signature verification
 ↓
Exact stored format IDs
 ↓
yt-dlp download
 ↓
Direct download OR FFmpeg lossless stream copy (-c copy)
 ↓
ffprobe media stream & container validation
 ↓
fs.stat() authoritative actual size measurement
 ↓
Browser download
```

### 1. Format Plan Architecture & Immutability
- Formats are inspected once during metadata extraction (`POST /api/v1/media/metadata`).
- An immutable plan is created for each available resolution tier (2160, 1440, 1080, 720, 480, 360, 240) and audio bitrate (128, 192, 256, 320 kbps).
- Each plan specifies exact `videoFormatId` and `audioFormatId`.
- Download jobs submit only the `planId`. The backend retrieves the exact stored format IDs.
- **No dynamic recalculation**: The download phase never runs another quality selector (e.g. `best`, `bestvideo`) during download execution.

### 2. Size Calculation Rules
- Source stream sizes follow strict priority:
  1. `filesize` → genuine exact source byte count
  2. `filesize_approx` → approximate estimate
  3. `bitrate * duration` → mathematical estimate
  4. `unavailable`
- **Exact vs. Approximate Distinction**:
  - Direct combined streams with exact source filesize are presented without prefix (e.g. `92.4 MB`).
  - Merged or bitrate-calculated streams always contain the `~` indicator (e.g. `~92 MB`).
- **Separate Stream Output Estimation**:
  `estimatedFinalBytes = videoBytes + audioBytes + containerOverhead`
  Treated as approximate due to MP4 atom, padding, and mux metadata overhead.

### 3. Direct Download vs. FFmpeg Stream Copy
- **Direct Download Fast Path**: If a container-compatible combined video+audio format exists matching the requested tier (e.g. 720p/360p pre-merged MP4), yt-dlp downloads it directly without invoking FFmpeg.
- **Lossless FFmpeg Stream Copy (`-c copy`)**: When separate high-resolution DASH video and audio streams are required (e.g. 1080p, 1440p, 4K), yt-dlp downloads the exact streams and FFmpeg performs stream-copy muxing (`-c copy`) into the MP4 container.
  - Zero generational loss (no decode/encode cycles).
  - Minimal CPU consumption.
  - Muxing finishes in <1 second.

### 4. Codec Selection Policies
- **Maximum Compatibility (default for MP4)**:
  - Prioritizes H.264 (`avc1`) video + AAC (`mp4a`/`m4a`) audio in an MP4 container.
  - If H.264 is unavailable at higher tiers (e.g. 1440p/4K on YouTube), container-compatible streams (e.g. AV1/VP9) are selected.
- **Audio / MP3**:
  - Displays source audio characteristics (`Source: Opus • ~136 kbps`) separately from output transcode options (128, 192, 256, 320 kbps).

### 5. Plan Expiration & Tamper Protection
- Plans expire after **30 minutes**.
- Each plan is cryptographically signed using HMAC-SHA256 (`DOWNLOAD_TOKEN_SECRET`).
- If an expired plan is submitted, the API returns HTTP 410 (`FORMAT_PLAN_EXPIRED`), prompting the user to refresh video info.

### 6. Media Validation & Actual Size Verification
- Post-download, `mediaValidationService` inspects the output file using `ffprobe`:
  - Validates container format (`mp4` or `mp3`).
  - Verifies video and audio streams exist.
  - Compares dimensions against planned dimensions (with cinematic aspect ratio tolerance).
  - Validates duration > 0 and codec compatibility.
- `fs.stat()` measures the final filesystem byte count as authoritative.
- Both estimated and actual sizes are returned to the frontend and displayed in the result card.

### 7. Troubleshooting
- **`FORMAT_PLAN_EXPIRED`**: The 30-minute plan validity expired. Re-click "Get info" to generate fresh format plans.
- **`EMPTY_OUTPUT` or `FFMPEG_UNAVAILABLE`**: Ensure FFmpeg and ffprobe are installed and available on PATH or configured in `FFMPEG_LOCATION`.
- **`FORMAT_PLAN_MISMATCH`**: The downloaded streams did not match the planned characteristics. Check yt-dlp version and format availability.

## Limitations

- **YouTube ToS**: Only use for content you own, have rights to, or that is explicitly licensed for download.
- **yt-dlp compatibility**: YouTube occasionally breaks yt-dlp. Update with `pip install --upgrade yt-dlp` if downloads fail.
- **Ephemeral filesystem**: On Render without a Persistent Disk, `data/` is lost on restart. Mount a Render Disk at `/app/data` for persistent job retention.
