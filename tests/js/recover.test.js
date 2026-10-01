// The Renderly half of gallery recovery (extension-v2/flow.js): the CLI flag,
// the tile-label matcher, and the report slice used by /api/recover. None of
// it touches a browser - the matching functions are sliced out exactly like
// the prepare helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { loadFunctions } = require("./helpers");

const FLOW_JS = "extension-v2/flow.js";

function loadCli() {
  return loadFunctions(
    FLOW_JS,
    "function normalizeUpscaleTier",
    "function usage",
    {
      path,
      DEFAULT_BACKEND: "http://127.0.0.1:8022",
      OUTPUT_DIR: path.join(os.tmpdir(), "renderly-test-output"),
      DEFAULT_BACKEND_DIR: path.join(os.tmpdir(), "renderly-test-backend"),
    },
    ["parseArgs"],
    "parseArgs"
  );
}

function loadRecoverHelpers() {
  return loadFunctions(
    FLOW_JS,
    "function normalizePromptText",
    "async function clearComposerAfterRead",
    {},
    ["normalizePromptText", "commonPrefixLength", "labelMatchesPrompt", "planCardMatches"],
    "recover matchers"
  );
}

const PROMPT_A = "A cinematic wide shot of a red fox trotting through a misty pine forest at dawn";
const PROMPT_B = "Close-up of an owl turning its head over one shoulder, soft studio light";

test("parseArgs accepts the recover flag", () => {
  const { parseArgs } = loadCli();
  assert.equal(parseArgs(["--recover"]).recover, true);
  assert.equal(parseArgs([]).recover, false);
});

test("labelMatchesPrompt takes a full prefix of 20+ chars or an exact match", () => {
  const { labelMatchesPrompt } = loadRecoverHelpers();
  assert.equal(labelMatchesPrompt(PROMPT_A, "A cinematic wide shot of a red fox trot"), true);
  assert.equal(labelMatchesPrompt("A cat", "A cat"), true);
  assert.equal(
    labelMatchesPrompt("A cat", "A cat sleeping on the warm windowsill by noon"),
    false,
    "a sub-20-char prefix must not claim a longer prompt's tile"
  );
  assert.equal(labelMatchesPrompt(PROMPT_A, PROMPT_B), false);
  assert.equal(labelMatchesPrompt(PROMPT_A, ""), false);
});

test("planCardMatches claims unique label hits by title or alt label, never an ambiguous tile", () => {
  const { planCardMatches } = loadRecoverHelpers();
  const twinA = "A cinematic wide shot of a red fox trotting through a misty pine forest";
  const twinB = "A cinematic wide shot of a red fox trotting along a gravel road";
  const cards = [
    { key: "S01_A", prompt: twinA },
    { key: "S02_A", prompt: twinB },
    { key: "S03_A", prompt: PROMPT_B },
  ];
  const tiles = [
    { src: "https://flow-content.google/image/ambiguous", title: twinA.slice(0, 30), label: "" },
    { src: "https://flow-content.google/image/owl", title: "", label: PROMPT_B },
    { src: "https://flow-content.google/image/ref", title: "Maya.png", label: "" },
  ];
  const { matches, restCards, restTiles } = planCardMatches(cards, tiles);
  assert.deepEqual(
    matches.map((m) => `${m.card.key}:${m.tile.src.endsWith("owl")}:${m.how}`),
    ["S03_A:true:label"]
  );
  assert.deepEqual(restCards.map((c) => c.key), ["S01_A", "S02_A"]);
  assert.deepEqual(restTiles.map((t) => t.src.includes("ambiguous")), [true, false]);
});

test("planCardMatches leaves empty-label tiles for the prompt-read pass", () => {
  const { planCardMatches } = loadRecoverHelpers();
  const cards = [{ key: "S01", prompt: PROMPT_A }];
  const tiles = [{ src: "https://flow-content.google/image/x", title: "", label: "" }];
  const { matches, restCards, restTiles } = planCardMatches(cards, tiles);
  assert.deepEqual(matches, []);
  assert.deepEqual(restCards, cards);
  assert.deepEqual(restTiles, tiles);
});
