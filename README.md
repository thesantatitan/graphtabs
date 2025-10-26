# GraphTabs — Tab Graph Explorer

GraphTabs renders every open Chrome tab as a node in a canvas graph, complete with opener relationships and live thumbnails captured via host permissions. Click a node to focus its tab, right-click to close it, and use the status strip to monitor capture progress.

## Install (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Choose **Load unpacked** and select this repository root.
4. Click the GraphTabs toolbar icon to launch the full-screen UI.

## Key Features

- **Host-permission thumbnails**: Opportunistically capture the active tab in each window, downscale to ~160×100, and cache in `chrome.storage.session` with LRU eviction.
- **Live graph**: Nodes group by window in columns; edges connect tabs to their openers using `openerTabId` metadata.
- **Interactive canvas**: Wheel-zoom, drag-pan, hover tooltips, keyboard shortcuts (`+`, `-`, `0`, arrows, `Delete`), and badges for pending or blocked captures.
- **Bidirectional messaging**: Background service worker pushes `graph:update` and `thumb:update` events; the UI requests actions (`tab:activate`, `tab:close`, `window:focus`).

## Project Structure

- `manifest.json` — MV3 manifest with `tabs`, `storage`, and `<all_urls>` host permissions. Registers the background service worker and UI page.
- `background/service_worker.js` — Builds the tab graph, maintains the thumbnail cache (throttled captures, downscaling, LRU eviction), and exposes the messaging API.
- `ui/tabgraph.html` — Canvas-based UI shell with toolbar, status strip, and tooltip container.
- `ui/tabgraph.js` — Radial/column layout, rendering pipeline, in-page thumbnail cache, hit testing, messaging, and favicon fallbacks.
- `ui/styles.css` — Dark theme styling so the canvas fills the viewport and controls stay accessible.
- `docs/manual-test-checklist.md` — Manual validation steps aligned with the v1 Definition of Done.

## Privacy Note

- All thumbnails are captured locally using Chrome APIs and never leave the device.
- Images are resized immediately and stored only in `chrome.storage.session`, which resets on browser restart.
- Restricted pages (`chrome://*`, Chrome Web Store, other blocked schemes) are marked as “Capture blocked” and never trigger capture retries.

## Manual Testing

Run through the checklist in [`docs/manual-test-checklist.md`](docs/manual-test-checklist.md) before shipping. It covers tab creation, graph accuracy, thumbnail behavior, restricted pages, window focus, and restart scenarios.

## Definition of Done (v1)

- Extension loads without manifest or runtime warnings when unpacked.
- UI displays all tabs grouped by window with opener edges and hover tooltips.
- Active tabs per window receive thumbnails captured via host permissions; restricted pages show a blocked badge.
- Clicking a node activates its tab/window; right-clicking closes the tab.
- Session thumbnail cache stays under the configured size/entry cap thanks to LRU eviction.
- Status strip reflects window/tab counts and capture progress; the canvas remains responsive with 100+ tabs.
