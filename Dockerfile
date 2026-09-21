# ─── Base ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# ─── System dependencies ──────────────────────────────────────────────────────
# ffmpeg: used internally by yt-dlp to merge video+audio streams and convert formats.
# python3 + pip: required to run yt-dlp as a Python module.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp into a virtual environment (avoids PEP 668 conflicts on bookworm)
RUN python3 -m venv /opt/ytdlp-venv && \
    /opt/ytdlp-venv/bin/pip install --no-cache-dir yt-dlp && \
    ln -s /opt/ytdlp-venv/bin/python3 /usr/local/bin/python3-ytdlp

# ─── App ─────────────────────────────────────────────────────────────────────
WORKDIR /app

ENV NODE_ENV=production
# Use the venv python for yt-dlp
ENV PYTHON_CMD=/opt/ytdlp-venv/bin/python3

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Create data directories
RUN mkdir -p /app/data/jobs /app/data/tmp

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
