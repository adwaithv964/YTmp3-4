(() => {
  'use strict';

  // ─── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  const urlInput        = $('urlInput');
  const urlClearBtn     = $('urlClearBtn');
  const fetchBtn        = $('fetchBtn');
  const urlStatus       = $('urlStatus');
  const urlInputWrap    = $('urlInputWrap');

  const metaCard        = $('metaCard');
  const metaThumb       = $('metaThumb');
  const metaDuration    = $('metaDuration');
  const metaTitle       = $('metaTitle');
  const metaUploader    = $('metaUploader');
  const changeUrlBtn    = $('changeUrlBtn');

  const settingsCard       = $('settingsCard');
  const fmtMp4Btn          = $('fmtMp4Btn');
  const fmtMp3Btn          = $('fmtMp3Btn');
  const videoSettings      = $('videoSettings');
  const audioSettings      = $('audioSettings');
  const qualityPlanList    = $('qualityPlanList');
  const audioSourceDetails = $('audioSourceDetails');
  const audioPlanList      = $('audioPlanList');
  const downloadBtn        = $('downloadBtn');
  const downloadBtnLabel   = $('downloadBtnLabel');

  const progressCard       = $('progressCard');
  const progressTitle      = $('progressTitle');
  const progressStatusBadge= $('progressStatusBadge');
  const progressTrack      = $('progressTrack');
  const progressBar        = $('progressBar');
  const progressPhaseLabel = $('progressPhaseLabel');
  const progressPercent    = $('progressPercent');
  const cancelBtn          = $('cancelBtn');

  const resultCard         = $('resultCard');
  const resultTitle        = $('resultTitle');
  const resultQualityLine  = $('resultQualityLine');
  const resultTechnicalLine= $('resultTechnicalLine');
  const resultSizeRow      = $('resultSizeRow');
  const resultExpiry       = $('resultExpiry');
  const downloadLink       = $('downloadLink');
  const newConvertBtn      = $('newConvertBtn');

  const errorCard    = $('errorCard');
  const errorTitle   = $('errorTitle');
  const errorMessage = $('errorMessage');
  const retryBtn     = $('retryBtn');

  const historySection  = $('historySection');
  const historyList     = $('historyList');
  const clearHistoryBtn = $('clearHistoryBtn');

  // ─── State ──────────────────────────────────────────────────────────────────
  let state = {
    metadata:       null,   // MediaMetadata from server
    formatPlans:    null,   // { mp4: [], mp3: [] }
    selectedFormat: null,   // 'mp4' | 'mp3'
    selectedPlanId: null,   // active format plan ID
    selectedPlan:   null,   // active format plan object
    currentJobId:   null,
    currentToken:   null,
    pollTimer:      null,
  };

  // ─── History (localStorage) ──────────────────────────────────────────────────
  const HISTORY_KEY = 'ytmp34_history';
  const MAX_HISTORY = 10;

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { return []; }
  }
  function saveHistory(items) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); } catch {}
  }
  function addToHistory(jobId, token, title, format) {
    const items = loadHistory();
    const existing = items.findIndex(i => i.jobId === jobId);
    if (existing !== -1) items.splice(existing, 1);
    items.unshift({ jobId, token, title, format, createdAt: new Date().toISOString() });
    if (items.length > MAX_HISTORY) items.length = MAX_HISTORY;
    saveHistory(items);
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
    );
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1024**2)    return `${(bytes/1024).toFixed(1)} KB`;
    if (bytes < 1024**3)    return `${(bytes/1024**2).toFixed(1)} MB`;
    return `${(bytes/1024**3).toFixed(2)} GB`;
  }

  function relativeExpiry(isoString) {
    const ms = new Date(isoString).getTime() - Date.now();
    if (ms <= 0) return 'Expired';
    const m = Math.round(ms / 60000);
    if (m < 60) return `Expires in ${m} minute${m !== 1 ? 's' : ''}`;
    const h = Math.round(m / 60);
    return `Expires in ${h} hour${h !== 1 ? 's' : ''}`;
  }

  // Client-side URL validation (UI feedback only — server always validates)
  function isLikelyYouTube(url) {
    try {
      const p = new URL(url);
      const h = p.hostname.replace(/^www\./, '');
      return ['youtube.com','youtu.be','m.youtube.com','music.youtube.com'].includes(h);
    } catch { return false; }
  }

  // ─── UI helpers ─────────────────────────────────────────────────────────────
  function show(el)  { el.classList.remove('hidden'); }
  function hide(el)  { el.classList.add('hidden'); }

  function setUrlStatus(msg, kind = '') {
    urlStatus.textContent = msg;
    urlStatus.className = `url-status${kind ? ' ' + kind : ''}`;
  }

  function setFetchLoading(loading) {
    $('fetchBtnText') || (fetchBtn.querySelector('.fetch-btn-text').id = 'fetchBtnText');
    const text    = fetchBtn.querySelector('.fetch-btn-text');
    const spinner = fetchBtn.querySelector('.fetch-btn-spinner');
    if (loading) {
      text.hidden = true;
      spinner.hidden = false;
      fetchBtn.disabled = true;
    } else {
      text.hidden = false;
      spinner.hidden = true;
    }
  }

  function resetToIdle() {
    stopPolling();
    state.metadata       = null;
    state.formatPlans    = null;
    state.selectedFormat = null;
    state.selectedPlanId = null;
    state.selectedPlan   = null;
    state.currentJobId   = null;
    state.currentToken   = null;

    hide(metaCard);
    hide(settingsCard);
    hide(progressCard);
    hide(resultCard);
    hide(errorCard);
    show(urlInputWrap);

    setUrlStatus('');
    urlInput.classList.remove('valid', 'invalid');
    setFetchLoading(false);
    fetchBtn.disabled = !isLikelyYouTube(urlInput.value);
    downloadBtn.disabled = false;
    downloadBtnLabel.textContent = 'Download';
  }

  function showError(title, message, retryAction = null) {
    errorTitle.textContent   = escHtml(title);
    errorMessage.textContent = escHtml(message);
    // Store retry action on the element (avoids inline onclick CSP issues)
    retryBtn._retryAction = retryAction || resetToIdle;
    show(errorCard);
  }

  // ─── Metadata & Plan Display ────────────────────────────────────────────────
  function renderMetadata(meta) {
    metaThumb.src = meta.thumbnail || '';
    metaThumb.alt = meta.title || 'Thumbnail';
    metaDuration.textContent = meta.durationString || '';

    metaTitle.textContent    = meta.title || 'Unknown title';
    metaUploader.textContent = meta.uploader || '';

    show(metaCard);

    state.formatPlans = meta.formatPlans || { mp4: [], mp3: [] };
    const mp4Plans = state.formatPlans.mp4 || [];
    const mp3Plans = state.formatPlans.mp3 || [];

    // ── Render MP4 Quality Plans ─────────────────────────────────────────────
    qualityPlanList.innerHTML = '';
    if (mp4Plans.length > 0) {
      mp4Plans.forEach((plan, idx) => {
        const card = document.createElement('div');
        card.className = 'quality-plan-card';
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', idx === 0 ? 'true' : 'false');
        card.setAttribute('tabindex', '0');
        card.dataset.planId = plan.planId;

        const mainDiv = document.createElement('div');
        mainDiv.className = 'plan-main';

        const labelRow = document.createElement('div');
        labelRow.className = 'plan-label-row';

        const label = document.createElement('span');
        label.className = 'plan-label';
        label.textContent = plan.quality.label || `${plan.quality.height}p`;
        labelRow.appendChild(label);

        if (plan.quality.hdr) {
          const hdrTag = document.createElement('span');
          hdrTag.className = 'plan-tag';
          hdrTag.textContent = 'HDR';
          labelRow.appendChild(hdrTag);
        }

        if (plan.selectionPolicy === 'maximum_quality') {
          const polTag = document.createElement('span');
          polTag.className = 'plan-tag-policy policy-quality';
          polTag.textContent = 'Max Quality';
          labelRow.appendChild(polTag);
        } else if (plan.selectionPolicy === 'maximum_compatibility') {
          const polTag = document.createElement('span');
          polTag.className = 'plan-tag-policy policy-compat';
          polTag.textContent = 'Max Compatibility';
          labelRow.appendChild(polTag);
        }
        mainDiv.appendChild(labelRow);

        const details = document.createElement('div');
        details.className = 'plan-details';
        const vcodec = plan.video?.codecName || 'Video';
        const fpsStr = plan.quality.fps ? ` • ${plan.quality.fps} FPS` : '';
        details.textContent = `${plan.quality.width}×${plan.quality.height}${fpsStr} • ${vcodec}`;
        mainDiv.appendChild(details);

        card.appendChild(mainDiv);

        const sizeBox = document.createElement('div');
        sizeBox.className = 'plan-size-box';

        const sizeVal = document.createElement('span');
        sizeVal.className = 'plan-size-val';
        sizeVal.textContent = plan.output.estimatedFormatted || 'Size unavailable';
        sizeBox.appendChild(sizeVal);

        const conf = plan.output.confidence || 'unavailable';
        if (conf !== 'unavailable') {
          const confBadge = document.createElement('span');
          confBadge.className = `plan-conf-badge conf-${conf}`;
          const confLabels = {
            exact: 'Exact',
            approximate: 'Estimated',
            calculated: 'Calculated',
          };
          confBadge.textContent = confLabels[conf] || 'Estimated';
          sizeBox.appendChild(confBadge);
        }

        card.appendChild(sizeBox);

        const selectThisPlan = () => {
          qualityPlanList.querySelectorAll('.quality-plan-card').forEach(c => {
            c.setAttribute('aria-checked', 'false');
          });
          card.setAttribute('aria-checked', 'true');
          state.selectedPlanId = plan.planId;
          state.selectedPlan = plan;
          const est = plan.output?.estimatedFormatted ? ` (${plan.output.estimatedFormatted})` : '';
          downloadBtnLabel.textContent = `Download MP4${est}`;
        };

        card.addEventListener('click', selectThisPlan);
        card.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectThisPlan();
          }
        });

        qualityPlanList.appendChild(card);
      });

      // Default to first quality
      state.selectedPlanId = mp4Plans[0].planId;
      state.selectedPlan = mp4Plans[0];
    }

    // ── Render MP3 Audio Plans ───────────────────────────────────────────────
    audioPlanList.innerHTML = '';
    if (mp3Plans.length > 0) {
      const first = mp3Plans[0];
      const srcCodec = first.audio?.sourceCodecName || 'Audio';
      const srcBitrate = first.audio?.sourceBitrateKbps ? `~${first.audio.sourceBitrateKbps} kbps` : '';
      audioSourceDetails.textContent = `${srcCodec}${srcBitrate ? ' • ' + srcBitrate : ''}`;

      mp3Plans.forEach((plan, idx) => {
        const btn = document.createElement('button');
        btn.className = 'audio-plan-btn';
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        const isDefault = plan.audio?.outputBitrateKbps === 192 || (idx === 1 && mp3Plans.length >= 2);
        btn.setAttribute('aria-checked', isDefault ? 'true' : 'false');
        btn.dataset.planId = plan.planId;

        const bitrateSpan = document.createElement('span');
        bitrateSpan.className = 'audio-bitrate';
        bitrateSpan.textContent = `${plan.audio.outputBitrateKbps} kbps`;
        btn.appendChild(bitrateSpan);

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'audio-size';
        sizeSpan.textContent = plan.output.estimatedFormatted || '';
        btn.appendChild(sizeSpan);

        btn.addEventListener('click', () => {
          audioPlanList.querySelectorAll('.audio-plan-btn').forEach(b => {
            b.setAttribute('aria-checked', 'false');
          });
          btn.setAttribute('aria-checked', 'true');
          state.selectedPlanId = plan.planId;
          state.selectedPlan = plan;
          const est = plan.output?.estimatedFormatted ? ` (${plan.output.estimatedFormatted})` : '';
          downloadBtnLabel.textContent = `Download MP3${est}`;
        });

        audioPlanList.appendChild(btn);
      });
    }

    // Auto-select MP4 initially if not already selected
    selectFormat(state.selectedFormat || 'mp4');

    show(settingsCard);
  }

  // ─── Format selector ─────────────────────────────────────────────────────────
  function selectFormat(fmt) {
    state.selectedFormat = fmt;

    fmtMp4Btn.setAttribute('aria-pressed', fmt === 'mp4' ? 'true' : 'false');
    fmtMp3Btn.setAttribute('aria-pressed', fmt === 'mp3' ? 'true' : 'false');

    if (fmt === 'mp4') {
      show(videoSettings);
      hide(audioSettings);
      const activeCard = qualityPlanList.querySelector('.quality-plan-card[aria-checked="true"]') ||
                         qualityPlanList.querySelector('.quality-plan-card');
      if (activeCard) {
        const planId = activeCard.dataset.planId;
        state.selectedPlanId = planId;
        state.selectedPlan = state.formatPlans?.mp4?.find(p => p.planId === planId);
        const est = state.selectedPlan?.output?.estimatedFormatted ? ` (${state.selectedPlan.output.estimatedFormatted})` : '';
        downloadBtnLabel.textContent = `Download MP4${est}`;
      } else {
        downloadBtnLabel.textContent = 'Download MP4';
      }
    } else {
      hide(videoSettings);
      show(audioSettings);
      const activeBtn = audioPlanList.querySelector('.audio-plan-btn[aria-checked="true"]') ||
                        audioPlanList.querySelector('.audio-plan-btn');
      if (activeBtn) {
        const planId = activeBtn.dataset.planId;
        state.selectedPlanId = planId;
        state.selectedPlan = state.formatPlans?.mp3?.find(p => p.planId === planId);
        const est = state.selectedPlan?.output?.estimatedFormatted ? ` (${state.selectedPlan.output.estimatedFormatted})` : '';
        downloadBtnLabel.textContent = `Download MP3${est}`;
      } else {
        downloadBtnLabel.textContent = 'Download MP3';
      }
    }

    show(downloadBtn);
  }

  // ─── Download Media ──────────────────────────────────────────────────────────
  async function downloadMedia() {
    const urlString = urlInput.value.trim();
    if (!urlString || !state.selectedFormat || !state.selectedPlanId) return;

    downloadBtn.disabled = true;
    downloadBtnLabel.textContent = 'Preparing download…';

    try {
      const jobData = await createJob(
        state.selectedPlanId,
        urlString,
        state.metadata?.title || '',
      );

      hide(settingsCard);
      show(progressCard);
      progressTitle.textContent = state.metadata?.title || 'Processing…';
      progressStatusBadge.textContent = 'QUEUED';
      progressStatusBadge.className = 'status-badge status-badge--queued';
      progressBar.style.width = '2%';
      progressPhaseLabel.textContent = 'Queued…';
      progressPercent.textContent = '0%';
      cancelBtn.disabled = false;

      startPolling(jobData.jobId, jobData.token);
    } catch (err) {
      downloadBtn.disabled = false;
      const est = state.selectedPlan?.output?.estimatedFormatted ? ` (${state.selectedPlan.output.estimatedFormatted})` : '';
      downloadBtnLabel.textContent = `Download ${state.selectedFormat.toUpperCase()}${est}`;
      showError('Download failed', err.message, () => hide(errorCard));
    }
  }


  // ─── Progress display ────────────────────────────────────────────────────────
  function updateProgressUI(job) {
    const p = job.progress || {};
    const pct = p.percent ?? 0;

    progressTitle.textContent  = job.title || 'Processing…';
    progressPhaseLabel.textContent = p.phaseLabel || 'Processing…';
    progressPercent.textContent    = `${pct}%`;

    progressBar.style.width = `${pct}%`;
    progressTrack.setAttribute('aria-valuenow', String(pct));

    // Remove indeterminate class
    progressBar.classList.remove('indeterminate');

    // Step indicator
    const steps = {
      stepQueued:    ['QUEUED'],
      stepRunning:   ['RUNNING'],
      stepConverting:['RUNNING'],
      stepDone:      ['COMPLETED'],
    };
    const activePhases = ['merging','converting'];

    [$('stepQueued'), $('stepRunning'), $('stepConverting'), $('stepDone')].forEach(el => {
      el.classList.remove('active','done');
    });

    if (job.status === 'QUEUED') {
      $('stepQueued').classList.add('active');
    } else if (job.status === 'RUNNING') {
      $('stepQueued').classList.add('done');
      if (activePhases.includes(p.phase)) {
        $('stepRunning').classList.add('done');
        $('stepConverting').classList.add('active');
      } else {
        $('stepRunning').classList.add('active');
      }
    } else if (job.status === 'COMPLETED') {
      [$('stepQueued'),$('stepRunning'),$('stepConverting'),$('stepDone')].forEach(el => el.classList.add('done'));
    }

    // Status badge
    progressStatusBadge.textContent = job.status;
    progressStatusBadge.className = `status-badge status-badge--${job.status.toLowerCase()}`;
  }

  // ─── Polling ─────────────────────────────────────────────────────────────────
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function pollJobStatus() {
    if (!state.currentJobId || !state.currentToken) return;

    let res;
    try {
      res = await fetch(
        `/api/v1/media/jobs/${encodeURIComponent(state.currentJobId)}?token=${encodeURIComponent(state.currentToken)}`,
        { headers: { 'X-Job-Token': state.currentToken } }
      );
    } catch {
      // True network error (no connection)
      setUrlStatus('Connection issue — retrying…', 'info');
      return;
    }

    // Non-200 responses: stop polling and show error
    if (!res.ok) {
      stopPolling();
      hide(progressCard);
      const body = await res.json().catch(() => ({}));
      const msg  = body.error?.message || `Server error ${res.status}`;
      showError(
        res.status === 404 ? 'Job not found' : 'Error',
        res.status === 404
          ? 'This job has expired or failed to start. Please try again.'
          : msg,
        resetToIdle,
      );
      return;
    }

    let job;
    try {
      const body = await res.json();
      job = body.data;
    } catch {
      return; // malformed response — keep polling
    }

    updateProgressUI(job);

    if (job.status === 'COMPLETED') {
      stopPolling();
      showResult(job);
    } else if (job.status === 'FAILED') {
      stopPolling();
      hide(progressCard);
      showError(
        'Conversion failed',
        job.errorMessage || 'An error occurred. Please try again.',
        resetToIdle,
      );
    } else if (job.status === 'CANCELLED') {
      stopPolling();
      resetToIdle();
      setUrlStatus('Job cancelled.', 'info');
    } else if (job.status === 'EXPIRED') {
      stopPolling();
      hide(progressCard);
      showError('Download expired', 'This download has expired. Please start a new conversion.', resetToIdle);
    }
  }

  function startPolling(jobId, token) {
    state.currentJobId   = jobId;
    state.currentToken   = token;

    // Immediate first poll
    pollJobStatus();

    state.pollTimer = setInterval(pollJobStatus, 1500);
  }

  // ─── Result display ──────────────────────────────────────────────────────────
  function showResult(job) {
    hide(progressCard);
    resultTitle.textContent = job.title || 'Download ready';

    if (job.format === 'mp3') {
      resultQualityLine.textContent = 'MP3 Audio';
      resultTechnicalLine.textContent = `${job.bitrate || 192} kbps • MP3 Container`;
    } else {
      const details = job.formatDetails;
      resultQualityLine.textContent = details?.quality || 'MP4 Video';
      const dim = details?.width && details?.height ? `${details.width}×${details.height}` : '';
      const fps = details?.fps ? `${details.fps} FPS` : '';
      const codecs = [details?.videoCodec, details?.audioCodec].filter(Boolean).join(' + ');
      resultTechnicalLine.textContent = [dim, fps, codecs, 'MP4'].filter(Boolean).join(' • ');
    }

    // Size comparison: Estimated vs Actual
    resultSizeRow.innerHTML = '';
    const est = job.size?.estimatedFormatted;
    if (est) {
      const estSpan = document.createElement('span');
      estSpan.className = 'result-size-badge result-size-est';
      estSpan.textContent = `Estimated: ${est}`;
      resultSizeRow.appendChild(estSpan);
    }
    const act = job.size?.actualFormatted || formatBytes(job.size?.actualBytes || job.actualBytes || job.fileSizeBytes);
    if (act) {
      const actSpan = document.createElement('span');
      actSpan.className = 'result-size-badge result-size-act';
      actSpan.textContent = `Actual: ${act}`;
      resultSizeRow.appendChild(actSpan);
    }

    resultExpiry.textContent  = relativeExpiry(job.expiresAt);
    downloadLink.href         = job.downloadUrl;
    downloadLink.download     = job.filename || 'download';
    show(resultCard);

    // Update history entry with completed status
    addToHistory(job.jobId, state.currentToken, job.title, job.format);
    renderHistory();

    // Automatically trigger browser download
    try {
      const a = document.createElement('a');
      a.href = job.downloadUrl;
      a.download = job.filename || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {}
  }

  // ─── API calls ───────────────────────────────────────────────────────────────
  async function fetchMetadata(urlString) {
    const res  = await fetch('/api/v1/media/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlString }),
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error?.message || 'Failed to fetch video info.');
    return body.data;
  }

  async function createJob(planId, urlString, title) {
    const res  = await fetch('/api/v1/media/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, url: urlString, title: title || '' }),
    });
    const body = await res.json();
    if (!body.success) {
      if (body.error?.code === 'FORMAT_PLAN_EXPIRED') {
        throw new Error('This format selection has expired. Refresh the video information and try again.');
      }
      throw new Error(body.error?.message || 'Failed to create job.');
    }
    return body.data; // { jobId, token, expiresAt }
  }

  async function cancelJob(jobId, token) {
    await fetch(`/api/v1/media/jobs/${encodeURIComponent(jobId)}/cancel?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'X-Job-Token': token },
    });
  }

  // ─── Event: URL input ────────────────────────────────────────────────────────
  let validateDebounce = null;

  urlInput.addEventListener('input', () => {
    const val = urlInput.value.trim();

    urlClearBtn.hidden = val.length === 0;

    clearTimeout(validateDebounce);
    validateDebounce = setTimeout(() => {
      if (!val) {
        urlInput.classList.remove('valid','invalid');
        setUrlStatus('');
        fetchBtn.disabled = true;
        return;
      }
      if (isLikelyYouTube(val)) {
        urlInput.classList.remove('invalid');
        urlInput.classList.add('valid');
        setUrlStatus('');
        fetchBtn.disabled = false;
      } else {
        urlInput.classList.remove('valid');
        urlInput.classList.add('invalid');
        setUrlStatus('Please enter a YouTube URL (youtube.com or youtu.be).', 'error');
        fetchBtn.disabled = true;
      }
    }, 400);
  });

  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !fetchBtn.disabled) fetchBtn.click();
  });

  urlClearBtn.addEventListener('click', () => {
    urlInput.value = '';
    urlInput.classList.remove('valid','invalid');
    urlClearBtn.hidden = true;
    fetchBtn.disabled = true;
    setUrlStatus('');
    urlInput.focus();
  });

  // ─── Event: Fetch metadata ───────────────────────────────────────────────────
  fetchBtn.addEventListener('click', async () => {
    const urlString = urlInput.value.trim();
    if (!urlString) return;

    // Reset any previous result
    hide(metaCard);
    hide(settingsCard);
    hide(errorCard);
    setUrlStatus('');
    setFetchLoading(true);

    try {
      const meta = await fetchMetadata(urlString);
      state.metadata = meta;
      setFetchLoading(false);
      renderMetadata(meta);
    } catch (err) {
      setFetchLoading(false);
      urlInput.classList.add('invalid');
      setUrlStatus(err.message || 'Could not fetch video info.', 'error');
    }
  });

  // ─── Event: Change URL ───────────────────────────────────────────────────────
  changeUrlBtn.addEventListener('click', () => {
    hide(metaCard);
    hide(settingsCard);
    hide(downloadBtn);
    state.metadata = null;
    state.selectedFormat = null;
    urlInput.focus();
    urlInput.select();
  });

  // ─── Event: Format select ────────────────────────────────────────────────────
  fmtMp4Btn.addEventListener('click', () => selectFormat('mp4'));
  fmtMp3Btn.addEventListener('click', () => selectFormat('mp3'));

  // ─── Event: Instant download ─────────────────────────────────────────────────
  downloadBtn.addEventListener('click', downloadMedia);



  // ─── Event: Cancel ──────────────────────────────────────────────────────────
  cancelBtn.addEventListener('click', async () => {
    if (!state.currentJobId || !state.currentToken) return;
    cancelBtn.disabled = true;
    try {
      await cancelJob(state.currentJobId, state.currentToken);
    } catch {}
    stopPolling();
    resetToIdle();
    setUrlStatus('Job cancelled.', 'info');
  });

  // ─── Event: New convert ──────────────────────────────────────────────────────
  newConvertBtn.addEventListener('click', resetToIdle);
  retryBtn.addEventListener('click', () => {
    // Call the action that was set by showError(), then hide the card
    const action = retryBtn._retryAction;
    hide(errorCard);
    if (typeof action === 'function') action();
  });

  // ─── Event: Back button ───────────────────────────────────────────────────────
  const backBtn = $('backBtn');
  if (backBtn) backBtn.addEventListener('click', () => history.back());

  // ─── History rendering ───────────────────────────────────────────────────────
  function renderHistory() {
    const items = loadHistory();
    if (items.length === 0) {
      hide(historySection);
      return;
    }
    show(historySection);
    historyList.innerHTML = items.map(item => `
      <div class="history-item" data-job="${escHtml(item.jobId)}" data-token="${escHtml(item.token)}" tabindex="0" role="button" aria-label="Reload job: ${escHtml(item.title || 'Video')}">
        <span class="history-fmt-badge ${escHtml(item.format || '')}">${escHtml((item.format || '').toUpperCase())}</span>
        <span class="history-title">${escHtml(item.title || 'Unknown')}</span>
        <span class="history-status">${new Date(item.createdAt).toLocaleDateString()}</span>
      </div>
    `).join('');

    // Click to reload a history job status
    historyList.querySelectorAll('.history-item').forEach(el => {
      const handler = () => {
        const jobId = el.dataset.job;
        const token = el.dataset.token;
        if (!jobId || !token) return;

        resetToIdle();
        state.currentJobId  = jobId;
        state.currentToken  = token;
        show(progressCard);
        progressTitle.textContent = 'Checking status…';
        startPolling(jobId, token);
      };
      el.addEventListener('click', handler);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
    });
  }

  clearHistoryBtn.addEventListener('click', () => {
    saveHistory([]);
    renderHistory();
  });

  // ─── Init ────────────────────────────────────────────────────────────────────
  renderHistory();
  urlInput.focus();

})();
