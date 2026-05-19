# Mapdawg Navigator

A Progressive Web App (PWA) for viewing georeferenced PDF maps with live GPS overlay and GPX track recording.

## Features

- **Load georeferenced PDFs** — supports VP/GPTS format (ArcGIS, CalTopo, QGIS GeoPDF)
- **Live GPS overlay** — position dot with direction arrow and accuracy indicator
- **Three follow modes** (tap the lock button to cycle):
  - 🔓 **Free** — pan/zoom manually, GPS dot moves on screen
  - 🔒⬆️ **North-Up Locked** — map auto-centers and stays north-up as you move
  - 🔒🧭 **Heading-Up Locked** — map rotates so your direction of travel faces up
- **Track recording** — start, pause, resume, stop with live distance/duration stats
- **Track library** — saved tracks with name, date, distance; survives page refresh
- **GPX export** — export tracks with timestamps for OpenStreetMap or other tools
- **Works offline** — PWA installs to Android home screen, no app store needed

## Supported PDF Formats

| Format | Source | Support |
|--------|--------|---------|
| VP/GPTS | ArcGIS, CalTopo, QGIS GeoPDF export, newer USGS topos | ✅ Full |
| LGIDict/CTM | Older TerraGo / historical USGS topos | ⚠️ Not yet supported |

**QGIS tip:** Use *File → Export → Save as PDF → check "GeoPDF"* to export in the supported format.

## Deployment

### Option A — GitHub Pages (recommended, free)

1. Create a new GitHub repository
2. Upload all files maintaining the folder structure
3. Go to *Settings → Pages → Source: main branch → / (root)*
4. Your app will be live at `https://yourusername.github.io/repo-name/`
5. On Android Chrome, visit the URL → tap the menu → *"Add to Home Screen"*

### Option B — Local server (for testing)

You need a local HTTP server (file:// URLs don't work for PWAs).

**Python (easiest):**
```bash
cd geopdf-navigator
python3 -m http.server 8080
```
Then open `http://localhost:8080` in Chrome.

**Node.js:**
```bash
npx serve .
```

### Option C — Any static web host

Upload all files to Netlify, Vercel, Cloudflare Pages, or any web host that serves static files. No server-side code required.

## File Structure

```
geopdf-navigator/
├── index.html          ← Main app
├── manifest.json       ← PWA manifest (install to home screen)
├── sw.js               ← Service worker (offline support)
├── css/
│   └── style.css       ← All styles (CSS variables for easy theming)
├── js/
│   ├── app.js          ← Main controller (map render, UI, follow modes)
│   ├── pdf-parser.js   ← Georeference data extraction from PDFs
│   ├── gps.js          ← GPS tracking, track recording, localStorage
│   └── gpx-export.js   ← GPX file generation
└── icons/
    ├── icon-192.png    ← PWA icon
    └── icon-512.png    ← PWA icon (large)
```

## GPS Notes

- GPS heading requires movement (~0.5 mph / 0.8 kph minimum) — heading arrow freezes when stationary
- Accuracy indicator: 🟢 ≤20m  🟡 ≤50m  🔴 >50m  ⚫ no signal
- Track points are recorded every 3 seconds minimum when actively recording
- An in-progress track is saved to localStorage automatically — it survives accidental page refreshes and will be restored as *paused* so you can review before resuming

## Future Plans

- Compass-assisted heading (device orientation sensor) via settings panel
- Adjustable GPS accuracy threshold and recording interval
- Miles/km toggle
- Map tile overlay support

## Notes

"GeoPDF" is a registered trademark of TerraGo Technologies.  
This app uses the term "georeferenced PDF" to describe geospatially-referenced PDF files.
