# Renderly test suite

Run everything with:

```
test.bat
```

Exit code 1 means something failed. A `pre-commit` hook runs the same suite
before every commit (bypass a single commit with `git commit --no-verify`).

## What is covered

| File | Guards |
| --- | --- |
| `tests/js/trigger.test.js` | `findGenerateButton` / `triggerGenerate` / `clickEl` really click Flow's button (the stall bug), rank candidates by specificity, fall back to Enter on the *live* editor, and fold same-origin iframe offsets into CDP coordinates |
| `tests/js/tiers.test.js` | The dock speaks ImgToVideo's HD / 2K / 4K vocabulary and migrates legacy stored values (`1K` → HD, `2x/3x/4x` → tiers) |
| `tests/js/driver-upscales.test.js` | `extension-v2` `flow.js` / `server.js` normalize `--upscale` / config values onto Renderly tiers, including WhisperRadar's 0-4 ints |
| `tests/py/test_resolution.py` | Resolution preset math: 16:9 snaps to exact preset sizes, other ratios scale by short side, `classify_size` buckets (incl. native and legacy sizes), `resolve_tier`, `level_to_tier` |
| `tests/py/test_api.py` | Settings roundtrip + old `upscale_level: 4` migration; the upscale API accepts `HD/2K/4K` and legacy `scale`, rejects `1K`/unknown tiers |

## How the JS tests work

`tests/js/helpers.js` slices the real functions out of `content.js`,
`extension-v2/flow.js` and `extension-v2/server.js` and evaluates them with
stubbed DOM/`chrome` globals. That means the tests exercise the shipped source —
rename a function or change its behaviour and the suite breaks, which is the
point. If a slice marker fails because code legitimately moved, update the
markers in `helpers.js` callers together with the change.

## How the Python tests work

`tests/py/base.py` puts `backend/` on `sys.path` and points `DATABASE_URL` at a
throwaway SQLite file before anything imports `config`/`db`, so API tests
(`fastapi.testclient`) never touch `renderly.db`. No GPU/engine is needed: the
upscale tests cover sizing math and request validation only.
