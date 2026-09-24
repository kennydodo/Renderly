# Flow × Renderly (Chrome Extension)

Manifest V3 extension that bridges **Google Flow** (labs.google/fx) and your local **Renderly** app.

## Features

- **Toolbar icon toggles the dock** — click the extension icon on a Flow tab to show/hide the floating dock (bottom-right, collapsible, ✕ closes it):
  - **Prompt presets + your Renderly templates** — pick one, "+ Add to master" appends it to the master prompt sent with every card.
  - **Batch cards** — paste prompts, split into cards, generate on Flow or via the Renderly engine; results import and download automatically.
  - **Save last image → Renderly** — grabs the most recent generated image and imports it into the selected channel.
  - **⚙ Backend settings** — change the backend URL if it isn't the default; opens automatically when the backend is unreachable.
- **Default backend**: `http://127.0.0.1:8022` (changeable via the dock's ⚙ gear).

## Install (unpacked)

1. Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select this `extension/` folder
4. Open Google Flow at https://flow.google.com (or https://labs.google/fx/tools/flow) and click the extension icon to show the dock

## Requirements

- Renderly backend running (`start.bat`) on `http://127.0.0.1:8022` — change it via the dock's ⚙ gear if you use a different port.
- If you change the backend URL, reload the extension afterwards (host permissions are granted per saved URL pattern).

## Notes

- Flow is an SPA; the dock injects via a debounced MutationObserver and re-uses the last `≥512px` image on the page as "last generated image".
- API calls go through the background service worker (avoids page-CORS issues). Uploads reuse Renderly's normal `POST /api/channels/{id}/assets` endpoint, so files land in `backend/storage/{channel_id}/` like any upload.
- Flow's composer is an Angular/ProseMirror editor that ignores programmatic edits: the prompt can be made to *appear* without its model ever registering it, which leaves the submit arrow disabled and nothing sent. When the synthetic fill fails to arm the arrow, the extension falls back to replaying the fill and the click as trusted input over the DevTools protocol (the `debugger` permission). Chrome shows a "being debugged" bar while that is in use; it detaches when the batch ends.
