// Coverage for the Flow-driver aspect-ratio control added in 2231daf/36957d1
// (extension-v2/flow.js) - verified live against a real Flow session
// (2026-09-29), but landed on master with no automated test. These pin the
// behaviour that was verified, as a regression guard: the prompt-box overlay
// is tried first (Agent OFF), the project-defaults panel is the fallback
// (Agent ON), an already-selected ratio is left alone, and the driver never
// throws or gets stuck - it always resolves true/false so a bad selector
// degrades to "leave the aspect as-is", not a crashed batch.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFunctions } = require("./helpers");

const FLOW_JS = "extension-v2/flow.js";

function loadAspectMath() {
  return loadFunctions(
    FLOW_JS,
    "const MOTION_ASPECT = {",
    "function stemName(value) {",
    {},
    ["aspectForCard", "MOTION_ASPECT", "FLOW_SUPPORTED_ASPECTS"],
    "aspect math"
  );
}

function loadAspectControl(stubs = {}) {
  return loadFunctions(
    FLOW_JS,
    "async function locatorFor(page, candidates) {",
    "async function clickGenerate(page) {",
    { sleep: async () => {}, console, ...stubs },
    ["locatorFor", "isToggleChecked", "setProjectAspectRatio"],
    "aspect-ratio control"
  );
}

/**
 * A minimal fake of the Playwright surface setProjectAspectRatio touches:
 * page.locator(sel) keyed off a registry of exact selector strings, plus the
 * group.locator(`button:has-text(...)`) call for the ratio option itself.
 * Each registry entry is {count, click?, getAttribute?, locator?}; missing
 * selectors default to "not found" (count 0), same as a real page where the
 * element just isn't there yet.
 */
function makeFakeFlowPage({
  promptBox = null, // null = not offered at all; else { offered, checked, opensOnClick, closesOnClick }
  project = null,
  saveExists = true,
  keyboardEscapeCloses = false,
} = {}) {
  const log = [];
  const registry = {};
  const PROMPT_TRIGGER = "button.settings-trigger-button";
  const PROMPT_GROUP = "flow-toggles[aria-label='Aspect ratio']";
  const PROJECT_TRIGGER = "button[aria-label='Settings']";
  const PROJECT_GROUP = "flow-toggles[aria-label='Image generation default aspect ratio']";

  // Which overlay's group selector is currently "open" - shared across both
  // overlays so a single close-button selector (as the real page has) closes
  // whichever one is actually showing, instead of each overlay owning its
  // own independent (and in a real page, nonexistent) close button.
  let openGroupSel = null;

  function optionLocator(overlayState, ratioLabel) {
    return {
      first() { return this; },
      count: async () => (overlayState.offered === false ? 0 : 1),
      getAttribute: async (name) => {
        if (name === "aria-checked") return overlayState.checked ? "true" : "false";
        if (name === "aria-pressed") return null;
        return null;
      },
      click: async () => {
        overlayState.checked = true;
        log.push(`click:${ratioLabel}`);
      },
    };
  }

  function makeOverlay(triggerSel, groupSel, state) {
    registry[triggerSel] = {
      first() { return this; },
      count: async () => 1,
      click: async () => {
        openGroupSel = groupSel;
        log.push(`trigger:${triggerSel}`);
      },
    };
    registry[groupSel] = {
      first() { return this; },
      count: async () => (openGroupSel === groupSel ? 1 : 0),
      locator: (subSel) => {
        const m = /button:has-text\("(.+)"\)/.exec(subSel);
        return optionLocator(state, m ? m[1] : subSel);
      },
    };
  }

  if (promptBox) makeOverlay(PROMPT_TRIGGER, PROMPT_GROUP, promptBox);
  if (project) makeOverlay(PROJECT_TRIGGER, PROJECT_GROUP, project);

  // The close control the loop tries first; clicking it closes whichever
  // overlay is currently open (there is only ever one open at a time, same
  // as the real page).
  registry["button[aria-label*='close' i]"] = {
    first() { return this; },
    count: async () => (openGroupSel ? 1 : 0),
    click: async () => {
      openGroupSel = null;
      log.push("close-click");
    },
  };

  registry["button:text-is('Save')"] = saveExists
    ? { first() { return this; }, count: async () => 1, click: async () => log.push("save-click") }
    : { first() { return this; }, count: async () => 0 };

  const page = {
    locator: (sel) => registry[sel] || { first() { return this; }, count: async () => 0 },
    keyboard: {
      press: async (key) => {
        log.push(`key:${key}`);
        if (key === "Escape" && keyboardEscapeCloses) {
          openGroupSel = null;
        }
      },
    },
  };
  return { page, log };
}

