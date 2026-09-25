// Reliability parity with the FlowImagesGen driver: fail fast when the profile
// is not signed in, scope refusals to the attempt, retry the download while
// re-resolving the tile, and resume instead of re-rendering finished cards.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadFunctions } = require("./helpers");

const FLOW_JS = "extension-v2/flow.js";

function readFlow() {
  return fs.readFileSync(path.join(__dirname, "..", "..", FLOW_JS), "utf8");
}

test("parseArgs takes --only and --force for resume runs", () => {
  const { parseArgs } = loadFunctions(
    FLOW_JS,
    "function normalizeUpscaleTier",
    "function usage",
    { path, DEFAULT_BACKEND: "http://127.0.0.1:8022", OUTPUT_DIR: path.join(os.tmpdir(), "out") },
    ["parseArgs"],
    "parseArgs"
  );
  const opts = parseArgs(["--only", "S01_01_SCN_ZI, S02_01.png", "--force"]);
  assert.deepEqual(opts.only, ["s01_01_scn_zi", "s02_01.png"]);
  assert.equal(opts.force, true);

  const bare = parseArgs([]);
  assert.deepEqual(bare.only, []);
  assert.equal(bare.force, false, "a plain run must not force a re-render");
});

test("the not-signed-in error names the exact fix and the profile", () => {
  const { notSignedInError } = loadFunctions(
    FLOW_JS,
    "function notSignedInError",
    "async function promptBoxReady",
    {
      path,
      __dirname: "D:/driver",
      profileDirFor: (opts) => `D:/driver/${opts.profile || "profile"}`,
    },
    ["notSignedInError"],
    "notSignedInError"
  );
  const message = notSignedInError({ profile: "profile-b" }).message;
  assert.match(message, /Not signed in to Flow/);
  assert.match(message, /--login/);
  assert.match(message, /--profile profile-b/);
});

test("refusals are scoped to the attempt, not read page-wide", () => {
  const src = readFlow();
  // Tag what is already on screen before the click, and only count what is
  // untagged afterwards - a stale banner failed 16 items in a row once.
  assert.match(src, /markStaleAlerts/, "must tag stale banners");
  assert.match(src, /freshAlert\(\)/, "must only read banners that appeared since");
  assert.match(src, /data-renderly-stale/);
  assert.match(src, /Flow refused the generation/, "a refusal must fail the card with its reason");
});

test("the download is retried and the tile re-resolved each attempt", async () => {
  const src = readFlow();
  const fn = src.slice(
    src.indexOf("async function fetchResultBuffer"),
    src.indexOf("function dataUrlToBuffer")
  );
  assert.ok(fn.length > 0, "fetchResultBuffer must exist");
  assert.match(fn, /attempts = 3/, "three attempts");
  assert.match(fn, /collectTiles\(\)/, "must re-resolve the tile, not reuse the first src");

  // Behaviour: attempt 1 finds nothing, attempt 2 re-resolves a moved tile
  // and succeeds — the caller must get the re-resolved src.
  const seen = [];
  let call = 0;
  const page = { evaluate: async () => (++call === 1 ? [] : [{ src: "https://flow-content.google/image/moved", canRedo: true }]) };
  const { fetchResultBuffer } = loadFunctions(
    FLOW_JS,
    "async function fetchResultBuffer",
    "function dataUrlToBuffer",
    {
      page,
      fetchImageDataUrl: async (p, url) => {
        seen.push(url);
        return url.includes("moved") ? "data:image/png;base64,AAAA" : null;
      },
      dataUrlToBuffer: () => ({ buffer: Buffer.from("bytes") }),
      isFinalResultUrl: (u) => String(u).includes("flow-content.google"),
      sleep: async () => {},
      console,
    },
    ["fetchResultBuffer"],
    "fetchResultBuffer"
  );
  const result = await fetchResultBuffer(page, "https://flow-content.google/image/first");
  assert.equal(result.src, "https://flow-content.google/image/moved");
  assert.equal(seen.length, 2, "must retry after the first failure");
});

test("three failures give up so the caller can keep waiting", async () => {
  const page = { evaluate: async () => [] };
  const { fetchResultBuffer } = loadFunctions(
    FLOW_JS,
    "async function fetchResultBuffer",
    "function dataUrlToBuffer",
    {
      page,
      fetchImageDataUrl: async () => null,
      dataUrlToBuffer: () => ({ buffer: null }),
      isFinalResultUrl: () => true,
      sleep: async () => {},
      console,
    },
    ["fetchResultBuffer"],
    "fetchResultBuffer"
  );
  assert.equal(await fetchResultBuffer(page, "https://flow-content.google/image/x", 3), null);
});

test("a stale banner is never read as this card's refusal", () => {
  const src = readFlow();
  // Slice the page-side alert logic and drive it with fake nodes: the whole
  // point of the scoping is that an old banner (16 items failed on one once)
  // stays silent while a banner that appears after the click is reported.
  const alerts = src.slice(
    src.indexOf("const ALERT_PATTERNS = ["),
    src.indexOf("H.markStaleAlerts = () => {")
  );
  const tagging = src.slice(
    src.indexOf("H.markStaleAlerts = () => {"),
    src.indexOf("// Click Flow's upload")
  );
  assert.ok(alerts.length > 0 && tagging.length > 0, "alert helpers must exist");

  const makeNode = (text) => {
    const attrs = new Set();
    return {
      textContent: text,
      firstElementChild: null,
      querySelector: () => null,
      setAttribute: (k) => attrs.add(k),
      hasAttribute: (k) => attrs.has(k),
    };
  };
  const load = (getBanners) =>
    loadFunctions(
      FLOW_JS,
      "const ALERT_PATTERNS = [",
      "// Click Flow's upload",
      {
        H: {},
        deepQueryAll: (sel) => (sel.startsWith("[role='alert']") ? getBanners().slice() : []),
        isVisible: () => true,
      },
      ["H"],
      "alert scoping"
    );

  const stale = makeNode("You have not been charged for this generation");
  const banners = [stale];
  const { H } = load(() => banners);
  H.markStaleAlerts();
  assert.equal(H.freshAlert(), null, "a banner from an earlier card must not count");

  // The refusal appears AFTER the click: only that one may be reported.
  banners.push(makeNode("Unusual activity detected"));
  assert.equal(H.freshAlert(), "Unusual activity detected");
});

test("a card whose output exists is skipped, not re-rendered", () => {
  const src = readFlow();
  assert.match(src, /already rendered \(--force to redo\)/);
  assert.match(src, /skipped \(output already on disk\)/);
});

test("the attach path cannot attach an unrelated asset", () => {
  const src = readFlow();
  const fn = src.slice(
    src.indexOf("async function attachExistingAsset"),
    src.indexOf("async function attachUploadedFile")
  );
  assert.doesNotMatch(fn, /chosen = fuzzy/, "the first-row fallback must stay deleted");
  assert.doesNotMatch(fn, /fuzzy >= 0/, "no fuzzy acceptance path");
  assert.match(fn, /if \(chosen < 0\) return false;/);
});

test("attachRefs retries the whole search/upload cycle before failing", () => {
  const src = readFlow();
  const fn = src.slice(src.indexOf("async function attachRefs"), src.indexOf("/**\n * Attach reference images as Flow ingredients - ONE picker session"));
  assert.ok(fn.length > 0, "attachRefs must exist");
  assert.match(fn, /for \(let pass = 1; pass <= 2/, "two full passes");
});
