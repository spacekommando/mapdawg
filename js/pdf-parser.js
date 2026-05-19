/**
 * pdf-parser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses georeferenced PDFs (VP/GPTS format — ArcGIS, CalTopo, QGIS GeoPDF).
 * Extracts the four corner geo-coordinates and their corresponding pixel
 * positions so the map display layer can do GPS-to-pixel projection.
 *
 * Path 1 (supported):  /VP + /GPTS  — Hillsborough County, CalTopo, USGS new
 * Path 2 (unsupported): /LGIDict + CTM — older TerraGo format
 *
 * Returns a GeoRef object:
 * {
 *   pageIndex  : number,          // 0-based page index used
 *   pageWidth  : number,          // page width in PDF user units (pts)
 *   pageHeight : number,          // page height in PDF user units (pts)
 *   corners    : [                // four corners in pixel + geo coords
 *     { px: number, py: number, lat: number, lon: number }, // top-left
 *     { px: number, py: number, lat: number, lon: number }, // top-right
 *     { px: number, py: number, lat: number, lon: number }, // bottom-right
 *     { px: number, py: number, lat: number, lon: number }, // bottom-left
 *   ],
 *   wkt        : string|null,     // coordinate reference system WKT
 *   mapName    : string,          // filename without extension
 * }
 *
 * Coordinate mapping uses bilinear interpolation across the four corners.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PdfParser = (() => {

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Load a PDF file and return page count + basic info.
   * @param {File} file
   * @returns {Promise<{pdfDoc, pageCount, filename}>}
   */
  async function loadPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    return {
      pdfDoc,
      pageCount: pdfDoc.numPages,
      filename: file.name,
    };
  }

  /**
   * Attempt to extract georeference data from a specific page.
   * @param {Object} pdfDoc  - pdf.js document object
   * @param {number} pageIndex - 0-based page index
   * @param {string} filename
   * @returns {Promise<GeoRef|null>} null if no georeference data found
   */
  async function parseGeoRef(pdfDoc, pageIndex, filename) {
    const page = await pdfDoc.getPage(pageIndex + 1); // pdf.js is 1-based
    const viewport = page.getViewport({ scale: 1.0 });

    // Get raw PDF objects — we need to dig into the page's /VP array
    const rawPage = page._pageInfo || await _getRawPageData(page);
    const vpData  = await _extractVPData(page, pdfDoc, pageIndex);

    if (!vpData) {
      // Check for LGIDict (TerraGo) — not supported, return signal
      const hasLGI = await _checkLGIDict(page, pdfDoc, pageIndex);
      if (hasLGI) {
        return { unsupported: true, format: 'LGIDict/TerraGo' };
      }
      return null;
    }

    const mapName = filename.replace(/\.pdf$/i, '');

    return {
      pageIndex,
      pageWidth:  viewport.width,
      pageHeight: viewport.height,
      corners:    vpData.corners,
      wkt:        vpData.wkt || null,
      mapName,
    };
  }

  /**
   * Convert a GPS coordinate to canvas pixel position using bilinear interpolation.
   * @param {GeoRef} geoRef
   * @param {number} lat
   * @param {number} lon
   * @param {number} renderScale - the scale at which the PDF was rendered to canvas
   * @returns {{x: number, y: number}|null}
   */
  function gpsToPixel(geoRef, lat, lon, renderScale = 1) {
    const corners = geoRef.corners;
    if (!corners || corners.length < 4) return null;

    // Bilinear interpolation using the four corner points
    // corners order: [TL, TR, BR, BL] in (px, py, lat, lon)
    const [tl, tr, br, bl] = corners;

    // Normalize lat/lon to [0,1] within the bounding box
    const lats = corners.map(c => c.lat);
    const lons = corners.map(c => c.lon);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);

    if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) {
      return null; // Outside map extent
    }

    // Bilinear interpolation
    const tx = (lon - minLon) / (maxLon - minLon);
    const ty = 1 - (lat - minLat) / (maxLat - minLat); // y is inverted (top = max lat)

    // Interpolate pixel position
    const topX    = tl.px + tx * (tr.px - tl.px);
    const bottomX = bl.px + tx * (br.px - bl.px);
    const topY    = tl.py + tx * (tr.py - tl.py);
    const bottomY = bl.py + tx * (br.py - bl.py);

    const x = (topX + ty * (bottomX - topX)) * renderScale;
    const y = (topY + ty * (bottomY - topY)) * renderScale;

    return { x, y };
  }

  /**
   * Convert a canvas pixel position back to GPS coordinates.
   * @param {GeoRef} geoRef
   * @param {number} x - canvas x
   * @param {number} y - canvas y
   * @param {number} renderScale
   * @returns {{lat: number, lon: number}|null}
   */
  function pixelToGps(geoRef, x, y, renderScale = 1) {
    const corners = geoRef.corners;
    if (!corners || corners.length < 4) return null;

    const px = x / renderScale;
    const py = y / renderScale;

    const [tl, tr, br, bl] = corners;

    // Page extent
    const left   = Math.min(tl.px, bl.px);
    const right  = Math.max(tr.px, br.px);
    const top    = Math.min(tl.py, tr.py);
    const bottom = Math.max(bl.py, br.py);

    const tx = (px - left)  / (right  - left);
    const ty = (py - top)   / (bottom - top);

    // Interpolate lat/lon
    const topLon    = tl.lon + tx * (tr.lon - tl.lon);
    const bottomLon = bl.lon + tx * (br.lon - bl.lon);
    const topLat    = tl.lat + tx * (tr.lat - tl.lat);
    const bottomLat = bl.lat + tx * (br.lat - bl.lat);

    const lon = topLon + ty * (bottomLon - topLon);
    const lat = topLat + ty * (bottomLat - topLat);

    return { lat, lon };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Extract VP/GPTS georeference data from a pdf.js page object.
   * We access the raw PDF stream data via pdf.js's internal APIs.
   */
  async function _extractVPData(page, pdfDoc, pageIndex) {
    try {
      // pdf.js exposes page.getViewport and internal structure
      // We need to access the raw page dict through the transport layer
      const transport = pdfDoc._transport;

      // Request the raw page structure from the pdf.js worker
      // pdf.js stores the structured page data in _pageInfo after first access
      const pageRef = pdfDoc._pagePromises || {};

      // Use pdf.js's getOperatorList to trigger page parsing,
      // then access internal data. This is a workaround since pdf.js
      // doesn't expose VP data in its public API.
      // We'll parse the raw binary data instead.
      const data = await _parseRawVP(pdfDoc, pageIndex);
      return data;

    } catch (err) {
      console.warn('PdfParser: VP extraction error', err);
      return null;
    }
  }

  /**
   * Parse VP/GPTS data directly from the PDF byte stream.
   * This is necessary because pdf.js's public API doesn't expose
   * the geospatial metadata — we read it from the raw PDF structure.
   */
  async function _parseRawVP(pdfDoc, pageIndex) {
    try {
      // Get the raw PDF data buffer from the pdf.js transport
      // We access this via the internal _pdfInfo and data stream
      const transport = pdfDoc._transport;

      // pdf.js stores the raw data — we need to find it
      // Try multiple known internal property paths across pdf.js versions
      let rawData = null;

      if (transport._params && transport._params.data) {
        rawData = transport._params.data;
      } else if (transport.messageHandler && transport.messageHandler._rawData) {
        rawData = transport.messageHandler._rawData;
      }

      // If we can't get raw data from internals, try loading the
      // original file data we stored during load
      if (!rawData && window._lastLoadedPdfBuffer) {
        rawData = new Uint8Array(window._lastLoadedPdfBuffer);
      }

      if (!rawData) {
        console.warn('PdfParser: Cannot access raw PDF data for VP parsing');
        return null;
      }

      // Convert to string for regex parsing
      // Only search the relevant portion to avoid memory issues
      const pdfText = _bufferToString(rawData);
      return _parseVPFromText(pdfText, pdfDoc, pageIndex);

    } catch (err) {
      console.warn('PdfParser: Raw VP parse error', err);
      return null;
    }
  }

  /**
   * Convert a Uint8Array buffer to a latin-1 string for PDF parsing.
   * We use latin-1 (not UTF-8) because PDF binary streams use raw bytes.
   */
  function _bufferToString(buffer) {
    // Process in chunks to avoid call stack limits
    const CHUNK = 65536;
    let result = '';
    const arr = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    for (let i = 0; i < arr.length; i += CHUNK) {
      result += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
    }
    return result;
  }

  /**
   * Parse /VP + /GPTS arrays from raw PDF text.
   *
   * PDF VP structure looks like (simplified):
   * /VP [<<
   *   /Type /Viewport
   *   /BBox [x1 y1 x2 y2]
   *   /Measure <<
   *     /Type /Measure
   *     /Subtype /GEO
   *     /Bounds [...]
   *     /GPTS [lat1 lon1 lat2 lon2 lat3 lon3 lat4 lon4]
   *     /LPTS [x1 y1 x2 y2 x3 y3 x4 y4]
   *     /GCS << /WKT (GEOGCS[...]) >>
   *   >>
   * >>]
   */
  function _parseVPFromText(pdfText, pdfDoc, pageIndex) {
    // Find /VP array — may appear multiple times, we want the one
    // associated with the correct page
    const vpMatches = [];
    let searchPos = 0;

    // Locate all /VP occurrences
    while (true) {
      const idx = pdfText.indexOf('/VP', searchPos);
      if (idx === -1) break;

      // Extract a window of text after /VP to analyze
      const window = pdfText.substring(idx, idx + 4000);
      vpMatches.push({ idx, window });
      searchPos = idx + 1;

      // Limit to avoid processing thousands of false hits
      if (vpMatches.length > 50) break;
    }

    // Try each VP occurrence and see if it contains GPTS
    for (const { idx, window } of vpMatches) {
      const result = _tryParseVPWindow(window);
      if (result) return result;
    }

    return null;
  }

  /**
   * Try to parse georeference data from a window of PDF text containing /VP.
   */
  function _tryParseVPWindow(text) {
    // Look for /GPTS array — contains 8 numbers (4 lat/lon pairs)
    // Format: /GPTS [n n n n n n n n]
    const gptsMatch = text.match(/\/GPTS\s*\[([^\]]+)\]/);
    if (!gptsMatch) return null;

    const gptsNums = _parseNumberArray(gptsMatch[1]);
    if (!gptsNums || gptsNums.length < 8) return null;

    // Look for /LPTS array — 8 normalized page position values [0-1]
    const lptsMatch = text.match(/\/LPTS\s*\[([^\]]+)\]/);
    if (!lptsMatch) return null;

    const lptsNums = _parseNumberArray(lptsMatch[1]);
    if (!lptsNums || lptsNums.length < 8) return null;

    // Look for /BBox — pixel bounds of the map area
    const bboxMatch = text.match(/\/BBox\s*\[([^\]]+)\]/);
    let bbox = null;
    if (bboxMatch) {
      const b = _parseNumberArray(bboxMatch[1]);
      if (b && b.length >= 4) bbox = b;
    }

    // Look for WKT (coordinate reference system)
    let wkt = null;
    const wktMatch = text.match(/\/WKT\s*\(([^)]+(?:\([^)]*\)[^)]*)*)\)/);
    if (wktMatch) wkt = wktMatch[1];

    // GPTS format: [lat0 lon0 lat1 lon1 lat2 lon2 lat3 lon3]
    // LPTS format: [x0 y0 x1 y1 x2 y2 x3 y3] (normalized 0-1)
    // Corner order in GPTS/LPTS: typically BL, BR, TR, TL (varies by tool)
    // We'll detect and normalize the order

    const geoPoints = [];
    for (let i = 0; i < 8; i += 2) {
      geoPoints.push({ lat: gptsNums[i], lon: gptsNums[i + 1] });
    }
    const pagePoints = [];
    for (let i = 0; i < 8; i += 2) {
      pagePoints.push({ x: lptsNums[i], y: lptsNums[i + 1] });
    }

    // We need actual pixel positions, not normalized LPTS.
    // LPTS are normalized [0-1] relative to the page.
    // We'll store as normalized for now and resolve to pixels later.

    // Build corners array: [TL, TR, BR, BL]
    // Sort by y (top = small y), then x (left = small x) to normalize order
    const combined = geoPoints.map((geo, i) => ({
      lat: geo.lat,
      lon: geo.lon,
      nx:  pagePoints[i].x,  // normalized x [0-1]
      ny:  pagePoints[i].y,  // normalized y [0-1]
    }));

    // Sort: top-left, top-right, bottom-right, bottom-left
    // In PDF coords, y=0 is bottom, so low ny = bottom of page
    // In screen coords we need to invert y
    const sorted = _sortCornersToTLTRBRBL(combined);

    return {
      corners: sorted,
      wkt,
      normalized: true, // px/py are normalized [0-1], resolved in app.js
    };
  }

  /**
   * Sort 4 corner points into [TL, TR, BR, BL] order.
   * Works regardless of the original order they appear in the PDF.
   */
  function _sortCornersToTLTRBRBL(pts) {
    // Find centroid
    const cx = pts.reduce((s, p) => s + p.nx, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.ny, 0) / pts.length;

    // Classify each point relative to centroid
    // In PDF space: low y = bottom, high y = top
    const tl = pts.find(p => p.nx <= cx && p.ny >= cy) ||
               pts.sort((a, b) => (a.nx + (1-a.ny)) - (b.nx + (1-b.ny)))[0];
    const tr = pts.find(p => p.nx >= cx && p.ny >= cy) ||
               pts.sort((a, b) => ((1-a.nx) + (1-a.ny)) - ((1-b.nx) + (1-b.ny)))[0];
    const br = pts.find(p => p.nx >= cx && p.ny <= cy) ||
               pts.sort((a, b) => ((1-a.nx) + a.ny) - ((1-b.nx) + b.ny))[0];
    const bl = pts.find(p => p.nx <= cx && p.ny <= cy) ||
               pts.sort((a, b) => (a.nx + a.ny) - (b.nx + b.ny))[0];

    // Deduplicate if some corners matched the same point
    const order = [tl, tr, br, bl];
    const seen = new Set();
    const used = new Set();
    const result = [];
    for (const pt of order) {
      if (pt && !used.has(pt)) {
        result.push(pt);
        used.add(pt);
      }
    }
    // Fill any missing slots with remaining points
    for (const pt of pts) {
      if (!used.has(pt)) {
        result.push(pt);
        used.add(pt);
      }
    }

    return result.slice(0, 4).map(p => ({
      lat: p.lat,
      lon: p.lon,
      nx:  p.nx,
      ny:  p.ny,
      // px/py will be set by app.js once we know rendered page dimensions
      px:  0,
      py:  0,
    }));
  }

  /**
   * Check if page has LGIDict (TerraGo unsupported format).
   */
  async function _checkLGIDict(page, pdfDoc, pageIndex) {
    if (!window._lastLoadedPdfBuffer) return false;
    try {
      const arr = new Uint8Array(window._lastLoadedPdfBuffer);
      const text = _bufferToString(arr.subarray(0, Math.min(arr.length, 500000)));
      return text.includes('/LGIDict');
    } catch { return false; }
  }

  /**
   * Parse a string of space/newline separated numbers into an array of floats.
   */
  function _parseNumberArray(str) {
    return str.trim().split(/[\s\r\n]+/).map(Number).filter(n => !isNaN(n));
  }

  /**
   * Resolve normalized corner coordinates (nx/ny in [0-1]) to actual
   * pixel positions given the rendered page dimensions.
   * PDF y-axis is bottom-up; canvas y-axis is top-down.
   *
   * @param {GeoRef} geoRef
   * @param {number} pageWidthPx  - rendered page width in pixels
   * @param {number} pageHeightPx - rendered page height in pixels
   */
  function resolvePixelCoords(geoRef, pageWidthPx, pageHeightPx) {
    geoRef.corners = geoRef.corners.map(c => ({
      ...c,
      px: c.nx * pageWidthPx,
      py: (1 - c.ny) * pageHeightPx, // flip y: PDF 0=bottom → canvas 0=top
    }));
    geoRef.pageWidth  = pageWidthPx;
    geoRef.pageHeight = pageHeightPx;
    delete geoRef.normalized;
    return geoRef;
  }

  // ── Public exports ─────────────────────────────────────────────────────────
  return {
    loadPdf,
    parseGeoRef,
    resolvePixelCoords,
    gpsToPixel,
    pixelToGps,
  };

})();