test("aspectForCard: PU/PD map to 1:1, everything else stays 16:9 (21:9 is clamped)", () => {
  const { aspectForCard } = loadAspectMath();
  assert.equal(aspectForCard({ name: "S01_01_SCN_PU" }), "1:1");
  assert.equal(aspectForCard({ name: "S01_01_SCN_PD" }), "1:1");
  // PL/PR/PV want 21:9 but Flow's own UI tops out at 16:9 - must clamp, not
  // request a ratio the toggle group does not offer.
  assert.equal(aspectForCard({ name: "S01_01_SCN_PL" }), "16:9");
  assert.equal(aspectForCard({ name: "S01_01_SCN_PR" }), "16:9");
  assert.equal(aspectForCard({ name: "S01_01_SCN_PV" }), "16:9");
  assert.equal(aspectForCard({ name: "S01_01_SCN_ZI" }), "16:9");
  assert.equal(aspectForCard({ name: "no-underscore" }), "16:9");
});

test("isToggleChecked reads aria-checked, then falls back to aria-pressed", async () => {
  const { isToggleChecked } = loadAspectControl();
  assert.equal(await isToggleChecked({ getAttribute: async (n) => (n === "aria-checked" ? "true" : null) }), true);
  assert.equal(await isToggleChecked({ getAttribute: async (n) => (n === "aria-pressed" ? "true" : null) }), true);
  assert.equal(await isToggleChecked({ getAttribute: async () => null }), false);
  // A throwing getAttribute (detached element) must not throw the caller.
  assert.equal(await isToggleChecked({ getAttribute: async () => { throw new Error("detached"); } }), false);
});

test("setProjectAspectRatio: no ratio requested is a no-op that returns true without touching the page", async () => {
  const { setProjectAspectRatio } = loadAspectControl();
  const { setProjectAspectRatio: fn } = { setProjectAspectRatio };
  const result = await fn(
    { locator: () => { throw new Error("must not touch the page"); } },
    ""
  );
  assert.equal(result, true);
});

test("setProjectAspectRatio: prompt-box overlay (Agent OFF) selects the ratio and closes, never opening the project panel", async () => {
  const { setProjectAspectRatio } = loadAspectControl();
  const { page, log } = makeFakeFlowPage({
    promptBox: { offered: true, checked: false },
    project: { offered: true, checked: false }, // present too - must not be used
  });
  const ok = await setProjectAspectRatio(page, "1:1");
  assert.equal(ok, true);
  assert.deepEqual(log, ["trigger:button.settings-trigger-button", "click:1:1", "close-click"]);
  // prompt-box has panel:false - Save is never clicked for it.
  assert.ok(!log.includes("save-click"));
});

test("setProjectAspectRatio: an already-selected ratio is left alone (no redundant click) but the overlay still closes", async () => {
  const { setProjectAspectRatio } = loadAspectControl();
  const { page, log } = makeFakeFlowPage({
    promptBox: { offered: true, checked: true },
  });
  const ok = await setProjectAspectRatio(page, "16:9");
  assert.equal(ok, true);
  assert.ok(!log.some((l) => l.startsWith("click:")), "must not click an already-checked toggle");
  assert.ok(log.includes("close-click"));
});

test("setProjectAspectRatio: falls back to the project defaults panel (Agent ON) when the prompt-box overlay is absent, and saves", async () => {
  const { setProjectAspectRatio } = loadAspectControl();
  const { page, log } = makeFakeFlowPage({
    promptBox: null, // not present at all, e.g. Agent mode hides it
    project: { offered: true, checked: false },
  });
  const ok = await setProjectAspectRatio(page, "1:1");
  assert.equal(ok, true);
  assert.deepEqual(log, [
    "trigger:button[aria-label='Settings']",
    "click:1:1",
    "save-click",
    "close-click",
  ]);
});

test("setProjectAspectRatio: no settings control anywhere on the page fails soft (false), never throws", async () => {
  const { setProjectAspectRatio } = loadAspectControl();
  const { page } = makeFakeFlowPage({}); // nothing registered
  const ok = await setProjectAspectRatio(page, "1:1");
  assert.equal(ok, false);
});

test("setProjectAspectRatio: a panel that will not close is reported as failure, not left open forever", async () => {
  const { setProjectAspectRatio } = loadAspectControl();
  const { page } = makeFakeFlowPage({
    promptBox: { offered: true, checked: false },
  });
  // Make the close button permanently absent and Escape a no-op, so the
  // 4-attempt close loop is exhausted.
  const original = page.locator;
  page.locator = (sel) => (sel === "button[aria-label*='close' i]"
    ? { first() { return this; }, count: async () => 0 }
    : original(sel));
  const ok = await setProjectAspectRatio(page, "1:1");
  assert.equal(ok, false);
});
