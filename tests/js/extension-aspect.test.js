// The Chrome extension (extension/content.js) picks Flow's aspect ratio per
// shot from the motion code on the shot name, like extension-v2's driver:
// PU/PD -> 1:1, everything else (incl. PL/PR/PV, which Flow cannot do at
// 21:9) -> 16:9. The settings panel is only touched when the ratio changes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFunctions } = require("./helpers");

const SRC = "extension/content.js";

function load(stubs = {}) {
  return loadFunctions(
    SRC,
    "const FLOW_MOTION_ASPECT = {",
    "async function waitForNewImage(",
    {
      sleep: async () => {},
      console,
      isOurElement: () => false,
      isVisible: () => true,
      document: { dispatchEvent() {}, querySelectorAll: () => [] },
      KeyboardEvent: class {},
      ...stubs,
    },
    ["aspectForName", "setFlowAspectRatio", "isToggleOn"],
    "extension aspect"
  );
}

test("aspectForName: PU/PD are 1:1, everything else 16:9", () => {
  const { aspectForName } = load();
  assert.equal(aspectForName("S02_05_PROC_PU"), "1:1");
  assert.equal(aspectForName("S02_05_PROC_PD"), "1:1");
  assert.equal(aspectForName("S02_05_PROC_pu"), "1:1");
  for (const m of ["PL", "PR", "PV", "ZI", "ZO", "ST"]) {
    assert.equal(aspectForName(`S01_01_SCN_${m}`), "16:9", m);
  }
  assert.equal(aspectForName(null), "16:9");
  assert.equal(aspectForName("no-underscore"), "16:9");
});

function fakePanel({ offers = ["16:9", "1:1"], on = "16:9" } = {}) {
  const state = { open: false, selected: on, clicks: [] };
  const mk = (label) => ({
    textContent: label,
    getAttribute: (n) => (n === "aria-checked" && state.selected === label ? "true" : null),
    label,
  });
  const options = offers.map(mk);
  const trigger = { id: "trigger" };
  const close = { id: "close" };
  const group = { querySelectorAll: () => options };
  const deepQueryAll = (sel) => {
    if (sel === "button.settings-trigger-button") return [trigger];
    if (sel === "flow-toggles[aria-label='Aspect ratio']") return state.open ? [group] : [];
    if (sel === "button[aria-label='Back']") return state.open ? [close] : [];
    return [];
  };
  const clickEl = (el) => {
    state.clicks.push(el.id || el.label);
    if (el === trigger) state.open = true;
    else if (el === close) state.open = false;
    else if (el.label) state.selected = el.label;
  };
  return { state, stubs: { deepQueryAll, clickEl } };
}

test("setFlowAspectRatio selects the ratio and closes the panel", async () => {
  const { state, stubs } = fakePanel();
  const { setFlowAspectRatio } = load(stubs);
  assert.equal(await setFlowAspectRatio("1:1"), true);
  assert.equal(state.selected, "1:1");
  assert.equal(state.open, false);
});

test("setFlowAspectRatio leaves an already-selected ratio alone", async () => {
  const { state, stubs } = fakePanel({ on: "1:1" });
  const { setFlowAspectRatio } = load(stubs);
  assert.equal(await setFlowAspectRatio("1:1"), true);
  assert.ok(!state.clicks.includes("1:1"), "no click on the already-on option");
});

test("setFlowAspectRatio degrades to false when the ratio is not offered or no control exists", async () => {
  const a = fakePanel({ offers: ["16:9"] });
  assert.equal(await load(a.stubs).setFlowAspectRatio("1:1"), false);
  assert.equal(a.state.open, false, "panel still closed");
  const none = load({ deepQueryAll: () => [], clickEl() {} });
  assert.equal(await none.setFlowAspectRatio("1:1"), false);
});
