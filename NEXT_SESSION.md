# Next session — handover

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

