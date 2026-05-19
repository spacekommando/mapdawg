/**
 * gps.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all GPS/geolocation functionality:
 *  - Live position tracking with accuracy classification
 *  - Heading from GPS course-over-ground (battery-friendly)
 *  - Track recording with pause/resume
 *  - Distance calculation (Haversine)
 *  - localStorage persistence of in-progress tracks
 * ─────────────────────────────────────────────────────────────────────────────
 */

const GPS = (() => {

  // ── Constants ─────────────────────────────────────────────────────────────
  const ACCURACY_GOOD    = 20;   // meters — green indicator
  const ACCURACY_WARN    = 50;   // meters — yellow indicator
  const MIN_SPEED_HEADING = 0.5; // m/s (~1 mph) — below this, freeze heading
  const RECORD_INTERVAL   = 3;   // seconds between track points minimum
  const STORAGE_KEY_LIVE  = 'geopdf_live_track';
  const STORAGE_KEY_SAVED = 'geopdf_saved_tracks';

  // ── State ─────────────────────────────────────────────────────────────────
  let _watchId        = null;
  let _lastPosition   = null;   // {lat, lon, accuracy, heading, speed, timestamp}
  let _lastHeading    = null;   // frozen when speed drops below threshold
  let _isRecording    = false;
  let _isPaused       = false;
  let _currentTrack   = null;   // {name, desc, mapName, points: [...], startTime}
  let _lastRecordTime = 0;
  let _recordInterval = RECORD_INTERVAL;

  // Callbacks registered by app.js
  let _onPosition     = null;   // (positionObj) => void
  let _onAccuracy     = null;   // (classString) => void
  let _onTrackUpdate  = null;   // (trackStats) => void
  let _onError        = null;   // (errorString) => void

  // ── Public API ────────────────────────────────────────────────────────────

  function init({ onPosition, onAccuracy, onTrackUpdate, onError }) {
    _onPosition    = onPosition    || (() => {});
    _onAccuracy    = onAccuracy    || (() => {});
    _onTrackUpdate = onTrackUpdate || (() => {});
    _onError       = onError       || (() => {});

    // Restore any in-progress track from localStorage
    _restoreLiveTrack();
  }

  /**
   * Start watching GPS position.
   * Requests high-accuracy GPS.
   */
  function startWatching() {
    if (!navigator.geolocation) {
      _onError('Geolocation is not supported by this browser.');
      return;
    }
    if (_watchId !== null) return; // already watching

    _watchId = navigator.geolocation.watchPosition(
      _handlePosition,
      _handleGpsError,
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 2000,
      }
    );
  }

  /** Stop watching GPS. */
  function stopWatching() {
    if (_watchId !== null) {
      navigator.geolocation.clearWatch(_watchId);
      _watchId = null;
    }
  }

  /** Get the last known position object, or null. */
  function getLastPosition() {
    return _lastPosition;
  }

  // ── Track recording ───────────────────────────────────────────────────────

  /**
   * Start a new track recording session.
   * @param {string} mapName - name of the loaded map
   */
  function startRecording(mapName) {
    if (_isRecording) return;
    _currentTrack = {
      name:      '',
      desc:      '',
      mapName:   mapName || '',
      points:    [],
      startTime: Date.now(),
    };
    _isRecording = true;
    _isPaused    = false;
    _lastRecordTime = 0;
    _saveLiveTrack();
  }

  /** Pause recording — GPS position display continues, logging stops. */
  function pauseRecording() {
    _isPaused = true;
  }

  /** Resume a paused recording. */
  function resumeRecording() {
    _isPaused = false;
  }

  /**
   * Stop recording and return the completed track.
   * @returns {Object} the track object (without name/desc — caller fills those)
   */
  function stopRecording() {
    _isRecording = false;
    _isPaused    = false;
    const track  = _currentTrack;
    _currentTrack = null;
    _clearLiveTrack();
    return track;
  }

  /** True if currently recording (even if paused). */
  function isRecording() { return _isRecording; }

  /** True if recording is paused. */
  function isPaused() { return _isPaused; }

  /** Get current in-progress track stats for UI display. */
  function getLiveTrackStats() {
    if (!_currentTrack) return null;
    const distance = _calcTrackDistance(_currentTrack.points);
    const duration = Date.now() - _currentTrack.startTime;
    return {
      points:   _currentTrack.points.length,
      distance, // meters
      duration, // ms
    };
  }

  // ── Saved tracks (localStorage) ───────────────────────────────────────────

  /** Save a completed track to persistent storage. */
  function saveTrack(track) {
    const tracks = loadSavedTracks();
    const id = 'track_' + Date.now();
    const saved = {
      ...track,
      id,
      savedAt: Date.now(),
      distance: _calcTrackDistance(track.points),
    };
    tracks.unshift(saved); // newest first
    try {
      localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(tracks));
    } catch (e) {
      console.warn('GPS: Could not save track to localStorage', e);
    }
    return saved;
  }

  /** Load all saved tracks from localStorage. */
  function loadSavedTracks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SAVED);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  /** Delete a track by ID. */
  function deleteTrack(id) {
    const tracks = loadSavedTracks().filter(t => t.id !== id);
    localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(tracks));
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /** Haversine distance between two {lat,lon} points in meters. */
  function haversineDistance(p1, p2) {
    const R = 6371000; // Earth radius in meters
    const φ1 = p1.lat * Math.PI / 180;
    const φ2 = p2.lat * Math.PI / 180;
    const Δφ = (p2.lat - p1.lat) * Math.PI / 180;
    const Δλ = (p2.lon - p1.lon) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  /** Convert meters to miles string. */
  function metersToMiles(m) {
    return (m / 1609.344).toFixed(2) + ' mi';
  }

  /** Format milliseconds as M:SS. */
  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Classify GPS accuracy for the badge indicator. */
  function classifyAccuracy(meters) {
    if (meters === null || meters === undefined) return 'none';
    if (meters <= ACCURACY_GOOD) return 'good';
    if (meters <= ACCURACY_WARN) return 'warn';
    return 'bad';
  }

  // ── Private ───────────────────────────────────────────────────────────────

  function _handlePosition(pos) {
    const { latitude, longitude, accuracy, heading, speed } = pos.coords;

    // Update heading — freeze if speed too low
    let effectiveHeading = _lastHeading;
    if (speed !== null && speed >= MIN_SPEED_HEADING && heading !== null) {
      effectiveHeading = heading;
      _lastHeading = heading;
    }

    _lastPosition = {
      lat:       latitude,
      lon:       longitude,
      accuracy:  accuracy,
      heading:   effectiveHeading,
      speed:     speed,
      timestamp: pos.timestamp,
    };

    // Notify app
    _onPosition(_lastPosition);
    _onAccuracy(classifyAccuracy(accuracy));

    // Record point if active
    if (_isRecording && !_isPaused && _currentTrack) {
      const now = pos.timestamp;
      if (now - _lastRecordTime >= _recordInterval * 1000) {
        _currentTrack.points.push({
          lat:       latitude,
          lon:       longitude,
          elevation: pos.coords.altitude || null,
          timestamp: now,
          accuracy:  accuracy,
        });
        _lastRecordTime = now;
        _saveLiveTrack();

        const stats = getLiveTrackStats();
        _onTrackUpdate(stats);
      }
    }
  }

  function _handleGpsError(err) {
    const msgs = {
      1: 'Location access denied. Please allow location in browser settings.',
      2: 'GPS signal unavailable. Move to an open area.',
      3: 'GPS timed out. Retrying…',
    };
    _onError(msgs[err.code] || 'GPS error: ' + err.message);
    _onAccuracy('none');
  }

  function _calcTrackDistance(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += haversineDistance(points[i-1], points[i]);
    }
    return total;
  }

  /** Persist the in-progress track to localStorage (survives page refresh). */
  function _saveLiveTrack() {
    if (!_currentTrack) return;
    try {
      localStorage.setItem(STORAGE_KEY_LIVE, JSON.stringify({
        track: _currentTrack,
        isRecording: _isRecording,
        isPaused: _isPaused,
      }));
    } catch (e) {
      console.warn('GPS: Could not persist live track', e);
    }
  }

  function _clearLiveTrack() {
    localStorage.removeItem(STORAGE_KEY_LIVE);
  }

  function _restoreLiveTrack() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LIVE);
      if (!raw) return;
      const { track, isRecording, isPaused } = JSON.parse(raw);
      if (track && isRecording) {
        _currentTrack = track;
        _isRecording  = true;
        _isPaused     = true; // restore as paused — user must manually resume
        console.log('GPS: Restored in-progress track with', track.points.length, 'points');
        // Notify app after a tick (app.js may not be initialized yet)
        setTimeout(() => {
          _onTrackUpdate && _onTrackUpdate(getLiveTrackStats());
        }, 500);
      }
    } catch (e) {
      console.warn('GPS: Could not restore live track', e);
    }
  }

  // ── Public exports ─────────────────────────────────────────────────────────
  return {
    init,
    startWatching,
    stopWatching,
    getLastPosition,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    isRecording,
    isPaused,
    getLiveTrackStats,
    saveTrack,
    loadSavedTracks,
    deleteTrack,
    haversineDistance,
    metersToMiles,
    formatDuration,
    classifyAccuracy,
  };

})();
