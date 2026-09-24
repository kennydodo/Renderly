# Renderly extension-v2 (Playwright driver for Google Flow)

Automates Google Flow image generation **with automatic reference-image
attachment** — the one thing the MV3 extension (`../extension`) cannot do.
Flow gates ingredient attachment behind its own UI (gallery panel), which
content scripts can never drive; this driver runs Flow in a real automated
Chrome and works the way a user does:

1. **Upload** missing refs into Flow's gallery by injecting the file bytes
   as a drag-drop onto the page (Flow's global drop handler uploads them;
   gallery tiles get the filename as their label)
2. **Attach** ingredients by opening the ingredient panel, clicking the
   gallery options that match the ref filenames, and confirming with
   "Add to prompt"
3. Fill the prompt (refilled automatically if the panel cleared it),
   trigger generation, wait for the finished image
   (`flow-content.google/image/…` URL stable for 5s), save to `output/`,
   and optionally import + upscale into Renderly

## Files

- `generate.bat` — daily driver: runs a batch from `prompts.json`
  (drag a `.json` onto it, or it reads `prompts.json`)
- `diag.bat` — dumps the Flow page state to `diag-report.json`; use this
  whenever Flow's DOM changes and something stops matching
- `flow.js` — the driver; all Flow DOM helpers live in `installHelpers()`
- `prompts.json` — batch input, two shapes:
  `{ "master": "style prefix…", "cards": [{ "file": "out.png", "prompt": "…", "refs": ["C:\\path\\ref.webp"] }] }`
  or a plain `[{ … }]` array (no master). The master prompt is prepended to
  every card; a `--master "…"` flag overrides it.
- `profile/` — persistent Chrome profile (your Google session; gitignored)
- `output/` — downloaded results (gitignored)

## Setup (once)

```powershell
cd D:\Repos\Renderly\extension-v2
npm.cmd install
node flow.js --diag   # sign into Google once in the opened window
```

## Batch run

Double-click `generate.bat`. Per card: prompt → refs attached → generate →
download. Multi-card batches should use the **same refs on every card**
(ingredients persist in the composer across cards within a run).

Options (see `node flow.js --help`): `--channel <id>` (import into Renderly
via `POST /api/channels/{id}/import`), `--upscale <off|HD|2K|4K>`, `--versions <1-4>`,
`--refs`, `--backend`, `--out`, `--timeout`, `--browser`, `--diag`.

## Notes

- Keep the Renderly backend running (`start.bat`) when using `--channel`.
- The old extension is untouched in your normal Chrome; this driver uses its
  own profile, so nothing conflicts.
- Flow's DOM is undocumented and changes; `diag.bat` output is the first
  thing to send when something breaks.
- UI automation of Flow is undocumented and against Google ToS — keep the
  rate reasonable and use your own account.
