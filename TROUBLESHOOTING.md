# Troubleshooting

## FFmpeg module import mismatch

- **Symptom:** Renderer console displayed `Module missing expected exports.` while the UI stayed in the "Failed to load MP4" state.
- **Root cause:** The project called `createFFmpeg()` from the legacy API, but `@ffmpeg/ffmpeg@0.12.x` exposes an `FFmpeg` class in its ESM build instead of that factory function.
- **Resolution:** Update `index.html` to import the `FFmpeg` class, refactor `renderer.js` to instantiate it, migrate to the asynchronous file-system helpers (`writeFile`, `readFile`, `deleteFile`, `exec`), and connect logging via `ffmpeg.on('log', …)`.

## ffmpeg-core import failure

- **Symptom:** After the first fix, loading an MP4 emitted `Error: failed to import ffmpeg-core.js` from the worker thread.
- **Root cause:** The loader still referenced the UMD build in `@ffmpeg/core/dist/umd`, which lacks a default export in module workers running inside Electron.
- **Resolution:** Point all core URLs to the ESM artifacts (`@ffmpeg/core/dist/esm/ffmpeg-core.{js,wasm}`) for both local node_modules and CDN fallbacks so the worker’s dynamic `import()` can resolve offline.

## Verifying the fixes

1. `npm install`
2. `npm start`
3. Open DevTools – the console should show `FFmpeg loaded from: …` with no follow-up errors, and stems demux once you load a prepared MP4.
