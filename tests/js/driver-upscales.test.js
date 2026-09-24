// The extension-v2 driver (flow.js) and its service (server.js) normalize the
// upscale option before calling Renderly's API. WhisperRadar still sends its
// 0-4 tier there, so the legacy mapping must keep working in both files.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFunctions } = require("./helpers");

const CASES = [
  ["off", "off"],
  ["", "off"],
  [0, "off"],
  [null, "off"],
  [undefined, "off"],
  ["junk", "off"],
  ["HD", "HD"],
  ["hd", "HD"],
  ["2k", "2K"],
  ["4K", "4K"],
  ["1K", "HD"], // pre-rename tier name
  [4, "4K"],
  [3, "2K"],
  [2, "2K"],
  [1, "HD"],
];

test("flow.js --upscale normalizes onto Renderly tiers", () => {
  const { normalizeUpscaleTier } = loadFunctions(
    "extension-v2/flow.js",
    "function normalizeUpscaleTier",
    "function parseArgs",
    {},
    ["normalizeUpscaleTier"],
    "normalizeUpscaleTier"
  );
  for (const [input, expected] of CASES) {
    assert.equal(normalizeUpscaleTier(input), expected, `input ${JSON.stringify(input)}`);
  }
});

test("server.js config upscale normalizes the same way", () => {
  const { normalizeUpscale } = loadFunctions(
    "extension-v2/server.js",
    "function normalizeUpscale",
    "function loadConfig",
    {
      // Module-level consts after the function (DIALOGS = path.join(DIR, ...)).
      path: { join: (...parts) => parts.filter(Boolean).join("/") },
      DIR: ".",
    },
    ["normalizeUpscale"],
    "normalizeUpscale"
  );
  for (const [input, expected] of CASES) {
    assert.equal(normalizeUpscale(input), expected, `input ${JSON.stringify(input)}`);
  }
});
