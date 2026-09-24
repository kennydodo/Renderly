// Result adoption in extension-v2/flow.js: a result is identified by the redo
// control plus byte ownership. Pixel size must never reject a candidate —
// Flow renders a reference plate and a generated still at the same 1376x768,
// so a size test threw away every real generation (FlowImagesGen 6a8d1ac).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadFunctions } = require("./helpers");

const FLOW_JS = "extension-v2/flow.js";
const RESULT_URL = "https://flow-content.google/image/abc123";
const PLACEHOLDER_URL = "https://flow.google.com/asb/placeholder";

function loadOwnership(name, endMarker) {
  return loadFunctions(
    FLOW_JS,
    "function hashBytes",
    endMarker,
    { crypto },
    [name],
    name
  );
}

test("hashBytes is a deterministic sha1 of the image bytes", () => {
  const { hashBytes } = loadOwnership("hashBytes", "async function ensureRefsInGallery");
  const a = Buffer.from("same-bytes");
  const b = Buffer.from("same-bytes");
  const c = Buffer.from("different-bytes");
  assert.equal(hashBytes(a), crypto.createHash("sha1").update(a).digest("hex"));
  assert.equal(hashBytes(a), hashBytes(b));
  assert.notEqual(hashBytes(a), hashBytes(c));
});

function loadTileIsResult() {
  return loadFunctions(
    FLOW_JS,
    "function isFinalResultUrl",
    "async function waitForIdle",
    {},
    ["isFinalResultUrl", "tileIsResult"],
    "tileIsResult"
  );
}

const tile = (over = {}) => ({ src: RESULT_URL, w: 1376, h: 768, canRedo: true, ...over });

test("a generated tile with unseen bytes is a result", () => {
  const { tileIsResult } = loadTileIsResult();
  assert.equal(tileIsResult(tile(), "hash-1", new Set()), true);
});

test("a reference plate is rejected for want of the redo control", () => {
  const { tileIsResult } = loadTileIsResult();
  // Same URL, same size as a real result — only the control differs.
  assert.equal(tileIsResult(tile({ canRedo: false }), "hash-1", new Set()), false);
});

test("a grid placeholder is rejected even with the redo control", () => {
  const { tileIsResult } = loadTileIsResult();
  assert.equal(tileIsResult(tile({ src: PLACEHOLDER_URL }), "hash-1", new Set()), false);
});

test("an already-known image is rejected as an echo", () => {
  const { tileIsResult } = loadTileIsResult();
  assert.equal(tileIsResult(tile(), "hash-1", new Set(["hash-1"])), false);
});

test("an unreadable candidate (no hash) is never accepted", () => {
  const { tileIsResult } = loadTileIsResult();
  assert.equal(tileIsResult(tile(), null, new Set()), false);
});

test("size never decides: a 1376x768 result is accepted despite refs of that size", () => {
  const { tileIsResult } = loadTileIsResult();
  // The exact case that stalled every card: result size == reference size.
  const resultTile = tile({ w: 1376, h: 768 });
  assert.equal(tileIsResult(resultTile, "new-hash", new Set(["ref-hash"])), true);
});

test("the adoption path contains no dimension-based rejection", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", FLOW_JS), "utf8");
  const start = src.indexOf("function isFinalResultUrl");
  const end = src.indexOf("async function waitForIdle");
  assert.ok(start > 0 && end > start, "adoption path markers moved - update this test");
  const adoption = src.slice(start, end);

  // The discriminators must be present...
  assert.match(adoption, /canRedo/, "adoption must require the redo control");
  assert.match(adoption, /seenHashes/, "adoption must require unseen bytes");
  // ...and no pixel-size comparison may come back.
  for (const banned of [
    /imageDimensions/,
    /refDims/,
    /echoCount/,
    /\.w\s*===/,
    /\.h\s*===/,
  ]) {
    assert.doesNotMatch(adoption, banned, `dimension-based rejection returned: ${banned}`);
  }
  assert.doesNotMatch(src, /function imageDimensions/, "the size helper must stay deleted");
});
