# Next session — handover

## 2026-09-30 — DONE: Flow-driver aspect ratio, now with test coverage

The aspect-ratio control added 2026-09-29 (`setProjectAspectRatio` in
`extension-v2/flow.js`, merged via `feat/wide-aspect-ratios` -> `master` at
`c42708b`) landed with NO automated test and, per its own commit message, had
not been verified against a live Flow session. It has now been verified live
by Kehinde (2026-09-29) and gained a real test file today:
`tests/js/aspect-ratio.test.js` - `aspectForCard`'s PU/PD->1:1 (21:9 clamped to
16:9 since Flow's own UI tops out there), `isToggleChecked`, and
`setProjectAspectRatio`'s prompt-box-first/project-panel-fallback behaviour,
including the failure paths (ratio not offered, panel won't close) that must
degrade to "leave the aspect as-is" rather than crash a batch. Full JS suite:
48/48 green.

One behaviour worth knowing, pinned by the tests rather than changed: if the
prompt-box overlay opens but does NOT offer the requested ratio, the function
does not fall through to the project panel - it logs a warning and still
closes/returns true, leaving whatever aspect was already set. In practice this
hasn't mattered (both overlays offer the same 5 ratios), but it's why "falls
back to the project panel" only happens when the prompt-box overlay is absent
entirely (Agent mode), not when it's present but missing an option.

Added 2026-09-24 from a WhisperRadar refs-stage test (three productions, one per
channel). The refs stage itself works; the blocker is the `renderly` + `flow`
engine, which runs through `extension-v2/flow.js`. It has not implemented what
FlowImagesGen implemented for the same job, so WhisperRadar cannot drive it the
same way.

## Gap: FlowImagesGen parity for the Flow driver

FlowImagesGen (D:\Repos\FlowImagesGen) gained, on 2026-09-23/24, the pieces
WhisperRadar's pipeline now depends on. Renderly's driver has not:

1. **`prepare` + project-URL contract (missing).** FlowImagesGen:
   `node src/cli.js prepare --job <job> --report <path>` opens *or creates* the
   job's Flow project, prints `FLOW_PROJECT_URL=<url>` on stdout, and writes the
   report atomically as soon as the project exists. WhisperRadar persists that
   URL on the production row (`productions.flow_project_url` / `flow_project_id`)
   and feeds it back on every run so a dead or stale project can be replaced and
   a second project is never created for the same video. There is no equivalent
   in `flow.js` / `server.js`: the driver never reports a project URL and always
   drives whatever project is open / most recent. Port the command + report
   (schema frozen in FlowImagesGen's `NEXT_SESSION.md`).
2. **Per-ref status reporting (missing).** The prepare report lists each ref as
   `uploaded | reused | generated | missing`, and the generation stage then runs
   `refMode: "assets"` (attach by name, never upload) when every ref is already
   in the gallery. `flow.js` already searches and reuses assets by name
   (`searchFor` / the "FlowImagesGen's model" comments around the ingredient
   panel), but it does not report per-ref status, so WhisperRadar cannot know
   the gallery state or switch between upload and attach modes.
3. **Reliability parity (audit).** Confirm the driver matches FlowImagesGen's
   result-detection fixes: byte-ownership of result tiles (hash the
   pre-generation baseline; a result is the newest non-reference tile whose
   bytes were never seen), salvage of an undetected-but-finished result, a 3x
   download retry that re-resolves the tile each time, and refusal scoping
   (tag alerts already on screen; only a banner appearing AFTER the click
   counts). `flow.js` has partial versions of these — audit against
   FlowImagesGen commits `f17dc95`, `c704830`, `26f372c`, `ddd2f56`, `2436332`.

## Observed blocker (2026-09-24)

Running the images stage of a `renderly`/`flow` production (To Live and More,
4 images, 4 refs already generated into the pinned project):

```
Flow Driver: rendering 4 missing image(s) via Google Flow (a Chrome window will open - leave it running)
Launching Chrome (persistent profile keeps you signed in)…
Flow's prompt box not found — you are probably not signed in.
? page.waitForFunction: Timeout 60000ms exceeded.
pid 7 images -> failed: Flow Driver finished but produced no new images - check the log
```

The driver's persistent profile (`extension-v2/profile/`) is **not signed into
Google Flow**, so no `renderly`/`flow` images can be produced until it is. The
driver should fail fast with an explicit "sign in to Flow" message instead of
opening a window and timing out on the prompt box.

## Context

- The WhisperRadar refs stage (ON-THE-FLY / SUPPLIED / none) works for all three
  cases; only this engine's images stage is blocked.
- To keep the test moving, the two blocked productions were forced through
  FlowImagesGen instead.
- FlowImagesGen itself is not perfect here either: with refs attached, a batch
  hit "No new result tile appeared within 300s" (`assetTile` detection) twice
  even though the images had rendered — see its own `NEXT_SESSION.md`.

## 2026-09-25 — two issues from the 11-image renderly batch

pid 12 (To Live and More, 11 cards, 4 refs, project `9dcd58ce`). The batch did
render with refs (ownership detection worked — no ingredient echoes, 10/11 first
pass), but:

1. **prepare and the attach path disagree about a reference.** prepare reported
   `all 4 reference(s) are in the project`, then attaching for `S02_01_SCN_PR`
   found `BG_KITCHEN_01.png` missing: `"BG_KITCHEN_01.png" not in the project -
   uploading it` → `failed: could not attach 2 reference(s): could not attach
   "BG_KITCHEN_01.png"`. The same reference attached fine on a one-card retry, so
   the presence check (or the upload) is flaky. One card of 11 was lost to it.
2. **A re-run re-renders every card instead of only the missing ones.**
   WhisperRadar asked for "1 missing image", yet the driver rendered all 11 cards
   in the shotlist and saved the existing outputs as `-1` duplicates
   (`S01_01_SCN_ZI-1.png` …, 10 orphans). The FlowImagesGen engine filters to the
   missing images and resumes from state; the driver should skip a card whose
   output already exists (or accept an explicit missing list from the caller).

Both are images-stage only; the handshake (prepare/project landing) and the
byte-ownership detection are confirmed working (11/11 after the retry).

**Update 2026-09-25 — both fixed in `28e0da9` / `c3701e4`.** Re-tested on pid 12
by deleting 3 cards: the batch rendered exactly those 3 and reported the other 8
as `skipped — already rendered (--force to redo)`, with **no `-1` duplicates**;
and the card that had failed (`S02_01_SCN_PR`, `BG_KITCHEN_01`) attached its two
references cleanly. Suite green (49 tests).

## 2026-09-28 — stage 7 unblocked; proposal: drop the Renderly import

WhisperRadar production 2 (`Why Human Always Need To Pet Animal?`, render_mode
`flow`, 153 images) failed the images stage (stage 7 of
`style|script|audio|srt|shots|refs|images|merge|review`) twice. Both causes are
fixed and it renders now:

1. **Driver profile signed out.** `extension-v2/profile/` was created fresh at
   13:13 that day and held 6 cookies, none of the Google auth set (`SID`,
   `__Secure-1PSID`, `SAPISID`, `HSID`, `SSID`, `APISID`). Spawned by the
   service there is no TTY, so `flow.js` threw `notSignedInError` instead of
   pausing for a manual sign-in. Fix: `node flow.js --login` (the profile folder
   is what selects the Google account).
2. **No Renderly channel.** The 13:49 retry died before generating; the driver's
   own log said `no channel named "The Nature Made Us" (have: )`.
   `backend/renderly.db` is gitignored and was fresh on this machine:
   `channels []`, `projects []`, `generations 0`. In `flow` mode nothing creates
   the channel — `autorun._stage_params` passes `eff["renderly_channel_name"]`
   straight through, and only the renderly/api path calls
   `resolve_renderly_channel(..., create=True)` (`webapp.py:2199-2202`). Fix:
   create the channel (`POST /api/channels {"name":"The Nature Made Us"}`) or
   link it from the dashboard.

Diagnostics needed for (2): the driver keeps its batch log **in memory only**.
While the service runs, `GET http://127.0.0.1:8030/api/status` returns
`{running, counts, exitCode, log}` — that is where the error text lives.
`driver-service.log` only ever holds server.js's two startup lines. Also
`GET /api/channels/<name>` answers **422**: `routes/channels.py:62` takes an int
id, so flow.js's name probe always 422s and falls back to listing every channel.

### Proposal: disable the Renderly import in the Flow driver

**Agree.** WhisperRadar never reads the Renderly copy — the merge stage uses the
production's own `images\` (`studio.find_images`), which the driver already
writes. FlowBatch has no import at all, so the import is the one thing that
makes a Renderly channel *mandatory* for a batch (cause 2 above) and it is what
drives the `/api/channels/<name>` 422.

**One caveat — the import is currently how the upscale happens.** `flow.js`
applies the upscale to the imported record: `importToRenderly(...)` →
`upscaleGeneration(opts.backend, record.id, tier)` →
`POST /api/generations/{id}/upscale` → the upscaled `image_url` is downloaded
back over the local PNG (`flow.js` ≈2757-2781 and ≈2321-2341). Neither upscale
endpoint takes a file — `routes/assets.py:121` and `routes/generate.py:739` both
need a record id — so dropping the import also drops driver upscaling unless it
is replaced.

Suggested order:

1. Make the import opt-in: no `--channel` (or a new `--import`) means never touch
   the backend; `--channel` keeps today's behaviour. That removes the channel
   requirement for a plain batch and the 422 path.
2. Move the upscale in-driver: run the vendored Real-ESRGAN ncnn-Vulkan engine on
   the downloaded PNG and write it back in place, the way FlowBatch's
   `src/upscale/` does. The engine and models are already in
   `backend/tools/realesrgan/`, and the ICD bug that pinned it to CPU is fixed
   (below).
3. WhisperRadar: stop sending `flow_channel` for `engine=flow`
   (`autorun._stage_params`, `autorun.py:1377`); keep it for the renderly/api
   engine. `/api/upscale/status` stays for a manual upscale from the UI.

If (2) is not wanted, the fallback is masters-only output from the driver with
the upscale done elsewhere — but that must be explicit, not a silent regression.

### Uncommitted changes from this session

- `backend/services/upscaler.py`: ICD files whose driver is missing on this
  machine are no longer forced into `VK_DRIVER_FILES` (the bundled
  `nv-vk64.json` / `igvk64.json` carry another laptop's absolute DriverStore
  paths, which made `vkCreateInstance` fail and every GPU probe look dead), and
  the probe image is generated at 64×64 because the old 10×10 one failed
  `_content_ok` even on a working GPU.
- `backend/requirements.txt`: added `Pillow>=10` — the backend could not
  `import main` without it.
- `.gitignore` + untracked `backend/tools/realesrgan/device_cache.json` and
  `_probe.png` (machine-specific, regenerated).
- New tests: `tests/py/test_upscaler_icd.py`, `tests/py/test_upscaler_probe.py`
  (backend suite 26 green). FlowBatch got the same ICD fix, uncommitted.

