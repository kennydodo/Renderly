// Pacing and launch hardening in the extension-v2 driver: --delay paces the
// account between rendered cards, and Chrome is launched without Playwright's
// default --enable-automation flag.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadFunctions, read } = require("./helpers");

function parseArgs(argv) {
  const { parseArgs: fn } = loadFunctions(
    "extension-v2/flow.js",
    "function parseArgs",
    "function usage",
    {
      path,
      normalizeUpscaleTier: (v) => String(v),
      DEFAULT_BACKEND_DIR: "backend",
      DEFAULT_BACKEND: "http://x",
      OUTPUT_DIR: "out",
      PROFILE_DIR: "profile",
      process: { argv: [], env: {}, exit() {} },
      console,
    },
    ["parseArgs"],
    "parseArgs"
  );
  return fn(argv);
}

test("--delay <seconds> is parsed, defaults to 0, and never goes negative", () => {
  assert.equal(parseArgs(["--file", "x.json"]).delaySeconds, 0);
  assert.equal(parseArgs(["--delay", "20"]).delaySeconds, 20);
  assert.equal(parseArgs(["--delay", "-5"]).delaySeconds, 0);
  assert.equal(parseArgs(["--delay", "abc"]).delaySeconds, 0);
});

test("the driver launches Chrome without --enable-automation", () => {
  const src = read("extension-v2/flow.js");
  const launch = src.slice(src.indexOf("async function launchChrome"));
  assert.match(launch.slice(0, launch.indexOf("return { context, page }")),
    /ignoreDefaultArgs:\s*\[\s*"--enable-automation"\s*\]/);
});

test("server.js passes the pacing setting to batch runs only", () => {
  const src = read("extension-v2/server.js");
  assert.match(src, /config\.delaySeconds\) > 0/);
  assert.match(src, /mode !== "prepare" && mode !== "recover"/);
  assert.match(src, /args\.push\("--delay"/);
});
