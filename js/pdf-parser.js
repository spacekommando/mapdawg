/**
 * pdf-parser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses georeferenced PDFs (VP/GPTS format — ArcGIS, CalTopo, QGIS GeoPDF).
 *
 * How the data is structured in these PDFs:
 *   Page dict  →  /VP [xref]
 *   VP object  →  /BBox [left top_pdf right bottom_pdf]
 *                 /Measure [xref]
 *   Measure    →  /GPTS [lat0 lon0 lat1 lon1 lat2 lon2 lat3 lon3]
 *                 /LPTS [x0 y0 x1 y1 x2 y2 x3 y3]
 *
 * The GPTS/LPTS are NOT directly under /VP — they're one xref hop deeper.
 * The raw-text parser scans the whole PDF for /GPTS and /BBox, then pairs
 * them by proximity, which works reliably for all CalTopo / ArcGIS exports.
 *
 * Coordinate conversion:
 *   - BBox is in PDF user units, y-axis bottom-up
 *   - LPTS values are 0-1 normalized within the BBox
 *   - We convert everything to top-down canvas pixel coords
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PdfParser = (() => {

  // ── Public API ─────────────────────────────────────────────────────────────

  async function loadPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    window._lastLoadedPdfBuffer = arrayBuffer;
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    return { pdfDoc, pageCount: pdfDoc.numPages, filename: file.name };
  }

  async function parseGeoRef(pdfDoc, pageIndex, filename) {
    const page     = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.0 });

    const buf = window._lastLoadedPdfBuffer;
    if (!buf) return null;

    const text = _bufToLatin1(new Uint8Array(buf));

    // Check for unsupported TerraGo format
    if (text.includes('/LGIDict') && !text.includes('/GPTS')) {
      return { unsupported: true, format: 'LGIDict/TerraGo' };
    }

    const geo = _extractGeoData(text, viewport.width, viewport.height);
    if (!geo) return null;

    return {
      pageIndex,
      pageWidth:  viewport.width,
      pageHeight: viewport.height,
      corners:    geo.corners,
      wkt:        geo.wkt || null,
      mapName:    filename.replace(/\.pdf$/i, ''),
    };
  }

  /**
   * Convert GPS lat/lon to canvas pixel position.
   * Uses bilinear interpolation across the four georeferenced corners.
   */
  function gpsToPixel(geoRef, lat, lon) {
    const c = geoRef.corners;
    if (!c || c.length < 4) return null;

    const lats = c.map(p => p.lat);
    const lons = c.map(p => p.lon);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);

    if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) return null;

    const tx = (lon - minLon) / (maxLon - minLon);
    const ty = 1 - (lat - minLat) / (maxLat - minLat);

    // Bilinear interpolation — find TL/TR/BL/BR corners
    const tl = c.find(p => p.nx <= 0.5 && p.ny <= 0.5) || c[0];
    const tr = c.find(p => p.nx >  0.5 && p.ny <= 0.5) || c[1];
    const bl = c.find(p => p.nx <= 0.5 && p.ny >  0.5) || c[3];
    const br = c.find(p => p.nx >  0.5 && p.ny >  0.5) || c[2];

    const topX    = tl.px + tx * (tr.px - tl.px);
    const bottomX = bl.px + tx * (br.px - bl.px);
    const topY    = tl.py + tx * (tr.py - tl.py);
    const bottomY = bl.py + tx * (br.py - bl.py);

    return {
      x: topX + ty * (bottomX - topX),
      y: topY + ty * (bottomY - topY),
    };
  }

  function pixelToGps(geoRef, x, y) {
    const c = geoRef.corners;
    if (!c || c.length < 4) return null;

    const pxs = c.map(p => p.px), pys = c.map(p => p.py);
    const minPx = Math.min(...pxs), maxPx = Math.max(...pxs);
    const minPy = Math.min(...pys), maxPy = Math.max(...pys);

    const tx = (x - minPx) / (maxPx - minPx);
    const ty = (y - minPy) / (maxPy - minPy);

    const lats = c.map(p => p.lat), lons = c.map(p => p.lon);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);

    return {
      lat: maxLat - ty * (maxLat - minLat),
      lon: minLon + tx * (maxLon - minLon),
    };
  }

  // resolvePixelCoords is no longer needed (coords resolved at parse time)
  // kept as a no-op for compatibility
  function resolvePixelCoords(geoRef) { return geoRef; }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Main extraction: scan the raw PDF text for /GPTS, /LPTS, and /BBox,
   * then reconstruct the four map corners with pixel + geo coords.
   *
   * Structure we're looking for (may have xref hops between objects):
   *
   *   /VP [5 0 R]
   *   ...
   *   5 0 obj << /Type /Viewport /BBox [36 576 756 90] /Measure 8 0 R >>
   *   ...
   *   8 0 obj << /GPTS [...] /LPTS [...] >>
   */
  function _extractGeoData(text, pageWidthPt, pageHeightPt) {
    // 1. Find /GPTS array — 8 numbers
    const gptsMatch = text.match(/\/GPTS\s*\[([^\]]+)\]/);
    if (!gptsMatch) return null;

    const gpts = _nums(gptsMatch[1]);
    if (gpts.length < 8) return null;

    // 2. Find /LPTS array — 8 numbers (usually nearby)
    const lptsMatch = text.match(/\/LPTS\s*\[([^\]]+)\]/);
    if (!lptsMatch) return null;

    const lpts = _nums(lptsMatch[1]);
    if (lpts.length < 8) return null;

    // 3. Find /BBox — 4 numbers [left top_or_bottom right bottom_or_top]
    //    In CalTopo/ArcGIS PDFs: [left top_pdf right bottom_pdf]
    //    where top_pdf > bottom_pdf (PDF y-axis is bottom-up)
    const bboxMatch = text.match(/\/BBox\s*\[([^\]]+)\]/);
    let bboxLeft = 0, bboxTop = 0, bboxRight = pageWidthPt, bboxBottom = pageHeightPt;

    if (bboxMatch) {
      const b = _nums(bboxMatch[1]);
      if (b.length >= 4) {
        bboxLeft   = b[0];
        bboxRight  = b[2];
        // PDF coords are bottom-up; convert to top-down (screen) coords
        // b[1] is the larger value (top in PDF = higher y), b[3] is smaller (bottom)
        const pdfY1 = b[1], pdfY2 = b[3];
        bboxTop    = pageHeightPt - Math.max(pdfY1, pdfY2);
        bboxBottom = pageHeightPt - Math.min(pdfY1, pdfY2);
      }
    }

    // 4. Extract optional WKT CRS string
    let wkt = null;
    const wktMatch = text.match(/\/WKT\s*\(([^)]{10,})\)/);
    if (wktMatch) wkt = wktMatch[1];

    // 5. Build the four corners
    // Each GPTS/LPTS entry is a pair: [lat, lon] and [nx, ny]
    // LPTS nx,ny are 0-1 normalized within the BBox
    // nx=0→left edge, nx=1→right edge, ny=0→bottom(PDF)=high screen y, ny=1→top(PDF)=low screen y
    const mapW = bboxRight  - bboxLeft;
    const mapH = bboxBottom - bboxTop;

    const corners = [];
    for (let i = 0; i < 4; i++) {
      const lat = gpts[i * 2];
      const lon = gpts[i * 2 + 1];
      const nx  = lpts[i * 2];
      const ny  = lpts[i * 2 + 1];

      // Convert normalized LPTS to canvas pixel coords
      // In CalTopo/ArcGIS PDFs: ny=0 → top of map (north, low screen y)
      //                          ny=1 → bottom of map (south, high screen y)
      // This is the opposite of what you'd expect from PDF y-axis convention —
      // these tools store LPTS with y=0 at the top, matching screen coordinates.
      const px = bboxLeft + nx * mapW;
      const py = bboxTop  + ny * mapH;

      corners.push({ lat, lon, nx, ny, px, py });
    }

    return { corners, wkt };
  }

  function _bufToLatin1(arr) {
    const CHUNK = 65536;
    let s = '';
    for (let i = 0; i < arr.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
    }
    return s;
  }

  function _nums(str) {
    return str.trim().split(/[\s\r\n,]+/).map(Number).filter(n => !isNaN(n));
  }

  return { loadPdf, parseGeoRef, resolvePixelCoords, gpsToPixel, pixelToGps };

})();
