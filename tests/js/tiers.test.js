// Resolution tier wiring in extension/content.js: the dock must keep speaking
// Renderly's HD/2K/4K vocabulary and keep migrating old stored values.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFunctions } = require("./helpers");

const CONTENT = "extension/content.js";

function tierState({ upscaleTier, upscaleScale } = {}) {
  return {
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            for (const key of [].concat(keys)) {
              out[key] = { upscaleTier, upscaleScale }[key];
            }
            return out;
          },
        },
      },
    },
  };
}

async function loadTierHelpers(state) {
  return loadFunctions(
    CONTENT,
    "const UPSCALE_TIERS",
    "// How many versions each card generates",
    tierState(state),
    ["getUpscaleTier", "UPSCALE_TIERS", "UPSCALE_TIER_LABELS"],
    "upscale tier helpers"
  );
}

test("stored tier names pass through untouched", async () => {
  for (const tier of ["HD", "2K", "4K"]) {
    const { getUpscaleTier } = await loadTierHelpers({ upscaleTier: tier });
    assert.equal(await getUpscaleTier(), tier);
  }
});

test("the pre-rename 1K tier maps onto HD", async () => {
  const { getUpscaleTier } = await loadTierHelpers({ upscaleTier: "1K" });
  assert.equal(await getUpscaleTier(), "HD");
});

test("legacy 2x/3x/4x multipliers map onto the nearest tier", async () => {
  const cases = [
    [4, "4K"],
    [2, "2K"],
    [3, "2K"],
    [1, "HD"],
  ];
  for (const [scale, expected] of cases) {
    const { getUpscaleTier } = await loadTierHelpers({ upscaleScale: scale });
    assert.equal(await getUpscaleTier(), expected, `upscaleScale ${scale}`);
  }
});

test("defaults to 2K when nothing is stored", async () => {
  const { getUpscaleTier } = await loadTierHelpers({});
  assert.equal(await getUpscaleTier(), "2K");
});

test("tier labels match ImgToVideo's preset strings", async () => {
  const { UPSCALE_TIERS, UPSCALE_TIER_LABELS } = await loadTierHelpers({});
  assert.deepEqual(UPSCALE_TIERS, ["HD", "2K", "4K"]);
  assert.deepEqual(UPSCALE_TIER_LABELS, {
    HD: "1920 × 1080 (HD)",
    "2K": "2560 × 1440 (2K)",
    "4K": "3840 × 2160 (4K)",
  });
});
