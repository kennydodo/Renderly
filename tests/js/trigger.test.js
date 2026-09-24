// Regression tests for the Flow trigger path in extension/content.js.
//
// These guards the two bugs that stalled every card:
//   1. triggerGenerate() reporting "clicked" without clicking anything.
//   2. Flow ignoring a bare .click(), so the pointer sequence matters.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFunctions } = require("./helpers");

const CONTENT = "extension/content.js";

function makeHarness(buttons, { armOnWait = false } = {}) {
  const clicked = [];
  const keyed = [];
  const fakeInput = { tag: "EDITOR", dispatchEvent: (e) => keyed.push(e.type) };
  const stubs = {
    deepQueryAll: () => buttons,
    isOurElement: () => false,
    isVisible: () => true,
    getPromptInput: () => fakeInput,
    describeEl: (el) => `<${el && el.tag}>`,
    clickEl: (el) => clicked.push(el),
    waitFor: async (check) => {
      if (armOnWait) buttons.forEach((b) => (b.disabled = false));
      return check();
    },
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
  };
  const api = loadFunctions(
    CONTENT,
    "function findGenerateButton",
    "function captureImageSet",
    stubs,
    ["findGenerateButton", "triggerGenerate"],
    "trigger functions"
  );
  return { api, clicked, keyed, buttons, fakeInput };
}

function button({ label = "", text = "", disabled = false, type = "button" } = {}) {
  return {
    tag: "BUTTON",
    disabled,
    textContent: text,
    getAttribute: (name) =>
      name === "aria-label" ? label : name === "type" ? type : null,
  };
}

test("an enabled generate button is found and actually clicked", async () => {
  const target = button({ label: "Generate" });
  const h = makeHarness([button({ label: "Close" }), target]);
  const res = await h.api.triggerGenerate(null);
  assert.equal(res.clicked, true);
  assert.equal(h.clicked.length, 1, "must click, not just report");
  assert.equal(h.clicked[0], target);
});

test("a disabled button is waited on, then clicked once armed", async () => {
  const target = button({ label: "Generate", disabled: true });
  const h = makeHarness([target], { armOnWait: true });
  const res = await h.api.triggerGenerate(null);
  assert.equal(res.clicked, true);
  assert.equal(h.clicked.length, 1);
  assert.equal(h.clicked[0], target);
});

test("an enabled match wins over a disabled one, whatever the matcher", async () => {
  const disabledCreate = button({ label: "Create", disabled: true });
  const enabledGenerate = button({ text: "Start generation" });
  const h = makeHarness([disabledCreate, enabledGenerate]);
  assert.equal(h.api.findGenerateButton(), enabledGenerate);
  const res = await h.api.triggerGenerate(null);
  assert.equal(h.clicked.length, 1);
  assert.equal(h.clicked[0], enabledGenerate);
});

test("generate outranks a generic Create button (we really click now)", () => {
  const create = button({ label: "Create" });
  const generate = button({ label: "Start generation" });
  const h = makeHarness([create, generate]);
  assert.equal(h.api.findGenerateButton(), generate);
});

test("no button at all falls back to Enter on the live editor", async () => {
  const h = makeHarness([]);
  const res = await h.api.triggerGenerate(null);
  assert.equal(res.clicked, true);
  assert.equal(h.clicked.length, 0);
  assert.deepEqual(h.keyed, ["keydown", "keypress", "keyup"]);
});

test("Enter goes to the live editor, never to a stale node", async () => {
  const h = makeHarness([]);
  const stale = { tag: "STALE", dispatchEvent: () => {} };
  await h.api.triggerGenerate(stale);
  assert.equal(h.keyed.length, 3);
});

test("clickEl sends the full pointer + mouse sequence Flow needs", () => {
  const events = [];
  class FakePointerEvent {
    constructor(type) {
      this.type = type;
    }
  }
  class FakeMouseEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const el = {
    scrolled: 0,
    focused: 0,
    clicked: 0,
    scrollIntoView() {
      this.scrolled++;
    },
    focus() {
      this.focused++;
    },
    click() {
      this.clicked++;
    },
    dispatchEvent(e) {
      events.push(e.type);
      return true;
    },
  };
  const { clickEl } = loadFunctions(
    CONTENT,
    "function clickEl",
    "function sleep",
    { window: { PointerEvent: FakePointerEvent }, PointerEvent: FakePointerEvent, MouseEvent: FakeMouseEvent },
    ["clickEl"],
    "clickEl"
  );
  clickEl(el);
  assert.equal(el.scrolled, 1);
  assert.equal(el.focused, 1);
  assert.equal(el.clicked, 1);
  for (const type of [
    "pointerover",
    "pointerenter",
    "pointermove",
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
  ]) {
    assert.ok(events.includes(type), `expected ${type} among [${events.join(", ")}]`);
  }
});

test("topLevelPoint folds same-origin iframe offsets into CDP coordinates", () => {
  const topWin = {};
  const frameEl = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }),
    ownerDocument: { defaultView: topWin },
  };
  const innerWin = { frameElement: frameEl };
  const el = {
    scrollIntoView() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
    ownerDocument: { defaultView: innerWin },
  };
  const { topLevelPoint } = loadFunctions(
    CONTENT,
    "function topLevelPoint",
    "async function trustedFill",
    { window: topWin },
    ["topLevelPoint"],
    "topLevelPoint"
  );
  // Frame offset (100, 50) + centre of the 200x100 rect at (10, 20).
  assert.deepEqual(topLevelPoint(el), { x: 210, y: 120 });
});
