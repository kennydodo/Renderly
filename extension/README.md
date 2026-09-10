# Flow × Rosterly (Chrome Extension)

Manifest V3 extension that bridges **Google Flow** (labs.google/fx) and your local **Rosterly** app.

## Features

- **Floating dock on Flow pages** (bottom-right, collapsible):
  - **Prompt presets + your Rosterly templates** — pick one, "Append to prompt" writes it into Flow's prompt box (works with textarea and contenteditable inputs, using React-safe native setters).
  - **Save last image → Rosterly** — grabs the most recent generated image on the page and uploads it into the selected Rosterly channel's assets, ready to use as a reference.
- **Popup settings**: backend URL (default `http://127.0.0.1:8022`), default channel, auto-show dock toggle.

## Install (unpacked)

1. Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select this `extension/` folder
4. Open Google Flow at https://flow.google.com (or https://labs.google/fx/tools/flow) — the dock appears bottom-right after the page loads (or use the popup's "Inject / show dock")

## Requirements

- Rosterly backend running (`start.bat`) on `http://127.0.0.1:8022` — change it in the popup if you use a different port.
- If you change the backend URL, reload the extension afterwards (host permissions are granted per saved URL pattern).

## Notes

- Flow is an SPA; the dock injects via a debounced MutationObserver and re-uses the last `≥512px` image on the page as "last generated image".
- API calls go through the background service worker (avoids page-CORS issues). Uploads reuse Rosterly's normal `POST /api/channels/{id}/assets` endpoint, so files land in `backend/storage/{channel_id}/` like any upload.
