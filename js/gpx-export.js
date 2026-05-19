/**
 * gpx-export.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates GPX 1.1 files from saved track data for OpenStreetMap contribution
 * and import into other GPS tools.
 *
 * GPX spec: https://www.topografix.com/gpx/1/1/
 * ─────────────────────────────────────────────────────────────────────────────
 */

const GPXExport = (() => {

  /**
   * Generate a GPX XML string from a track object.
   *
   * @param {Object} track
   * @param {string}  track.name     - track name
   * @param {string}  track.desc     - track description
   * @param {string}  track.mapName  - source map name
   * @param {number}  track.startTime - unix timestamp ms
   * @param {Array}   track.points   - [{lat, lon, elevation, timestamp, accuracy}]
   * @returns {string} GPX XML content
   */
  function generateGPX(track) {
    const name    = _xmlEscape(track.name    || 'Track');
    const desc    = _xmlEscape(track.desc    || '');
    const mapName = _xmlEscape(track.mapName || '');
    const created = new Date(track.startTime || Date.now()).toISOString();
    const appVersion = '1.0';

    const trkpts = (track.points || []).map(pt => {
      const time = new Date(pt.timestamp).toISOString();
      const ele  = pt.elevation != null
        ? `\n        <ele>${pt.elevation.toFixed(1)}</ele>`
        : '';
      const acc  = pt.accuracy != null
        ? `\n        <hdop>${(pt.accuracy / 5).toFixed(1)}</hdop>` // approx HDOP
        : '';
      return `    <trkpt lat="${pt.lat.toFixed(7)}" lon="${pt.lon.toFixed(7)}">${ele}
        <time>${time}</time>${acc}
      </trkpt>`;
    }).join('\n');

    const descBlock = desc
      ? `\n    <desc>${desc}</desc>`
      : '';
    const srcBlock = mapName
      ? `\n    <src>GeoPDF Navigator — ${mapName}</src>`
      : '\n    <src>GeoPDF Navigator</src>';

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1"
     creator="GeoPDF Navigator ${appVersion}"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>${descBlock}${srcBlock}
    <time>${created}</time>
  </metadata>
  <trk>
    <name>${name}</name>${descBlock}${srcBlock}
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

    return gpx;
  }

  /**
   * Trigger a file download of GPX data in the browser.
   * @param {Object} track
   */
  function downloadGPX(track) {
    const gpxContent = generateGPX(track);
    const blob = new Blob([gpxContent], { type: 'application/gpx+xml' });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href     = url;
    a.download = _safeFilename(track.name || 'track') + '.gpx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Release object URL after a tick
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Escape special XML characters. */
  function _xmlEscape(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&apos;');
  }

  /** Create a safe filename from a track name. */
  function _safeFilename(name) {
    return name
      .replace(/[^a-z0-9_\-\s]/gi, '')
      .trim()
      .replace(/\s+/g, '_')
      .substring(0, 60) || 'track';
  }

  return { generateGPX, downloadGPX };

})();
