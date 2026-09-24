// The Renderly half of the frozen WhisperRadar prepare contract
// (extension-v2/flow.js): flag parsing, project-id extraction, atomic report
// writes, and batch ref collection.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
    },
    ["parseArgs"],
    "parseArgs"
  );
}

function loadPrepareHelpers() {
  return loadFunctions(
    FLOW_JS,
    "const PREPARE_SCHEMA_VERSION",
    "async function main",
    { path, fs },
    ["projectIdFrom", "writeReportAtomic", "collectRefs"],
    "prepare helpers"
  );
}

test("parseArgs accepts the prepare flags", () => {
  const { parseArgs } = loadCli();
  const opts = parseArgs([
    "--prepare",
    "--file",
    "D:/batches/batch.json",
    "--report",
    "D:/batches/flow_prepare.json",
    "--flow-project",
    "https://flow.google.com/project/abc12345-1111-2222-3333-444444444444",
  ]);
  assert.equal(opts.prepare, true);
  assert.equal(opts.report, path.resolve("D:/batches/flow_prepare.json"));
  assert.equal(
    opts.flowProject,
    "https://flow.google.com/project/abc12345-1111-2222-3333-444444444444"
  );
});

test("parseArgs defaults leave generation behaviour untouched", () => {
  const { parseArgs } = loadCli();
  const opts = parseArgs([]);
  assert.equal(opts.prepare, false);
  assert.equal(opts.report, null);
  assert.equal(opts.flowProject, null);
  assert.equal(opts.upscale, "2K");
  assert.equal(opts.versions, 1);
});

test("projectIdFrom extracts the uuid from a project URL", () => {
  const { projectIdFrom } = loadPrepareHelpers();
  assert.equal(
    projectIdFrom("https://flow.google.com/project/772a62aa-c204-4473-a27b-5e106a7f0b06"),
    "772a62aa-c204-4473-a27b-5e106a7f0b06"
  );
  assert.equal(projectIdFrom("https://flow.google.com/"), null);
  assert.equal(projectIdFrom(null), null);
});

test("writeReportAtomic is atomic: valid JSON, no temp left, dirs created", () => {
  const { writeReportAtomic } = loadPrepareHelpers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderly-prepare-"));
  const file = path.join(dir, "nested", "flow_prepare.json");
  const report = { schemaVersion: 1, projectUrl: "https://flow.google.com/project/x", refs: [] };
  writeReportAtomic(file, report);
  assert.equal(fs.existsSync(`${file}.tmp`), false, "temp file must be renamed away");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), report);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("collectRefs unions card refs and global refs without duplicates", () => {
  const { collectRefs } = loadPrepareHelpers();
  const cards = [
    { refs: ["D:/refs/Maya.png", "D:/refs/BG.png"] },
    { refs: ["D:/refs/BG.png"] },
    { refs: [] },
  ];
  assert.deepEqual(collectRefs(cards, { refs: ["D:/refs/extra.png", "D:/refs/Maya.png"] }), [
    "D:/refs/Maya.png",
    "D:/refs/BG.png",
    "D:/refs/extra.png",
  ]);
  assert.deepEqual(collectRefs(null, { refs: ["D:/refs/only.png"] }), ["D:/refs/only.png"]);
  assert.deepEqual(collectRefs([], {}), []);
});
