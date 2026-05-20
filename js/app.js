/**
 * app.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Main application controller for GeoPDF Navigator.
 *
 * Responsibilities:
 *  - PDF loading and page selection
 *  - Map rendering via pdf.js → canvas
 *  - Pan / pinch-zoom touch handling
 *  - GPS position overlay (dot + heading arrow)
 *  - Three-mode follow cycling (Free → North-Up Locked → Heading-Up Locked)
 *  - Recording controls (start/pause/resume/stop)
 *  - Tracks panel (list, export, delete)
 *  - UI state machine
 * ─────────────────────────────────────────────────────────────────────────────
 */

(async () => {

  // ── DOM refs ──────────────────────────────────────────────────────────────

  const splash         = document.getElementById('splash');
  const mapScreen      = document.getElementById('map-screen');
  const btnLoadMap     = document.getElementById('btn-load-map');
  const fileInput      = document.getElementById('file-input');

  const canvas         = document.getElementById('map-canvas');
  const ctx            = canvas.getContext('2d');

  const topBar         = document.getElementById('top-bar');
  const mapTitle       = document.getElementById('map-title');
  const accuracyBadge  = document.getElementById('accuracy-badge');
  const accuracyText   = document.getElementById('accuracy-text');

  const btnBack        = document.getElementById('btn-back');
  const btnFollow      = document.getElementById('btn-follow');
  const followIcon     = document.getElementById('follow-icon');
  const btnZoomIn      = document.getElementById('btn-zoom-in');
  const btnZoomOut     = document.getElementById('btn-zoom-out');

  const recIndicator   = document.getElementById('rec-indicator');
  const recLabel       = document.getElementById('rec-label');
  const recStats       = document.getElementById('rec-stats');
  const recDistance    = document.getElementById('rec-distance');
  const recPoints      = document.getElementById('rec-points');
  const recDuration    = document.getElementById('rec-duration');
  const btnStartRec    = document.getElementById('btn-start-rec');
  const btnPauseRec    = document.getElementById('btn-pause-rec');
  const btnResumeRec   = document.getElementById('btn-resume-rec');
  const btnStopRec     = document.getElementById('btn-stop-rec');
  const btnTracks      = document.getElementById('btn-tracks');

  const modalPagePicker  = document.getElementById('modal-page-picker');
  const pagePickerList   = document.getElementById('page-picker-list');
  const btnCancelPage    = document.getElementById('btn-cancel-page');

  const modalError       = document.getElementById('modal-error');
  const errorTitle       = document.getElementById('error-title');
  const errorBody        = document.getElementById('error-body');
  const btnDismissError  = document.getElementById('btn-dismiss-error');

  const modalTrackName   = document.getElementById('modal-track-name');
  const trackNameInput   = document.getElementById('track-name-input');
  const trackDescInput   = document.getElementById('track-desc-input');
  const btnCancelSave    = document.getElementById('btn-cancel-save');
  const btnConfirmSave   = document.getElementById('btn-confirm-save');

  const tracksPanel      = document.getElementById('tracks-panel');
  const tracksList       = document.getElementById('tracks-list');
  const btnCloseTracks   = document.getElementById('btn-close-tracks');

  // ── App State ─────────────────────────────────────────────────────────────

  let pdfDoc       = null;
  let geoRef       = null;         // parsed georeference data
  let pdfPage      = null;         // pdf.js page object
  let renderTask   = null;

  // Offscreen canvas for the PDF render (we pan/zoom this onto main canvas)
  let offCanvas    = null;
  let offCtx       = null;
  let pdfRenderScale = 2.0;        // render at 2x for crisp display

  // Pan/zoom state
  let viewX        = 0;            // canvas offset x
  let viewY        = 0;            // canvas offset y
  let viewScale    = 1.0;          // current zoom
  let minScale     = 0.2;
  let maxScale     = 8.0;

  // GPS state
  let gpsPosition  = null;         // last known {lat, lon, heading, accuracy}
  let posPixel     = null;         // last computed {x, y} on offCanvas

  // Follow mode: 0=free, 1=north-up locked, 2=heading-up locked
  let followMode   = 0;
  const FOLLOW_ICONS = ['🔓', '🔒⬆️', '🔒🧭'];
  const FOLLOW_TITLES= [
    'Follow: Off — tap to enable North-Up follow',
    'Follow: North-Up — map auto-centers on you',
    'Follow: Heading-Up — direction of travel faces up',
  ];

  // Animation frame
  let animFrameId  = null;
  let needsRedraw  = true;

  // Stats timer
  let statsTimer   = null;

  // Current filename for GPX metadata
  let currentMapName = '';

  // ── Init ──────────────────────────────────────────────────────────────────

  GPS.init({
    onPosition:    handleGpsPosition,
    onAccuracy:    handleAccuracyUpdate,
    onTrackUpdate: handleTrackUpdate,
    onError:       (msg) => showError('GPS Error', msg),
  });

  // If a live track was restored, update UI
  if (GPS.isRecording()) {
    setTimeout(updateRecordingUI, 100);
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  btnLoadMap.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', onFileSelected);

  btnBack.addEventListener('click', () => {
    if (GPS.isRecording()) {
      showError('Recording Active', 'Please stop recording before loading a new map.');
      return;
    }
    unloadMap();
  });

  btnFollow.addEventListener('click', cycleFollowMode);
  btnZoomIn.addEventListener('click', () => zoomBy(1.3));
  btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.3));

  btnStartRec.addEventListener('click',  onStartRecording);
  btnPauseRec.addEventListener('click',  onPauseRecording);
  btnResumeRec.addEventListener('click', onResumeRecording);
  btnStopRec.addEventListener('click',   onStopRecording);

  btnTracks.addEventListener('click',      openTracksPanel);
  btnCloseTracks.addEventListener('click', closeTracksPanel);

  btnCancelPage.addEventListener('click',   () => hideModal(modalPagePicker));
  btnDismissError.addEventListener('click', () => hideModal(modalError));
  btnCancelSave.addEventListener('click',   () => hideModal(modalTrackName));
  btnConfirmSave.addEventListener('click',  onConfirmSaveTrack);

  // Resize
  window.addEventListener('resize', onResize);

  // ── Touch & Mouse pan/zoom ─────────────────────────────────────────────────

  let isDragging   = false;
  let dragStartX   = 0;
  let dragStartY   = 0;
  let dragViewX    = 0;
  let dragViewY    = 0;

  // Pinch
  let pinchStartDist  = 0;
  let pinchStartScale = 1;
  let pinchCenterX    = 0;
  let pinchCenterY    = 0;

  canvas.addEventListener('mousedown', e => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragViewX  = viewX;
    dragViewY  = viewY;
    if (followMode !== 0) { followMode = 0; updateFollowButton(); }
  });
  canvas.addEventListener('mousemove', e => {
    if (!isDragging) return;
    viewX = dragViewX + (e.clientX - dragStartX);
    viewY = dragViewY + (e.clientY - dragStartY);
    needsRedraw = true;
  });
  canvas.addEventListener('mouseup',   () => { isDragging = false; });
  canvas.addEventListener('mouseleave',() => { isDragging = false; });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
    zoomAroundPoint(e.offsetX, e.offsetY, factor);
    if (followMode !== 0) { followMode = 0; updateFollowButton(); }
  }, { passive: false });

  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      isDragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      dragViewX  = viewX;
      dragViewY  = viewY;
      if (followMode !== 0) { followMode = 0; updateFollowButton(); }
    } else if (e.touches.length === 2) {
      isDragging = false;
      pinchStartDist  = _touchDist(e.touches);
      pinchStartScale = viewScale;
      pinchCenterX    = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchCenterY    = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (followMode !== 0) { followMode = 0; updateFollowButton(); }
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && isDragging) {
      viewX = dragViewX + (e.touches[0].clientX - dragStartX);
      viewY = dragViewY + (e.touches[0].clientY - dragStartY);
      needsRedraw = true;
    } else if (e.touches.length === 2) {
      const dist   = _touchDist(e.touches);
      const factor = dist / pinchStartDist;
      const newScale = Math.max(minScale, Math.min(maxScale, pinchStartScale * factor));
      zoomAroundPoint(pinchCenterX, pinchCenterY, newScale / viewScale);
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', () => { isDragging = false; });

  // ── File loading ──────────────────────────────────────────────────────────

  async function onFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    fileInput.value = '';

    try {
      // Store the raw buffer so the PDF parser can access it for VP/GPTS parsing
      const buffer = await file.arrayBuffer();
      window._lastLoadedPdfBuffer = buffer;

      const { pdfDoc: doc, pageCount, filename } = await PdfParser.loadPdf(file);
      pdfDoc = doc;
      currentMapName = filename.replace(/\.pdf$/i, '');

      if (pageCount === 1) {
        await loadPage(0);
      } else {
        showPagePicker(pageCount);
      }
    } catch (err) {
      console.error('Load error:', err);
      showError('Could Not Load File', 'Failed to open the PDF. Make sure it is a valid PDF file.\n\n' + err.message);
    }
  }

  function showPagePicker(pageCount) {
    pagePickerList.innerHTML = '';
    for (let i = 0; i < pageCount; i++) {
      const item = document.createElement('div');
      item.className = 'page-item';
      item.innerHTML = `<span class="page-badge">pg ${i+1}</span> Page ${i + 1}`;
      item.addEventListener('click', async () => {
        hideModal(modalPagePicker);
        await loadPage(i);
      });
      pagePickerList.appendChild(item);
    }
    showModal(modalPagePicker);
  }

  async function loadPage(pageIndex) {
    try {
      // Parse georeference data
      const geo = await PdfParser.parseGeoRef(pdfDoc, pageIndex, currentMapName + '.pdf');

      if (geo && geo.unsupported) {
        showError(
          'Format Not Supported',
          `This PDF uses the ${geo.format} format, which is not yet supported.\n\n` +
          `Supported formats: ArcGIS GeoPDF, CalTopo, QGIS GeoPDF export (VP/GPTS).\n\n` +
          `Tip: If using QGIS, use File → Export → Save as PDF → GeoPDF option.`
        );
        return;
      }

      if (!geo) {
        // Still load the map — just no GPS overlay
        showError(
          'No Georeference Data',
          'This PDF has no georeference data (VP/GPTS). The map will display, but GPS overlay is unavailable.\n\nThe map will still open for viewing.'
        );
      }

      geoRef = geo;
      pdfPage = await pdfDoc.getPage(pageIndex + 1);

      await renderPdf();
      showMapScreen();
      GPS.startWatching();

    } catch (err) {
      console.error('Page load error:', err);
      showError('Load Error', 'Failed to render the map page.\n\n' + err.message);
    }
  }

  // ── PDF Rendering ──────────────────────────────────────────────────────────

  async function renderPdf() {
    const viewport = pdfPage.getViewport({ scale: pdfRenderScale });

    offCanvas        = document.createElement('canvas');
    offCanvas.width  = viewport.width;
    offCanvas.height = viewport.height;
    offCtx           = offCanvas.getContext('2d');

    if (renderTask) renderTask.cancel();
    renderTask = pdfPage.render({ canvasContext: offCtx, viewport });
    await renderTask.promise;

    // Resolve normalized corner coords to actual pixels
    if (geoRef && geoRef.normalized) {
      PdfParser.resolvePixelCoords(geoRef, offCanvas.width, offCanvas.height);
    }

    // Fit map to screen initially
    fitToScreen();
    startRenderLoop();
  }

  function fitToScreen() {
    if (!offCanvas) return;
    const sw = canvas.width, sh = canvas.height;
    const mw = offCanvas.width, mh = offCanvas.height;
    const scale = Math.min(sw / mw, sh / mh) * 0.95;
    viewScale = scale;
    viewX = (sw - mw * scale) / 2;
    viewY = (sh - mh * scale) / 2;
    needsRedraw = true;
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  function startRenderLoop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    function loop() {
      if (needsRedraw) {
        drawFrame();
        needsRedraw = false;
      }
      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);
  }

  function drawFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0e1520';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!offCanvas) return;

    // In heading-up mode, rotate the entire canvas around the screen center
    const cx = canvas.width  / 2;
    const cy = canvas.height / 2;
    const rotation = _getMapRotation(); // radians

    ctx.save();
    if (rotation !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.translate(-cx, -cy);
    }

    // Draw PDF map
    ctx.drawImage(offCanvas, viewX, viewY, offCanvas.width * viewScale, offCanvas.height * viewScale);

    // Draw GPS position
    if (gpsPosition && posPixel) {
      _drawGpsDot(posPixel.x * viewScale + viewX, posPixel.y * viewScale + viewY, gpsPosition.heading);
    } else if (gpsPosition && !geoRef) {
      // No georeference — draw dot in corner as indicator
    }

    ctx.restore();
  }

  function _getMapRotation() {
    if (followMode === 2 && gpsPosition && gpsPosition.heading !== null) {
      // Rotate map so heading points up (negate heading converted to radians)
      return -(gpsPosition.heading * Math.PI / 180);
    }
    return 0;
  }

  function _drawGpsDot(screenX, screenY, heading) {
    const r = 10; // dot radius

    // Accuracy circle
    if (gpsPosition && gpsPosition.accuracy && geoRef) {
      const accuracyPx = _metersToPixels(gpsPosition.accuracy);
      if (accuracyPx > r) {
        ctx.beginPath();
        ctx.arc(screenX, screenY, accuracyPx, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(61,220,132,0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(61,220,132,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Direction arrow (if heading available)
    if (heading !== null && heading !== undefined) {
      const angleRad = heading * Math.PI / 180;
      const arrowLen = r * 2.8;

      ctx.save();
      ctx.translate(screenX, screenY);
      ctx.rotate(angleRad);

      // Arrow body
      ctx.beginPath();
      ctx.moveTo(0, -arrowLen);
      ctx.lineTo(r * 0.5, 0);
      ctx.lineTo(-r * 0.5, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(61,220,132,0.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.restore();
    }

    // Outer ring
    ctx.beginPath();
    ctx.arc(screenX, screenY, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    // Colored dot
    ctx.beginPath();
    ctx.arc(screenX, screenY, r, 0, Math.PI * 2);
    ctx.fillStyle = '#3ddc84';
    ctx.fill();

    // Center highlight
    ctx.beginPath();
    ctx.arc(screenX, screenY, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();
  }

  /**
   * Convert meters to screen pixels at current zoom level.
   * Approximate: uses the geoRef corners to estimate the scale.
   */
  function _metersToPixels(meters) {
    if (!geoRef || !geoRef.corners) return 20;
    const [tl, tr] = geoRef.corners;
    const pixelDist = Math.sqrt((tr.px - tl.px)**2 + (tr.py - tl.py)**2);
    const geoDist   = GPS.haversineDistance(
      { lat: tl.lat, lon: tl.lon },
      { lat: tr.lat, lon: tr.lon }
    );
    if (geoDist === 0) return 20;
    return (meters / geoDist) * pixelDist * pdfRenderScale * viewScale;
  }

  // ── GPS callbacks ─────────────────────────────────────────────────────────

  function handleGpsPosition(pos) {
    gpsPosition = pos;

    if (geoRef) {
      const raw = PdfParser.gpsToPixel(geoRef, pos.lat, pos.lon);
      posPixel = raw ? { x: raw.x * pdfRenderScale, y: raw.y * pdfRenderScale } : null;
    }

    // Follow mode: auto-pan
    if (followMode === 1 || followMode === 2) {
      _centerOnPosition();
    }

    needsRedraw = true;
  }

  function _centerOnPosition() {
    if (!posPixel) return;
    viewX = canvas.width  / 2 - posPixel.x * viewScale;
    viewY = canvas.height / 2 - posPixel.y * viewScale;
  }

  function handleAccuracyUpdate(acc) {
    accuracyBadge.className = `accuracy-badge acc-${acc}`;
    if (gpsPosition) {
      const m = gpsPosition.accuracy;
      accuracyText.textContent = m ? Math.round(m) + 'm' : '--';
    } else {
      accuracyText.textContent = '--';
    }
  }

  function handleTrackUpdate(stats) {
    if (!stats) return;
    recDistance.textContent = GPS.metersToMiles(stats.distance);
    recPoints.textContent   = stats.points + ' pts';
    recDuration.textContent = GPS.formatDuration(stats.duration);
  }

  // ── Follow mode ───────────────────────────────────────────────────────────

  function cycleFollowMode() {
    followMode = (followMode + 1) % 3;
    updateFollowButton();

    if ((followMode === 1 || followMode === 2) && posPixel) {
      _centerOnPosition();
      needsRedraw = true;
    }
  }

  function updateFollowButton() {
    btnFollow.dataset.mode   = followMode;
    followIcon.textContent   = FOLLOW_ICONS[followMode];
    btnFollow.title          = FOLLOW_TITLES[followMode];
  }

  // ── Zoom helpers ──────────────────────────────────────────────────────────

  function zoomBy(factor) {
    zoomAroundPoint(canvas.width / 2, canvas.height / 2, factor);
  }

  function zoomAroundPoint(px, py, factor) {
    const newScale = Math.max(minScale, Math.min(maxScale, viewScale * factor));
    const ratio    = newScale / viewScale;
    viewX    = px - ratio * (px - viewX);
    viewY    = py - ratio * (py - viewY);
    viewScale = newScale;
    needsRedraw = true;
  }

  // ── Recording controls ────────────────────────────────────────────────────

  function onStartRecording() {
    GPS.startRecording(currentMapName);
    updateRecordingUI();
    startStatsTimer();
  }

  function onPauseRecording() {
    GPS.pauseRecording();
    updateRecordingUI();
  }

  function onResumeRecording() {
    GPS.resumeRecording();
    updateRecordingUI();
  }

  function onStopRecording() {
    // Only visible when paused — confirm stop
    const track = GPS.stopRecording();
    stopStatsTimer();
    updateRecordingUI();
    // Show name dialog
    _pendingTrack = track;
    trackNameInput.value = '';
    trackDescInput.value = '';
    const date = new Date().toLocaleDateString();
    trackNameInput.placeholder = currentMapName ? `${currentMapName} — ${date}` : `Track ${date}`;
    showModal(modalTrackName);
    trackNameInput.focus();
  }

  let _pendingTrack = null;

  function onConfirmSaveTrack() {
    if (!_pendingTrack) { hideModal(modalTrackName); return; }
    const name = trackNameInput.value.trim() ||
                 trackNameInput.placeholder;
    _pendingTrack.name    = name;
    _pendingTrack.desc    = trackDescInput.value.trim();
    _pendingTrack.mapName = currentMapName;
    GPS.saveTrack(_pendingTrack);
    _pendingTrack = null;
    hideModal(modalTrackName);
    renderTracksList(); // refresh in case panel is open
  }

  function updateRecordingUI() {
    const recording = GPS.isRecording();
    const paused    = GPS.isPaused();

    // Dot indicator
    recIndicator.className = 'rec-dot ' + (
      !recording ? 'idle' :
      paused     ? 'paused' :
                   'recording'
    );

    // Label
    recLabel.textContent = !recording ? 'Not recording' :
                           paused     ? 'Paused' :
                                        'Recording…';

    // Stats row
    recStats.classList.toggle('hidden', !recording);

    // Button visibility
    btnStartRec.classList.toggle('hidden',  recording);
    btnPauseRec.classList.toggle('hidden',  !recording || paused);
    btnResumeRec.classList.toggle('hidden', !recording || !paused);
    btnStopRec.classList.toggle('hidden',   !recording || !paused);
  }

  function startStatsTimer() {
    stopStatsTimer();
    statsTimer = setInterval(() => {
      if (GPS.isRecording()) {
        const stats = GPS.getLiveTrackStats();
        if (stats) handleTrackUpdate(stats);
      }
    }, 1000);
  }

  function stopStatsTimer() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  // ── Tracks panel ──────────────────────────────────────────────────────────

  function openTracksPanel() {
    renderTracksList();
    tracksPanel.classList.remove('hidden');
  }

  function closeTracksPanel() {
    tracksPanel.classList.add('hidden');
  }

  function renderTracksList() {
    const tracks = GPS.loadSavedTracks();
    if (tracks.length === 0) {
      tracksList.innerHTML = '<p class="empty-msg">No saved tracks yet.</p>';
      return;
    }

    tracksList.innerHTML = '';
    tracks.forEach(track => {
      const card = document.createElement('div');
      card.className = 'track-card';

      const date = new Date(track.startTime).toLocaleDateString();
      const dist = GPS.metersToMiles(track.distance || 0);
      const pts  = track.points ? track.points.length : 0;
      const desc = track.desc ? `<div class="track-card-desc">${_htmlEscape(track.desc)}</div>` : '';
      const src  = track.mapName ? `<span>📍 ${_htmlEscape(track.mapName)}</span>` : '';

      card.innerHTML = `
        <div class="track-card-title">${_htmlEscape(track.name)}</div>
        <div class="track-card-meta">
          <span>📅 ${date}</span>
          <span>📏 ${dist}</span>
          <span>🔵 ${pts} pts</span>
          ${src}
        </div>
        ${desc}
        <div class="track-card-actions">
          <button class="btn btn-primary btn-small btn-export" data-id="${track.id}">⬇ GPX</button>
          <button class="btn btn-danger btn-small btn-delete" data-id="${track.id}">🗑 Delete</button>
        </div>
      `;

      card.querySelector('.btn-export').addEventListener('click', e => {
        e.stopPropagation();
        GPXExport.downloadGPX(track);
      });

      card.querySelector('.btn-delete').addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`Delete "${track.name}"?`)) {
          GPS.deleteTrack(track.id);
          renderTracksList();
        }
      });

      tracksList.appendChild(card);
    });
  }

  // ── Screen management ─────────────────────────────────────────────────────

  function showMapScreen() {
    splash.classList.remove('active');
    splash.classList.add('hidden');
    mapScreen.classList.remove('hidden');
    mapScreen.classList.add('active');
    mapTitle.textContent = currentMapName;
    onResize();
    updateRecordingUI();
  }

  function unloadMap() {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    GPS.stopWatching();
    pdfDoc = null; geoRef = null; pdfPage = null;
    offCanvas = null; offCtx = null;
    gpsPosition = null; posPixel = null;
    followMode = 0; updateFollowButton();

    mapScreen.classList.remove('active');
    mapScreen.classList.add('hidden');
    splash.classList.remove('hidden');
    splash.classList.add('active');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    updateRecordingUI();
  }

  function onResize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    needsRedraw = true;
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────

  function showModal(modal) { modal.classList.remove('hidden'); }
  function hideModal(modal) { modal.classList.add('hidden'); }

  function showError(title, body) {
    errorTitle.textContent = '⚠️ ' + title;
    errorBody.textContent  = body;
    showModal(modalError);
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  function _touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }

  function _htmlEscape(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Initial resize ────────────────────────────────────────────────────────
  onResize();

})();
