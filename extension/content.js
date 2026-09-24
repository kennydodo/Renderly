const DOCK_ID = "renderly-dock";
// Read from the manifest so the dock can never claim a stale version again.
const DOCK_VERSION = chrome.runtime.getManifest().version;
const DEFAULT_BACKEND = "http://127.0.0.1:8022";

const PRESETS = [
  [
    "Keep 2D Style",
    ", keep the exact same warm 2D editorial illustration style: clean refined line work, soft natural colors, subtle paper-like texture, Japanese minimalist influence, polished modern lifestyle-magazine quality",
  ],
  ["Slow 35mm pan", ", slow 35mm pan, natural lighting, high dynamic range"],
  ["Drone reveal", ", sweeping drone reveal shot, cinematic scale, golden light"],
  ["Handheld follow", ", handheld follow-cam, shallow depth of field, documentary feel"],
  ["Macro detail", ", extreme macro detail, crisp textures, studio lighting"],
  ["Golden hour", ", golden hour light, long warm shadows, filmic haze"],
  ["Night neon", ", neon night city ambience, wet reflections, anamorphic flare"],
  ["Vox-style motion", ", animated infographic motion graphics, clean vector shapes"],
];

let lastFlowImage = null;
let observer = null;
let templates = [];
let cards = []; // {id, text, refs: [{label, localFile}]}
let masterRefs = []; // global references applied to every card
let cardSeq = 0;
let batchRunning = false;

/* ================= Flow DOM helpers ================= */

function deepDocs() {
  const docs = [document];
  document.querySelectorAll("iframe").forEach((frame) => {
    try {
      if (frame.contentDocument) docs.push(frame.contentDocument);
    } catch {
      /* cross-origin iframe */
    }
  });
  return docs;
}

function* walkRoots(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  yield root;
  if (typeof root.createTreeWalker !== "function") return;
  const walker = root.createTreeWalker(root, NodeFilter ? NodeFilter.SHOW_ELEMENT : 1);
  let node = walker.nextNode();
  while (node) {
    if (node.shadowRoot) yield* walkRoots(node.shadowRoot);
    node = walker.nextNode();
  }
}

function deepQueryAll(selector) {
  const found = [];
  for (const doc of deepDocs()) {
    for (const root of walkRoots(doc)) {
      try {
        root.querySelectorAll(selector).forEach((el) => found.push(el));
      } catch {
        /* skip */
      }
    }
  }
  return found;
}

function isOurElement(el) {
  return (
    !!el.closest && !!el.closest(`#${DOCK_ID}, #${DOCK_ID}-settings`)
  );
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function getPromptInput() {
  const candidates = deepQueryAll(
    'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"], input[type="text"]'
  ).filter((el) => !isOurElement(el));
  const visible = candidates.filter(isVisible);
  const pool = visible.length ? visible : candidates;
  return (
    pool.find((el) => el.tagName === "TEXTAREA") ||
    pool.find((el) => el.getAttribute("role") === "textbox") ||
    pool.find((el) => el.isContentEditable) ||
    pool[0] ||
    null
  );
}

function describeEl(el) {
  if (!el) return "null";
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") || "";
  const aria = el.getAttribute("aria-label") || "";
  const ph = el.getAttribute("placeholder") || "";
  const ce = el.isContentEditable ? " contenteditable" : "";
  return `<${tag}${role ? ` role="${role}"` : ""}${aria ? ` aria-label="${aria}"` : ""}${
    ph ? ` placeholder="${ph}"` : ""
  }${ce}>`;
}

function setPromptText(input, text) {
  input.focus();
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const proto =
      input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const apply = () => {
      if (valueSetter) valueSetter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    };
    apply();
    // React-controlled inputs may normalize the value (e.g. trim) — accept that.
    if ((input.value || "").trim() === text.trim()) return true;
    // Fallback: select-all + insertText for inputs that ignore value setters.
    try {
      if (input.select) input.select();
      if (document.execCommand("insertText", false, text)) {
        apply();
        return (input.value || "").trim() === text.trim();
      }
    } catch {
      /* ignore */
    }
    apply();
    return (input.value || "").trim() === text.trim();
  }

  const doc = input.ownerDocument;
  input.focus();
  try {
    doc.execCommand("selectAll", false, null);
  } catch {
    /* ignore */
  }
  let ok = false;
  try {
    ok = doc.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }
  if (!(ok && (input.textContent || "").includes(text.slice(0, 40)))) {
    // Rich editors (Slate, Lexical, ProseMirror) listen for beforeinput:
    // if they cancel it they perform the insertion themselves.
    let handled = false;
    try {
      handled = !input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        })
      );
    } catch {
      /* ignore */
    }
    if (!handled) {
      // Synthetic events trigger no default action — insert manually.
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
    }
  }
  input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  return (input.textContent || "").includes(text.slice(0, 40));
}

// Re-check whether the prompt text made it into Flow's box — editor state
// can settle asynchronously after the initial insertion.
function promptFilled(input, prompt) {
  if (!input) return false;
  const needle = prompt.trim().slice(0, 40);
  if (!needle) return false;
  const value = input.value !== undefined ? String(input.value) : "";
  return value.includes(needle) || String(input.textContent || "").includes(needle);
}

function findGenerateButton() {
  const buttons = deepQueryAll('button, [role="button"], input[type="submit"]').filter(
    (b) => !isOurElement(b) && isVisible(b)
  );
  const label = (b) =>
    `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`.toLowerCase();
  // Most-specific first: a generic "Create" button must never beat the
  // composer's real Generate control now that we actually click it.
  const tiers = [
    (b) => /generat|submit/.test(label(b)),
    (b) => /render/.test(label(b)),
    (b) => /\bsend\b/.test(label(b)),
    (b) => /create/.test(label(b)),
    (b) => b.getAttribute("type") === "submit",
  ];
  const matches = [];
  for (const test of tiers) {
    for (const b of buttons) {
      if (!matches.includes(b) && test(b)) matches.push(b);
    }
  }
  // Prefer an enabled match, but fall back to a disabled one so the caller can
  // wait for it to arm instead of giving up.
  return matches.find((b) => !b.disabled) || matches[0] || null;
}

async function triggerGenerate(input) {
  // Flow's editor can be replaced when its state settles after a programmatic
  // insert, so re-resolve the prompt box rather than reusing a stale node.
  const box = getPromptInput() || input;
  const button = findGenerateButton();

  if (button) {
    // The button arms a beat after the prompt lands. Wait for it to enable,
    // then CLICK it for real: Flow ignores untrusted keyboard events, so
    // dispatching Enter alone never started a generation (this used to report
    // clicked:true without clicking anything, stalling every card).
    if (button.disabled) await waitFor(() => !button.disabled, 3000, 150);
    if (!button.disabled) {
      try {
        clickEl(button);
        return { clicked: true, how: describeEl(button) };
      } catch {
        /* fall through to Enter */
      }
    }
  }

  // No usable button: try Enter on the live editor as a last resort.
  if (box) {
    ["keydown", "keypress", "keyup"].forEach((type) => {
      box.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    return { clicked: true, how: `Enter on ${describeEl(box)}` };
  }

  return { clicked: false, how: null };
}

// Flow's Angular composer ignores programmatic edits — the text shows up in the
// DOM but the submit arrow never arms, so there is nothing for a synthetic
// click to fire. Replay the fill (and the click) as trusted input over the
// DevTools protocol, the same approach the extension-v2 driver uses.
function setOurUiHidden(hidden) {
  // Keep layout intact (visibility, not display) so Flow doesn't reflow, but
  // take the dock out of hit-testing — a trusted click must not land on us.
  [DOCK_ID, `${DOCK_ID}-settings`, `${DOCK_ID}-ref-toast`].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.visibility = hidden ? "hidden" : "";
  });
}

// Viewport coordinates for CDP input. An element inside a same-origin iframe
// reports rects relative to that frame, so add each frame's offset on the way up.
function topLevelPoint(el) {
  try {
    el.scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  let rect = el.getBoundingClientRect();
  let win = el.ownerDocument && el.ownerDocument.defaultView;
  while (win && win !== window) {
    const frame = win.frameElement;
    if (!frame) break;
    const frameRect = frame.getBoundingClientRect();
    rect = {
      left: rect.left + frameRect.left,
      top: rect.top + frameRect.top,
      width: rect.width,
      height: rect.height,
    };
    win = frame.ownerDocument && frame.ownerDocument.defaultView;
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

async function trustedFill(text) {
  const composer = getPromptInput();
  if (!composer) return { ok: false, error: "no composer found" };
  setOurUiHidden(true);
  try {
    return await sendToBackground({
      type: "trustedFill",
      text,
      composer: topLevelPoint(composer),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    setOurUiHidden(false);
  }
}

async function trustedClick() {
  const button = findGenerateButton();
  if (!button) return { ok: false, error: "no generate button" };
  setOurUiHidden(true);
  try {
    return await sendToBackground({ type: "trustedClick", button: topLevelPoint(button) });
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    setOurUiHidden(false);
  }
}

function captureImageSet() {
  const set = new Set();
  deepQueryAll("img").forEach((img) => {
    if (img.complete && img.naturalWidth >= 512) set.add(img.currentSrc || img.src);
  });
  return set;
}

function scanForImages() {
  deepQueryAll("img").forEach((img) => {
    if (img.complete && img.naturalWidth >= 512 && img.naturalHeight >= 512) {
      lastFlowImage = img;
    }
  });
}

function clickEl(el) {
  el.scrollIntoView({ block: "center" });
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* not focusable — ignore */
  }
  const opts = { bubbles: true, cancelable: true, view: window };
  // A full pointer sequence, not just click(): Flow's controls arm on
  // pointerdown/mousedown, and a bare .click() can leave them un-armed.
  if (window.PointerEvent) {
    [
      ["pointerover", 0],
      ["pointerenter", 0],
      ["pointermove", 0],
      ["pointerdown", 1],
      ["pointerup", 0],
    ].forEach(([type, buttons]) => {
      try {
        el.dispatchEvent(
          new PointerEvent(type, {
            ...opts,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons,
          })
        );
      } catch {
        /* PointerEvent not constructible — skip */
      }
    });
  }
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll a check until it passes or the timeout elapses (resolves false).
function waitFor(check, timeoutMs, stepMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let result = false;
      try {
        result = check();
      } catch {
        result = false;
      }
      if (result) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

async function waitForNewImage(beforeSet, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    scanForImages();
    const candidates = deepQueryAll("img").filter((img) => {
      const src = img.currentSrc || img.src;
      return (
        src &&
        !beforeSet.has(src) &&
        img.complete &&
        img.naturalWidth >= 512 &&
        img.naturalHeight >= 512 &&
        !isOurElement(img)
      );
    });
    if (candidates.length) return candidates[candidates.length - 1];
    if (onTick) onTick(Math.round((deadline - Date.now()) / 1000));
    await sleep(1500);
  }
  return null;
}

/* ================= Renderly backend ================= */

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!res) {
        reject(new Error("No response from extension background"));
      } else if (!res.ok) {
        const data = res.data;
        const detail =
          typeof data?.detail === "string"
            ? data.detail
            : data?.detail
              ? JSON.stringify(data.detail)
              : `HTTP ${res.status}`;
        reject(new Error(res.error || detail));
      } else {
        resolve(res);
      }
    });
  });
}

async function getBackendBase() {
  try {
    const res = await sendToBackground({ type: "getBackend" });
    return res.backend;
  } catch {
    const { backendUrl } = await chrome.storage.local.get("backendUrl");
    return (backendUrl || DEFAULT_BACKEND).replace(/\/+$/, "");
  }
}

async function backendJson(path, options = {}) {
  const base = await getBackendBase();
  const url = new URL(path, base).href;
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    const r = await sendToBackground({
      type: "api",
      path,
      method: options.method || "GET",
      body: options.body !== undefined ? JSON.parse(options.body) : undefined,
    });
    const fallbackData = r.data;
    if (!r.ok) {
      const detail =
        typeof fallbackData?.detail === "string"
          ? fallbackData.detail
          : fallbackData?.detail
            ? JSON.stringify(fallbackData.detail)
            : `HTTP ${r.status}`;
      throw new Error(detail);
    }
    return fallbackData;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail =
      typeof data?.detail === "string"
        ? data.detail
        : data?.detail
          ? JSON.stringify(data.detail)
          : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return data;
}

async function fetchImageAsBlob(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch {
    const res = await sendToBackground({ type: "fetchImage", url });
    return await (await fetch(res.dataUrl)).blob();
  }
}

async function imageToDataUrl(img) {
  const src = img.currentSrc || img.src;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read image data"));
      reader.readAsDataURL(blob);
    });
  } catch {
    const res = await sendToBackground({ type: "fetchImage", url: src });
    return res.dataUrl;
  }
}

function downloadBlob(blob, filename) {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
}

// Save the copy Renderly already holds. Preferred route is chrome.downloads on
// the backend URL — a page-initiated blob download gets dropped by Chrome's
// automatic-download blocking, and fetching Flow's own image is CORS-bound.
async function saveToDisk(imageUrl, filename) {
  if (!imageUrl) return { ok: false, error: "no image url" };
  let absolute;
  try {
    const base = await getBackendBase();
    absolute = new URL(imageUrl, base).href;
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const res = await sendToBackground({ type: "download", url: absolute, filename });
    if (res.downloadId) return { ok: true };
    throw new Error(res.error || "download rejected");
  } catch (err) {
    try {
      const blob = await fetchImageAsBlob(absolute);
      if (!blob) throw new Error("image fetch failed");
      downloadBlob(blob, filename);
      return { ok: true };
    } catch (fallbackErr) {
      return { ok: false, error: fallbackErr.message || err.message };
    }
  }
}

async function importToRenderly(channelId, dataUrl, name, prompt) {
  const res = await sendToBackground({
    type: "importGeneration",
    channelId,
    dataUrl,
    name: name || "",
    prompt: prompt || "",
    filename: `flow-${Date.now()}.png`,
  });
  return res.data;
}

async function waitForContinue(titleText) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:rgba(8,9,14,0.75);display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText =
      "background:#1e1f20;border:1px solid #444746;border-radius:12px;padding:20px;max-width:420px;font-family:system-ui,sans-serif;color:#e8eaed;font-size:13px;display:flex;flex-direction:column;gap:12px;";
    const title = document.createElement("p");
    title.style.cssText = "margin:0;white-space:pre-wrap;";
    title.textContent = titleText;
    const btn = document.createElement("button");
    btn.textContent = "Continue →";
    btn.style.cssText =
      "background:#0b57d0;color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;";
    btn.onclick = () => {
      overlay.remove();
      resolve();
    };
    box.appendChild(title);
    box.appendChild(btn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// Non-blocking guide toast for reference attachment: it never covers the
// page, so the user can still click Flow's own controls while it is visible.
function showRefToast(titleText) {
  const panel = document.createElement("div");
  panel.id = `${DOCK_ID}-ref-toast`;
  panel.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "left:24px",
    "z-index:100001",
    "background:#1e1f20",
    "border:1px solid #8ab4f8",
    "border-radius:12px",
    "padding:14px",
    "max-width:320px",
    "font-family:system-ui,sans-serif",
    "color:#e8eaed",
    "font-size:13px",
    "box-shadow:0 4px 14px rgba(0,0,0,0.5)",
  ].join(";");
  const text = document.createElement("p");
  text.style.cssText = "margin:0 0 10px;white-space:pre-wrap;";
  text.textContent = titleText;
  const done = document.createElement("button");
  done.textContent = "Done →";
  done.style.cssText =
    "background:#0b57d0;color:#fff;border:none;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;";
  panel.appendChild(text);
  panel.appendChild(done);
  document.body.appendChild(panel);
  const promise = new Promise((resolve) => {
    done.onclick = () => resolve();
  });
  return { promise, remove: () => panel.remove() };
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ================= Prompt naming + Flow attachment helpers ================= */

// A leading "NAME.png" / "NAME.jpg" token in a prompt names the output.
const NAME_TOKEN_RE = /^\s*([\w\-]+\.(?:png|jpe?g))\s+(.*)$/i;

// "images/S02_05_PROC_PV.png" → "S02_05_PROC_PV" — strips paths, quotes and
// known image extensions, whatever form the value arrives in.
function stemName(value) {
  let v = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  v = v.split(/[\\/]/).pop() || "";
  v = v.replace(/\.(png|jpe?g|webp)$/i, "").trim();
  return v || null;
}

// Pull {name, prompt} out of a JSON batch entry. Accepts several field names
// so it keeps working regardless of what is given.
function extractFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const fileField =
    obj.file || obj.filename || obj.file_name || obj.name || obj.image || obj.output;
  const promptField = obj.prompt || obj.text || obj.description || obj.body || "";
  const name = fileField ? stemName(fileField) : null;
  const prompt = String(promptField).trim();
  if (!name && !prompt) return null;
  return { name, prompt };
}

// Extract the output name and the actual prompt from a card line. Handles:
//  1. JSON lines:      { "file": "S02_05_PROC_PV.png", "prompt": "…" }
//  2. Leading token:   "S02_05_PROC_PV.png Clean flat infographic…"
//  3. File token anywhere: "Clean flat infographic S02_05_PROC_PV.png …"
//  4. Anything else: the whole text is the prompt (backend auto-names it).
function splitPromptName(text) {
  const raw = String(text || "").trim();

  if (raw.startsWith("{")) {
    try {
      const parsed = extractFromObject(JSON.parse(raw));
      if (parsed) return { name: parsed.name, prompt: parsed.prompt || raw };
    } catch {
      /* not valid JSON — fall through */
    }
  }

  const match = raw.match(NAME_TOKEN_RE);
  if (match && match[2].trim()) {
    return { name: stemName(match[1]), prompt: match[2].trim() };
  }

  const anyFile = raw.match(/[\w\-]+\.(?:png|jpe?g|webp)/i);
  if (anyFile) {
    return { name: stemName(anyFile[0]), prompt: raw };
  }

  return { name: null, prompt: raw };
}

// Mirrors the backend's _sanitize_filename: safe for use as a download name.
function safeFileName(name) {
  let cleaned = String(name || "")
    .replace(/[^\w\-.]/g, "_")
    .replace(/^[._ ]+|[._ ]+$/g, "");
  if (/\.(png|jpe?g|webp)$/i.test(cleaned)) cleaned = cleaned.replace(/\.[^.]+$/, "");
  return cleaned || "image";
}

// Output resolution tiers for the auto-upscale step (Renderly's local GPU
// upscale targets, named like ImgToVideo's render presets).
const UPSCALE_TIERS = ["HD", "2K", "4K"];
const UPSCALE_TIER_LABELS = {
  HD: "1920 × 1080 (HD)",
  "2K": "2560 × 1440 (2K)",
  "4K": "3840 × 2160 (4K)",
};

async function getUpscaleTier() {
  try {
    const { upscaleTier, upscaleScale } = await chrome.storage.local.get([
      "upscaleTier",
      "upscaleScale",
    ]);
    if (UPSCALE_TIERS.includes(upscaleTier)) return upscaleTier;
    if (upscaleTier === "1K") return "HD"; // pre-rename tier name
    // Legacy 2×/4× value: 4× was the old 4K, 2×/3× map onto 2K, 1× onto HD.
    const legacy = Number(upscaleScale);
    if (legacy === 4) return "4K";
    if (legacy === 2 || legacy === 3) return "2K";
    if (legacy === 1) return "HD";
  } catch {
    /* fall through to default */
  }
  return "2K";
}

// How many versions each card generates (1-4).
async function getCardVersions() {
  try {
    const { cardVersions } = await chrome.storage.local.get("cardVersions");
    const n = Number(cardVersions);
    if (n >= 1 && n <= 4) return n;
  } catch {
    /* fall through to default */
  }
  return 1;
}

// How many automatic retries a failed card gets before the retry chip appears.
async function getRetryAttempts() {
  try {
    const { retryAttempts } = await chrome.storage.local.get("retryAttempts");
    const n = Number(retryAttempts);
    if (n >= 0 && n <= 3) return n;
  } catch {
    /* fall through to default */
  }
  return 2;
}

// Tiny preview thumbnails for reference chips.
function refThumbUrl(ref) {
  if (ref.url) return ref.url;
  if (!ref._thumbUrl && ref.localFile) ref._thumbUrl = URL.createObjectURL(ref.localFile);
  return ref._thumbUrl || "";
}

function revokeRef(ref) {
  if (ref._thumbUrl) {
    URL.revokeObjectURL(ref._thumbUrl);
    ref._thumbUrl = null;
  }
}

// Collapsible settings section: a ＋/－ header toggles its body.
function buildSettingItem(title, contentEls) {
  const wrap = document.createElement("div");
  wrap.className = "setting";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "setting-head";
  const plus = document.createElement("span");
  plus.className = "plus";
  plus.textContent = "＋";
  const label = document.createElement("span");
  label.textContent = title;
  head.appendChild(plus);
  head.appendChild(label);
  const body = document.createElement("div");
  body.className = "setting-body";
  (Array.isArray(contentEls) ? contentEls : [contentEls]).forEach((el) =>
    body.appendChild(el)
  );
  head.onclick = () => {
    const open = body.classList.toggle("open");
    plus.textContent = open ? "－" : "＋";
  };
  wrap.appendChild(head);
  wrap.appendChild(body);
  return {
    wrap,
    open() {
      body.classList.add("open");
      plus.textContent = "－";
    },
  };
}

/* ================= Dock UI ================= */

function buildDock() {
  // Remove any orphaned dock/panel/style left by a previous content script
  // (e.g. after an extension reload without a tab reload), then build fresh.
  // "rosterly-*" ids are legacy leftovers from before the Renderly rename.
  const orphanIds = [
    DOCK_ID,
    "rosterly-dock",
    `${DOCK_ID}-settings`,
    "rosterly-dock-settings",
    `${DOCK_ID}-style`,
    "rosterly-dock-style",
  ];
  orphanIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  // Styling for the dock, cards and settings panel — always rebuilt so rule
  // changes take effect without a tab reload.
  const style = document.createElement("style");
  style.id = `${DOCK_ID}-style`;
  style.textContent = [
      `#${DOCK_ID} .cards::-webkit-scrollbar { width: 8px; }`,
      `#${DOCK_ID} .cards::-webkit-scrollbar-track { background: transparent; }`,
      `#${DOCK_ID} .cards::-webkit-scrollbar-thumb { background: #5f6368; border-radius: 4px; }`,
      `#${DOCK_ID} .cards::-webkit-scrollbar-thumb:hover { background: #80868b; }`,
      `#${DOCK_ID} .card { display:flex; flex-direction:column; gap:6px; padding:8px; border-radius:12px; background:linear-gradient(180deg,#2a2c31,#26282b); border:1px solid rgba(255,255,255,0.08); transition:border-color .15s ease, box-shadow .15s ease; }`,
      `#${DOCK_ID} .card:hover { border-color:rgba(138,180,248,0.45); box-shadow:0 2px 10px rgba(0,0,0,0.35); }`,
      `#${DOCK_ID} .card-top { display:flex; align-items:flex-start; gap:6px; }`,
      `#${DOCK_ID} .card-num { flex:none; width:20px; height:20px; margin-top:5px; display:flex; align-items:center; justify-content:center; background:#0b57d0; color:#fff; font-size:11px; font-weight:600; border-radius:6px; }`,
      `#${DOCK_ID} .card textarea { flex:1; box-sizing:border-box; background:#1e1f20; border:1px solid rgba(255,255,255,0.06); border-radius:8px; color:#e8eaed; font-size:12px; font-family:inherit; padding:6px 8px; resize:vertical; min-height:46px; transition:border-color .15s ease; }`,
      `#${DOCK_ID} .card textarea:focus { outline:none; border-color:#8ab4f8; }`,
      `#${DOCK_ID} .card-del { flex:none; width:24px; height:24px; border:none; background:transparent; color:#9aa0a6; border-radius:6px; cursor:pointer; font-size:13px; line-height:1; transition:background .15s ease, color .15s ease; }`,
      `#${DOCK_ID} .card-del:hover { background:rgba(242,139,130,0.15); color:#f28b82; }`,
      `#${DOCK_ID} .card-actions { display:flex; gap:6px; }`,
      `#${DOCK_ID} .chip-btn { background:#303134; color:#c7cad1; border:1px solid rgba(255,255,255,0.08); border-radius:999px; padding:3px 10px; font-size:11px; cursor:pointer; transition:background .15s ease, border-color .15s ease, color .15s ease; }`,
      `#${DOCK_ID} .chip-btn:hover { background:#3c4043; border-color:rgba(138,180,248,0.4); color:#e8eaed; }`,
      `#${DOCK_ID} .chip-btn.retry-btn { color:#81c995; border-color:rgba(52,168,83,0.5); }`,
      `#${DOCK_ID} .chip-btn.retry-btn:hover { background:rgba(52,168,83,0.12); border-color:#34a853; color:#81c995; }`,
      `#${DOCK_ID} .chip-btn.retry-btn:disabled { opacity:0.6; cursor:default; }`,
      `#${DOCK_ID} .ref-strip { display:flex; flex-wrap:wrap; gap:4px; }`,
      `#${DOCK_ID} .ref-chip { display:inline-flex; align-items:center; gap:4px; background:#303134; border:1px solid rgba(255,255,255,0.08); border-radius:999px; padding:2px 6px 2px 2px; font-size:10px; color:#e8eaed; max-width:150px; }`,
      `#${DOCK_ID} .ref-chip img { width:18px; height:18px; border-radius:999px; object-fit:cover; flex:none; background:#202124; }`,
      `#${DOCK_ID} .ref-chip .ref-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:86px; }`,
      `#${DOCK_ID} .ref-chip button { border:none; background:transparent; color:#9aa0a6; cursor:pointer; font-size:10px; padding:0 2px; }`,
      `#${DOCK_ID} .ref-chip button:hover { color:#f28b82; }`,
      `#${DOCK_ID} .picker { display:flex; flex-wrap:wrap; gap:4px; max-height:110px; overflow-y:auto; border:1px dashed rgba(255,255,255,0.2); border-radius:8px; padding:4px; }`,
      `#${DOCK_ID} .picker img { width:44px; height:44px; object-fit:cover; border-radius:6px; cursor:pointer; border:2px solid transparent; }`,
      `#${DOCK_ID} .picker img.sel { border-color:#34a853; }`,
      `#${DOCK_ID} .picker .hint { font-size:11px; color:#9aa0a6; }`,
      `#${DOCK_ID} .card-status { font-size:11px; color:#9aa0a6; min-height:13px; }`,
      `#${DOCK_ID} .card-status.err { color:#f28b82; }`,
      `#${DOCK_ID} .card-status.ok { color:#81c995; }`,
      `#${DOCK_ID} .cards-empty { font-size:11px; color:#9aa0a6; }`,
      `#${DOCK_ID} .progress { height:4px; background:#303134; border-radius:2px; overflow:hidden; margin:0 2px; display:none; }`,
      `#${DOCK_ID} .progress-fill { height:100%; width:0%; background:#8ab4f8; border-radius:2px; transition:width .3s ease; }`,
      `#${DOCK_ID} .card.done { opacity:0.72; }`,
      `#${DOCK_ID} .card.done .card-num { background:#188038; }`,
      `#${DOCK_ID} .setting, #${DOCK_ID}-settings .setting { display:flex; flex-direction:column; gap:4px; }`,
      `#${DOCK_ID} .setting-head, #${DOCK_ID}-settings .setting-head { display:flex; align-items:center; gap:6px; width:100%; background:transparent; border:none; color:#e8eaed; font-size:12px; font-weight:600; font-family:inherit; cursor:pointer; padding:2px 0; text-align:left; transition:color .15s ease; }`,
      `#${DOCK_ID} .setting-head:hover, #${DOCK_ID}-settings .setting-head:hover { color:#8ab4f8; }`,
      `#${DOCK_ID} .setting-head .plus, #${DOCK_ID}-settings .setting-head .plus { flex:none; width:16px; text-align:center; color:#9aa0a6; }`,
      `#${DOCK_ID} .setting-body, #${DOCK_ID}-settings .setting-body { display:none; flex-direction:column; gap:4px; padding-left:22px; }`,
      `#${DOCK_ID} .setting-body.open, #${DOCK_ID}-settings .setting-body.open { display:flex; }`,
      `#${DOCK_ID}-settings { position:fixed; bottom:24px; right:396px; z-index:99998; width:300px; max-height:92vh; overflow-y:auto; background:#1e1f20; border:1px solid #444746; border-radius:12px; padding:12px; box-shadow:0 4px 12px rgba(0,0,0,0.4); display:flex; flex-direction:column; gap:8px; font-family:system-ui,sans-serif; font-size:13px; color:#e8eaed; opacity:0; transform:translateX(24px); pointer-events:none; transition:opacity .18s ease, transform .18s ease; }`,
      `#${DOCK_ID}-settings.open { opacity:1; transform:translateX(0); pointer-events:auto; }`,
      `#${DOCK_ID}-settings::-webkit-scrollbar { width: 8px; }`,
      `#${DOCK_ID}-settings::-webkit-scrollbar-thumb { background: #5f6368; border-radius: 4px; }`,
    ].join("\n");
  document.head.appendChild(style);

  const dock = document.createElement("div");
  dock.id = DOCK_ID;
  dock.style.cssText = [
    "position: fixed",
    "bottom: 24px",
    "right: 24px",
    "z-index: 99999",
    "background: #1e1f20",
    "border: 1px solid #444746",
    "border-radius: 10px",
    "padding: 10px",
    "box-shadow: 0 4px 12px rgba(0,0,0,0.4)",
    "display: flex",
    "flex-direction: column",
    "gap: 8px",
    "width: 360px",
    "font-family: system-ui, sans-serif",
    "font-size: 13px",
    "color: #e8eaed",
    "max-height: 92vh",
    "overflow-y: auto",
  ].join(";");

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;";

  const title = document.createElement("span");
  title.textContent = `Renderly for Flow v${DOCK_VERSION}`;
  title.style.cssText = "font-weight:600;letter-spacing:0.3px;";

  const headerRight = document.createElement("div");
  headerRight.style.cssText = "display:flex;gap:4px;";

  const headerBtnStyle =
    "background:#303134;color:#e8eaed;border:1px solid #5f6368;border-radius:6px;width:24px;height:24px;cursor:pointer;line-height:1;";

  const gearBtn = document.createElement("button");
  gearBtn.textContent = "⚙";
  gearBtn.title = "Backend settings";
  gearBtn.style.cssText = headerBtnStyle;

  const collapseBtn = document.createElement("button");
  collapseBtn.textContent = "–";
  collapseBtn.title = "Collapse / expand";
  collapseBtn.style.cssText = headerBtnStyle;

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.title = "Close dock (reopen from the toolbar icon)";
  closeBtn.style.cssText = headerBtnStyle;

  headerRight.appendChild(gearBtn);
  headerRight.appendChild(collapseBtn);
  headerRight.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(headerRight);

  const body = document.createElement("div");
  body.style.cssText = "display:flex;flex-direction:column;gap:8px;";

  const textareaStyle =
    "background:#303134;color:#e8eaed;border:1px solid #5f6368;border-radius:6px;padding:6px;font-size:12px;width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;";
  const buttonStyle =
    "background:#0b57d0;color:#fff;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px;";
  const selectStyle =
    "background:#303134;color:#e8eaed;border:1px solid #5f6368;border-radius:6px;padding:5px;font-size:13px;width:100%;";
  const labelStyle = "font-size:11px;color:#9aa0a6;margin:0;";
  const smallBtnStyle =
    "background:#303134;color:#e8eaed;border:1px solid #5f6368;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;";

  /* ---- settings panel (gear): slides out to the left of the dock ---- */

  const settingsRow = document.createElement("div");
  settingsRow.style.cssText = "display:flex;flex-direction:column;gap:6px;";

  const settingsPanel = document.createElement("div");
  settingsPanel.id = `${DOCK_ID}-settings`;
  // Layout + visibility are inline so the panel works even if the injected
  // stylesheet is ever stale.
  settingsPanel.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "right:396px",
    "z-index:99998",
    "width:300px",
    "max-height:92vh",
    "overflow-y:auto",
    "background:#1e1f20",
    "border:1px solid #444746",
    "border-radius:12px",
    "padding:12px",
    "box-shadow:0 4px 12px rgba(0,0,0,0.4)",
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "font-family:system-ui,sans-serif",
    "font-size:13px",
    "color:#e8eaed",
    "opacity:0",
    "transform:translateX(24px)",
    "pointer-events:none",
    "transition:opacity .18s ease, transform .18s ease",
  ].join(";");
  const panelHeader = document.createElement("div");
  panelHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
  const panelTitle = document.createElement("span");
  panelTitle.textContent = "Renderly settings";
  panelTitle.style.cssText = "font-weight:600;letter-spacing:0.3px;";
  const panelClose = document.createElement("button");
  panelClose.textContent = "✕";
  panelClose.title = "Close settings";
  panelClose.style.cssText = headerBtnStyle;
  panelClose.onclick = () => setSettingsOpen(false);
  panelHeader.appendChild(panelTitle);
  panelHeader.appendChild(panelClose);
  settingsPanel.appendChild(panelHeader);
  settingsPanel.appendChild(settingsRow);
  document.body.appendChild(settingsPanel);

  let settingsOpen = false;
  const setSettingsOpen = (open) => {
    settingsOpen = open;
    settingsPanel.classList.toggle("open", open);
    settingsPanel.style.opacity = open ? "1" : "0";
    settingsPanel.style.transform = open ? "translateX(0)" : "translateX(24px)";
    settingsPanel.style.pointerEvents = open ? "auto" : "none";
    gearBtn.style.background = open ? "#0b57d0" : "#303134";
    gearBtn.style.borderColor = open ? "#8ab4f8" : "#5f6368";
  };

  const backendInput = document.createElement("input");
  backendInput.placeholder = DEFAULT_BACKEND;
  backendInput.style.cssText = selectStyle;

  const backendSave = document.createElement("button");
  backendSave.textContent = "Save URL";
  backendSave.style.cssText = buttonStyle;

  backendSave.onclick = async () => {
    const url = backendInput.value.trim().replace(/\/+$/, "") || DEFAULT_BACKEND;
    await chrome.storage.local.set({ backendUrl: url });
    setSettingsOpen(false);
    setStatus("Backend URL saved.");
    templates = [];
    refreshChannels();
  };

  const channelSelect = document.createElement("select");
  channelSelect.style.cssText = selectStyle;

  const masterLabel = document.createElement("p");
  masterLabel.textContent = "Master prompt (prepended to every card)";
  masterLabel.style.cssText = labelStyle;

  const masterTa = document.createElement("textarea");
  masterTa.rows = 2;
  masterTa.placeholder = "e.g. Warm 2D editorial illustration, Japanese rural setting —";
  masterTa.style.cssText = textareaStyle;

  /* ---- global (master) reference images ---- */

  let masterPickerOpen = false;
  // True once the user attached the global references in Flow this batch —
  // the ingredient persists in the composer across generations.
  let refsAttachedThisBatch = false;

  const masterRefsRow = document.createElement("div");
  masterRefsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";

  const masterRefBtn = document.createElement("button");
  masterRefBtn.className = "chip-btn";
  masterRefBtn.textContent = "＋ Global images";
  masterRefBtn.title =
    "Reference images attached inside Flow for EVERY card (via Flow's own upload control)";
  masterRefBtn.onclick = () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.accept = "image/png,image/jpeg,image/webp";
    fileInput.onchange = () => {
      Array.from(fileInput.files || []).forEach((file) => {
        masterRefs.push({ label: file.name, localFile: file });
      });
      renderMasterRefs();
      if (masterRefs.length) {
        setStatus("Global references set — they will be attached inside Flow for every card.");
      }
    };
    fileInput.click();
  };

  const masterFlowBtn = document.createElement("button");
  masterFlowBtn.className = "chip-btn";
  masterFlowBtn.textContent = "🖼 From Flow";
  masterFlowBtn.title = "Pick visible Flow images as global references";
  masterFlowBtn.onclick = () => {
    scanForImages();
    masterPickerOpen = !masterPickerOpen;
    renderMasterRefs();
  };

  masterRefsRow.appendChild(masterRefBtn);
  masterRefsRow.appendChild(masterFlowBtn);

  const masterRefStrip = document.createElement("div");
  masterRefStrip.className = "ref-strip";

  const masterPicker = document.createElement("div");
  masterPicker.className = "picker";
  masterPicker.style.display = "none";

  const renderMasterRefs = () => {
    if (!Array.isArray(masterRefs)) masterRefs = [];
    masterRefBtn.textContent = `＋ Global images${masterRefs.length ? ` · ${masterRefs.length}` : ""}`;
    masterRefStrip.innerHTML = "";
    masterRefs.forEach((ref, i) => {
      const chip = document.createElement("span");
      chip.className = "ref-chip";
      const thumb = document.createElement("img");
      thumb.src = refThumbUrl(ref);
      thumb.alt = "";
      chip.appendChild(thumb);
      const nameSpan = document.createElement("span");
      nameSpan.className = "ref-name";
      nameSpan.textContent = ref.label;
      nameSpan.title = ref.label;
      chip.appendChild(nameSpan);
      const rm = document.createElement("button");
      rm.textContent = "✕";
      rm.title = "Remove this global reference";
      rm.onclick = () => {
        revokeRef(ref);
        masterRefs.splice(i, 1);
        renderMasterRefs();
      };
      chip.appendChild(rm);
      masterRefStrip.appendChild(chip);
    });

    masterPicker.innerHTML = "";
    if (masterPickerOpen) {
      masterPicker.style.display = "flex";
      const flowImgs = deepQueryAll("img")
        .filter(
          (img) =>
            !isOurElement(img) &&
            img.complete &&
            img.naturalWidth >= 512 &&
            (img.currentSrc || img.src)
        )
        .map((img) => ({ src: img.currentSrc || img.src }))
        .reverse()
        .slice(0, 12);
      if (!flowImgs.length) {
        const span = document.createElement("span");
        span.className = "hint";
        span.textContent = "No Flow images visible — generate something first.";
        masterPicker.appendChild(span);
      }
      flowImgs.forEach((imgInfo) => {
        const selected = masterRefs.some((r) => r.url === imgInfo.src);
        const th = document.createElement("img");
        th.src = imgInfo.src;
        th.title = `Flow image — click to ${selected ? "remove" : "attach"} as global reference`;
        if (selected) th.className = "sel";
        th.onclick = () => {
          if (selected) {
            masterRefs = masterRefs.filter((r) => r.url !== imgInfo.src);
          } else {
            masterRefs.push({ label: "Flow image", url: imgInfo.src });
          }
          renderMasterRefs();
        };
        masterPicker.appendChild(th);
      });
    } else {
      masterPicker.style.display = "none";
    }
  };

  const presetSelect = document.createElement("select");
  presetSelect.style.cssText = selectStyle;

  const presetBtn = document.createElement("button");
  presetBtn.textContent = "+ Add to master";
  presetBtn.style.cssText = buttonStyle;

  const pasteLabel = document.createElement("p");
  pasteLabel.textContent = "Batch prompts — paste one per line, then split";
  pasteLabel.style.cssText = labelStyle;

  const pasteTa = document.createElement("textarea");
  pasteTa.rows = 3;
  pasteTa.placeholder = "First card prompt\nSecond card prompt\nThird card prompt";
  pasteTa.style.cssText = textareaStyle;

  const splitRow = document.createElement("div");
  splitRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

  const splitBtn = document.createElement("button");
  splitBtn.textContent = "✂ Split into cards";
  splitBtn.style.cssText = buttonStyle;

  const addCardBtn = document.createElement("button");
  addCardBtn.textContent = "+ Empty card";
  addCardBtn.style.cssText = smallBtnStyle;

  const removeAllBtn = document.createElement("button");
  removeAllBtn.textContent = "🗑 Remove all";
  removeAllBtn.title = "Remove every card from the list";
  removeAllBtn.style.cssText = smallBtnStyle;
  removeAllBtn.onclick = () => {
    if (!cards.length) {
      setStatus("No cards to remove.", true);
      return;
    }
    cards.forEach((c) => (c.refs || []).forEach(revokeRef));
    cards = [];
    renderCards();
    scheduleSaveCards();
    setStatus("All cards removed.");
  };

  splitRow.appendChild(splitBtn);
  splitRow.appendChild(addCardBtn);
  splitRow.appendChild(removeAllBtn);

  const cardsLabel = document.createElement("p");
  cardsLabel.textContent = "Cards (each = one Flow generation)";
  cardsLabel.style.cssText = labelStyle;

  const cardsBox = document.createElement("div");
  cardsBox.className = "cards";
  cardsBox.style.cssText =
    "display:flex;flex-direction:column;gap:6px;max-height:45vh;overflow-y:auto;padding-right:2px;";

  const autoUpscaleLabel = document.createElement("label");
  autoUpscaleLabel.style.cssText =
    "display:flex;align-items:center;gap:4px;font-size:12px;color:#9aa0a6;cursor:pointer;";
  const autoUpscaleCheck = document.createElement("input");
  autoUpscaleCheck.type = "checkbox";
  autoUpscaleCheck.checked = true;
  autoUpscaleLabel.appendChild(autoUpscaleCheck);
  const autoUpscaleText = document.createElement("span");
  autoUpscaleText.textContent = "Auto-upscale to 2560 × 1440 (2K) + download each result (local GPU)";
  autoUpscaleLabel.appendChild(autoUpscaleText);

  const generateBtn = document.createElement("button");
  generateBtn.textContent = "⚡ Send to Flow — generate all cards";
  generateBtn.style.cssText =
    buttonStyle + "background:#188038;padding:9px 10px;font-weight:600;";

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "■ Stop batch";
  stopBtn.style.cssText =
    "background:#5c1a1a;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:13px;display:none;";

  const diagBtn = document.createElement("button");
  diagBtn.textContent = "🔍 Diagnose page";
  diagBtn.style.cssText = smallBtnStyle;

  const status = document.createElement("span");
  status.style.cssText = "font-size:12px;color:#9aa0a6;min-height:14px;white-space:normal;";

  const setStatus = (text, isError) => {
    status.textContent = text;
    status.style.color = isError ? "#f28b82" : "#9aa0a6";
  };

  /* ---- batch progress bar ---- */

  const progressWrap = document.createElement("div");
  progressWrap.className = "progress";
  const progressFill = document.createElement("div");
  progressFill.className = "progress-fill";
  progressWrap.appendChild(progressFill);

  const setProgress = (done, total) => {
    if (done === null || !total) {
      progressWrap.style.display = "none";
      progressFill.style.width = "0%";
      return;
    }
    progressWrap.style.display = "block";
    progressFill.style.width = `${Math.round((done / total) * 100)}%`;
  };

  /* ---- card persistence (survives page reloads; refs are session-only) ---- */

  let saveTimer = null;
  const scheduleSaveCards = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!cards.length) {
        chrome.storage.local.remove("savedCards");
        return;
      }
      chrome.storage.local.set({
        savedCards: cards.map((c) => ({
          text: c.text,
          name: c.name || null,
          done: !!c.done,
          failed: !!c.failed,
        })),
      });
    }, 500);
  };

  const setCollapsed = (collapsed) => {
    body.style.display = collapsed ? "none" : "flex";
    collapseBtn.textContent = collapsed ? "+" : "–";
    title.style.display = collapsed ? "none" : "";
    dock.style.width = collapsed ? "auto" : "360px";
    dock.title = collapsed ? `Renderly for Flow v${DOCK_VERSION}` : "";
  };

  collapseBtn.onclick = () => setCollapsed(body.style.display !== "none");

  gearBtn.onclick = async () => {
    setSettingsOpen(!settingsOpen);
    if (settingsOpen) backendInput.value = await getBackendBase();
  };

  closeBtn.onclick = () => {
    dock.remove();
    settingsPanel.remove();
  };

  /* ---- cards state & rendering ---- */

  const addCard = (text) => {
    cards.push({ id: ++cardSeq, text: text || "", refs: [] });
    renderCards();
    scheduleSaveCards();
  };

  const removeCard = (id) => {
    cards = cards.filter((c) => c.id !== id);
    renderCards();
    scheduleSaveCards();
  };

  const renderCards = () => {
    cardsBox.innerHTML = "";
    if (!cards.length) {
      const span = document.createElement("span");
      span.className = "cards-empty";
      span.textContent = "No cards yet — paste prompts above and split, or add an empty card.";
      cardsBox.appendChild(span);
      return;
    }
    cards.forEach((card, index) => {
      if (!Array.isArray(card.refs)) card.refs = [];
      const cardEl = document.createElement("div");
      cardEl.className = "card";
      cardEl.dataset.cardId = card.id;
      if (card.done) cardEl.classList.add("done");

      const top = document.createElement("div");
      top.className = "card-top";

      const num = document.createElement("span");
      num.className = "card-num";
      num.textContent = `${index + 1}`;

      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.value = card.text;
      ta.placeholder = `Card ${index + 1} prompt — or "name.png prompt"`;
      ta.oninput = () => {
        card.text = ta.value;
        card.done = false;
        card.failed = false;
        removeRetryButton(card);
        scheduleSaveCards();
      };

      const del = document.createElement("button");
      del.className = "card-del";
      del.textContent = "✕";
      del.title = "Remove card";
      del.onclick = () => {
        card.refs.forEach(revokeRef);
        removeCard(card.id);
      };

      top.appendChild(num);
      top.appendChild(ta);
      top.appendChild(del);
      cardEl.appendChild(top);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      const refBtn = document.createElement("button");
      refBtn.className = "chip-btn";
      refBtn.textContent = `＋ Images${card.refs.length ? ` · ${card.refs.length}` : ""}`;
      refBtn.title = "Attach reference images from your PC — they are attached inside Flow before generating";
      refBtn.onclick = () => {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.accept = "image/png,image/jpeg,image/webp";
        fileInput.onchange = () => {
          Array.from(fileInput.files || []).forEach((file) => {
            card.refs.push({ label: file.name, localFile: file });
          });
          renderCards();
        };
        fileInput.click();
      };

      const flowBtn = document.createElement("button");
      flowBtn.className = "chip-btn";
      flowBtn.textContent = "🖼 From Flow";
      flowBtn.title =
        "Attach images currently visible in Flow (its gallery/results) as references";
      flowBtn.onclick = () => {
        scanForImages();
        const flowImgs = deepQueryAll("img")
          .filter(
            (img) =>
              !isOurElement(img) &&
              img.complete &&
              img.naturalWidth >= 512 &&
              (img.currentSrc || img.src)
          )
          .map((img) => ({ src: img.currentSrc || img.src }))
          // newest last — reverse so the most recent shows first
          .reverse()
          .slice(0, 12);
        if (!flowImgs.length) {
          setStatus("No Flow images found on the page yet.", true);
          return;
        }
        card.pickerOpen = !card.pickerOpen;
        card.flowPicker = true;
        renderCards();
      };

      actions.appendChild(refBtn);
      actions.appendChild(flowBtn);
      cardEl.appendChild(actions);

      if (card.pickerOpen && card.flowPicker) {
        const picker = document.createElement("div");
        picker.className = "picker";
        const flowImgs = deepQueryAll("img")
          .filter(
            (img) =>
              !isOurElement(img) &&
              img.complete &&
              img.naturalWidth >= 512 &&
              (img.currentSrc || img.src)
          )
          .map((img) => ({ src: img.currentSrc || img.src }))
          .reverse()
          .slice(0, 12);

        if (!flowImgs.length) {
          const span = document.createElement("span");
          span.className = "hint";
          span.textContent = "No Flow images visible — generate something first.";
          picker.appendChild(span);
        }

        flowImgs.forEach((imgInfo) => {
          const selected = card.refs.some((r) => r.url === imgInfo.src);
          const th = document.createElement("img");
          th.src = imgInfo.src;
          th.title = `Flow image — click to ${selected ? "remove" : "attach"} as reference`;
          if (selected) th.className = "sel";
          th.onclick = () => {
            if (selected) {
              const ref = card.refs.find((r) => r.url === imgInfo.src);
              if (ref) revokeRef(ref);
              card.refs = card.refs.filter((r) => r.url !== imgInfo.src);
            } else {
              card.refs.push({ label: "Flow image", url: imgInfo.src });
            }
            renderCards();
          };
          picker.appendChild(th);
        });
        cardEl.appendChild(picker);
      }

      if (card.refs.length) {
        const refStrip = document.createElement("div");
        refStrip.className = "ref-strip";
        card.refs.forEach((ref, refIdx) => {
          const chip = document.createElement("span");
          chip.className = "ref-chip";
          const thumb = document.createElement("img");
          thumb.src = refThumbUrl(ref);
          thumb.alt = "";
          chip.appendChild(thumb);
          const nameSpan = document.createElement("span");
          nameSpan.className = "ref-name";
          nameSpan.textContent = ref.label;
          nameSpan.title = ref.label;
          chip.appendChild(nameSpan);
          const rm = document.createElement("button");
          rm.textContent = "✕";
          rm.title = "Remove this image";
          rm.onclick = () => {
            revokeRef(ref);
            card.refs.splice(refIdx, 1);
            renderCards();
          };
          chip.appendChild(rm);
          refStrip.appendChild(chip);
        });
        cardEl.appendChild(refStrip);
      }

      const cardStatus = document.createElement("span");
      cardStatus.className = "card-status";
      cardStatus.dataset.cardId = card.id;
      if (card.done) {
        cardStatus.textContent = "✓ done";
        cardStatus.classList.add("ok");
      }
      cardEl.appendChild(cardStatus);

      cardsBox.appendChild(cardEl);
      if (card.failed) addRetryButton(card);
    });
  };

  const setCardStatus = (id, text, isError) => {
    const el = cardsBox.querySelector(`.card-status[data-card-id="${id}"]`);
    if (el) {
      el.textContent = text;
      el.classList.toggle("err", !!isError);
      el.classList.toggle("ok", !isError && text.includes("✓"));
    }
  };

  // Failed cards get a "↻ Retry" chip that re-runs just that card.
  const removeRetryButton = (card) => {
    const cardEl = cardsBox.querySelector(`.card[data-card-id="${card.id}"]`);
    if (cardEl) {
      const btn = cardEl.querySelector(".retry-btn");
      if (btn) btn.remove();
    }
  };

  const addRetryButton = (card) => {
    const cardEl = cardsBox.querySelector(`.card[data-card-id="${card.id}"]`);
    if (!cardEl || cardEl.querySelector(".retry-btn")) return;
    const actions = cardEl.querySelector(".card-actions");
    if (!actions) return;
    const btn = document.createElement("button");
    btn.className = "chip-btn retry-btn";
    btn.textContent = "↻ Retry";
    btn.title = "Run this card again";
    btn.onclick = async () => {
      if (batchRunning) {
        setStatus("Another run is in progress — wait for it to finish.", true);
        return;
      }
      batchRunning = true;
      generateBtn.disabled = true;
      btn.disabled = true;
      btn.textContent = "↻ Retrying…";
      try {
        await runCard(card, cards.indexOf(card), cards.length);
        btn.remove();
        card.done = true;
        card.failed = false;
        scheduleSaveCards();
        setStatus(`Retry succeeded — "${card.displayName || `card ${card.id}`}" ✓`);
      } catch (err) {
        setCardStatus(card.id, `✕ ${err.message}`, true);
        card.failed = true;
        scheduleSaveCards();
        setStatus(`Retry failed: ${err.message}`, true);
        btn.disabled = false;
        btn.textContent = "↻ Retry";
      } finally {
        batchRunning = false;
        generateBtn.disabled = false;
      }
    };
    actions.appendChild(btn);
  };

  const refreshPresets = async () => {
    presetSelect.innerHTML = "";
    PRESETS.forEach(([label, text]) => {
      const opt = document.createElement("option");
      opt.value = text;
      opt.textContent = `Preset: ${label}`;
      presetSelect.appendChild(opt);
    });
    templates.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.text;
      opt.textContent = `Template: ${t.name}`;
      presetSelect.appendChild(opt);
    });
  };

  const refreshChannels = async () => {
    channelSelect.innerHTML = "";
    try {
      const channels = await backendJson("/api/channels");
      if (!channels.length) {
        const opt = document.createElement("option");
        opt.textContent = "No channels — create one in Renderly";
        channelSelect.appendChild(opt);
        return;
      }
      const { channelId } = await chrome.storage.local.get("channelId");
      channels.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        if (String(c.id) === String(channelId)) opt.selected = true;
        channelSelect.appendChild(opt);
      });
      templates = await backendJson(`/api/channels/${channelSelect.value}/templates`);
      await refreshPresets();
    } catch (err) {
      const opt = document.createElement("option");
      opt.textContent = `Backend unreachable: ${err.message}`;
      channelSelect.appendChild(opt);
      setStatus(`Backend unreachable: ${err.message} — check the ⚙ settings`);
    }
  };

  channelSelect.onchange = async () => {
    await chrome.storage.local.set({ channelId: channelSelect.value });
    setStatus("Channel updated.");
    templates = await backendJson(`/api/channels/${channelSelect.value}/templates`);
    await refreshPresets();
  };

  presetBtn.onclick = () => {
    const text = presetSelect.value;
    masterTa.value = masterTa.value.trim()
      ? `${masterTa.value.trim()} ${text.trim()}`
      : text.trim();
    chrome.storage.local.set({ dockMaster: masterTa.value });
    setStatus("Added to master prompt.");
  };

  splitBtn.onclick = () => {
    const raw = pasteTa.value.trim();
    if (!raw) {
      setStatus("Paste at least one prompt line first.", true);
      return;
    }

    // A JSON array of batch entries creates one card per entry, with the
    // "file"-style field kept as the card's output name.
    if (raw.startsWith("[")) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const entries = arr
            .map((obj) => extractFromObject(obj))
            .filter(Boolean)
            .map((e) => ({ name: e.name, text: e.prompt || e.name || "" }));
          if (entries.length) {
            cards = entries.map((e) => ({
              id: ++cardSeq,
              text: e.text,
              name: e.name,
              refs: [],
            }));
            renderCards();
            scheduleSaveCards();
            pasteTa.value = "";
            setStatus(`${cards.length} card(s) created from JSON. Review them, then Send.`);
            return;
          }
        }
      } catch {
        /* not a JSON array — fall through to line splitting */
      }
    }

    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    cards = lines.map((line) => ({ id: ++cardSeq, text: line, refs: [] }));
    renderCards();
    scheduleSaveCards();
    pasteTa.value = "";
    setStatus(`${cards.length} card(s) created. Review them, then Send.`);
  };

  addCardBtn.onclick = () => addCard("");

  const runCard = async (card, index, total) => {
    const m = masterTa.value.trim();
    const { name: tokenName, prompt: cardPrompt } = splitPromptName(card.text.trim());
    const cardName = card.name || tokenName;
    const prompt = m && cardPrompt ? `${m} ${cardPrompt}` : cardPrompt || m;
    card.displayName = cardName;

    setCardStatus(card.id, "Preparing…");

    const versions = await getCardVersions();
    const labels = [];
    for (let v = 0; v < versions; v++) {
      const versionLabel = versions > 1 ? ` (${v + 1}/${versions})` : "";

      // Fill the prompt BEFORE pasting references — if Flow auto-generates
      // when an image lands in the box, it must already contain the prompt,
      // otherwise it generates the reference image on its own.
      setCardStatus(card.id, "Filling prompt…");
      const input = getPromptInput();
      if (!input) throw new Error("Flow's prompt box not found (run Diagnose)");
      // Flow accepts programmatic insertion while the window is backgrounded
      // (element.focus() + execCommand) — same as extension-v2. Only steal OS
      // focus as a last-resort fallback when insertion fails, or when the user
      // enables "Bring Flow window to front" in the settings.
      const { focusFlow } = await chrome.storage.local.get("focusFlow");
      if (focusFlow === true) {
        try {
          await sendToBackground({ type: "focusPage" });
        } catch {
          /* ignore */
        }
      }

      // Flow's Angular composer ignores the synthetic fill, so trusted input
      // goes first; the synthetic ladder below is the fallback for when the
      // debugger is unavailable (DevTools open, permission missing, ...).
      setCardStatus(card.id, "Filling prompt (trusted input)…");
      const trusted = await trustedFill(prompt);
      let filled = false;
      if (trusted.ok) {
        filled = await waitFor(
          () => promptFilled(getPromptInput() || input, prompt),
          4000,
          200
        );
      }
      if (!filled) {
        if (!trusted.ok) {
          setCardStatus(
            card.id,
            `Trusted input unavailable (${trusted.error}) — using synthetic fill…`
          );
        }
        const fillOnce = () => setPromptText(getPromptInput() || input, prompt);
        filled = fillOnce();
        if (!filled) {
          // One retry after a short pause — focus/DOM can settle late.
          await sleep(400);
          filled = fillOnce();
        }
        if (!filled) {
          // Editor state can settle asynchronously — re-check before giving up.
          await sleep(600);
          filled = promptFilled(getPromptInput() || input, prompt);
        }
        if (!filled && focusFlow !== true) {
          setCardStatus(card.id, "Retrying with window focus…");
          try {
            await sendToBackground({ type: "focusPage" });
          } catch {
            /* ignore */
          }
          await sleep(300);
          filled = fillOnce();
          if (!filled) {
            await sleep(400);
            filled = promptFilled(getPromptInput() || input, prompt);
          }
        }
        if (!filled) {
          const { pasteDialog } = await chrome.storage.local.get("pasteDialog");
          if (pasteDialog === true) {
            const copied = await copyTextToClipboard(prompt);
            await waitForContinue(
              `Card ${index + 1}: Flow blocked insertion. ` +
                (copied
                  ? "The prompt is on your clipboard — paste it (Ctrl+V) in Flow's box, "
                  : "Copy the prompt manually and paste it in Flow's box, ") +
                `then click Continue.`
            );
          } else {
            setCardStatus(card.id, "⚠ Auto-fill failed — Flow may reuse its previous prompt");
          }
        }
      }

      const before = captureImageSet();

      // References are attached MANUALLY in Flow's composer — Flow's picker
      // cannot be filled programmatically, and the ingredient the user adds
      // stays there and is used by every generation. The extension only
      // guides the timing: once per batch for global references, once for any
      // card-specific ones.
      const unattachedCardRefs = (card.refs || []).filter((r) => !r.attachedInFlow);
      const names = [
        ...(masterRefs.length > 0 && !refsAttachedThisBatch
          ? masterRefs.map((r) => r.label)
          : []),
        ...unattachedCardRefs.map((r) => r.label),
      ];
      if (names.length && v === 0) {
        setCardStatus(card.id, "Waiting for references to be attached in Flow…");
        const toast = showRefToast(
          `Attach in Flow now: press "Add ingredients to the prompt box" and ` +
            `pick: ${names.join(", ")}.\n` +
            `The ingredient stays in the composer and is used by every prompt.\n` +
            `Press Done when the reference(s) are attached.`
        );
        await toast.promise;
        toast.remove();
        if (masterRefs.length > 0) refsAttachedThisBatch = true;
        unattachedCardRefs.forEach((r) => (r.attachedInFlow = true));
      }

      await sleep(300);
      // The trusted fill already put the prompt into Flow's model; the click
      // must be trusted too, because Flow ignores synthetic ones.
      let gen = { clicked: false, how: null };
      if (trusted.ok) {
        setCardStatus(card.id, "Clicking Start generation (trusted input)…");
        const clicked = await trustedClick();
        // Release the debugger as soon as the click lands: while it stays
        // attached, Chrome drops the result download that follows.
        try {
          await sendToBackground({ type: "detachDebugger" });
        } catch {
          /* nothing attached */
        }
        gen = clicked.ok
          ? { clicked: true, how: "trusted input (clicked Start generation)" }
          : await triggerGenerate(input);
      } else {
        gen = await triggerGenerate(input);
      }
      if (!gen.clicked) {
        await waitForContinue(
          `Card ${index + 1}: no Generate button found — press Flow's Generate yourself, ` +
            `then click Continue. (Run Diagnose if this keeps happening.)`
        );
      }

      setCardStatus(card.id, `Triggered (${gen.how}) — waiting for Flow…${versionLabel}`);
      const img = await waitForNewImage(before, 240000, (secs) =>
        setCardStatus(card.id, `Waiting… ${secs}s left${versionLabel}`)
      );
      if (!img) throw new Error(`timed out waiting for the image (trigger: ${gen.how})`);
      lastFlowImage = img;

      setCardStatus(card.id, "Importing to Renderly…");
      const dataUrl = await imageToDataUrl(img);
      const genRecord = await importToRenderly(
        channelSelect.value,
        dataUrl,
        cardName,
        cardPrompt || "Generated in Google Flow"
      );
      let label = genRecord && genRecord.name ? genRecord.name : cardName || "flow-image";
      const fileBase = safeFileName(
        (genRecord && genRecord.name) || cardName || "flow-image"
      );
      runCostUsd += (genRecord && genRecord.cost_usd) || 0;
      let downloadUrl = genRecord && genRecord.image_url;

      if (autoUpscaleCheck.checked) {
        setCardStatus(card.id, `Upscaling (local GPU)…${versionLabel}`);
        try {
          const up = await backendJson(`/api/generations/${genRecord.id}/upscale`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tier: await getUpscaleTier() }),
          });
          label = `${up.name} (${up.image_size})`;
          runCostUsd += up.cost_usd || 0;
          downloadUrl = up.image_url || downloadUrl;
        } catch (err) {
          setCardStatus(card.id, `Upscale skipped (${err.message})`);
        }
      }

      if (autoUpscaleCheck.checked) {
        const saved = await saveToDisk(downloadUrl, `${fileBase}.png`);
        if (!saved.ok) setCardStatus(card.id, `⚠ Download failed: ${saved.error}`);
      }
      labels.push(label);
    }
    setCardStatus(card.id, `✓ ${labels.length} image(s) — done`);
    return labels.join(", ");
  };

  generateBtn.onclick = async () => {
    if (batchRunning) return;
    const usable = cards.filter((c) => c.text.trim() || masterTa.value.trim());
    if (!usable.length) {
      setStatus("No cards to generate — paste prompts and split first.", true);
      return;
    }
    if (!channelSelect.value) {
      setStatus("Pick a channel first.", true);
      return;
    }

    const retryAttempts = await getRetryAttempts();

    batchRunning = true;
    generateBtn.disabled = true;
    stopBtn.style.display = "block";
    runCostUsd = 0;
    let done = 0;
    let ok = 0;
    let skipped = 0;
    let inflight = 0;
    const total = usable.length;
    setProgress(0, total);
    // The bar advances as cards START (half-credit while in flight), so it
    // visibly moves during long generations — not only on completion.
    const updateProgress = () => {
      progressWrap.style.display = "block";
      const pct = Math.min(100, Math.round(((done + inflight * 0.5) / total) * 100));
      progressFill.style.width = `${pct}%`;
    };

    const runOne = async (card, i) => {
      if (card.done) {
        skipped++;
        done++;
        updateProgress();
        setCardStatus(card.id, "✓ already done — skipped");
        return;
      }
      inflight++;
      updateProgress();
      let lastErr = null;
      for (let attempt = 0; attempt <= retryAttempts; attempt++) {
        if (!batchRunning) break;
        try {
          await runCard(card, i, total);
          ok++;
          card.done = true;
          card.failed = false;
          removeRetryButton(card);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < retryAttempts && batchRunning) {
            setCardStatus(card.id, `↻ Auto-retry ${attempt + 1}/${retryAttempts}…`);
            await sleep(2000 * (attempt + 1));
          }
        }
      }
      if (lastErr && !card.done) {
        card.failed = true;
        setCardStatus(card.id, `✕ ${lastErr.message}`, true);
        addRetryButton(card);
      }
      done++;
      inflight = Math.max(0, inflight - 1);
      updateProgress();
      scheduleSaveCards();
    };

    try {
      // Every card runs through Flow's own UI — one prompt box, one at a time.
      for (let i = 0; i < usable.length; i++) {
        if (!batchRunning) {
          setStatus(`Batch stopped at card ${i + 1}/${usable.length}.`, true);
          break;
        }
        setStatus(`Card ${i + 1}/${usable.length}…`);
        await runOne(usable[i], i);
        await sleep(1500);
      }
      const stoppedNote = batchRunning ? "" : " (stopped)";
      setStatus(
        `Batch finished${stoppedNote} — ${ok + skipped}/${total} succeeded · $${runCostUsd.toFixed(2)} ✓`
      );
    } finally {
      batchRunning = false;
      generateBtn.disabled = false;
      stopBtn.style.display = "none";
      scheduleSaveCards();
      setTimeout(() => setProgress(null), 4000);
      // Drop the debugger session so Chrome's "being debugged" bar goes away.
      try {
        await sendToBackground({ type: "detachDebugger" });
      } catch {
        /* nothing attached */
      }
    }
  };

  stopBtn.onclick = () => {
    batchRunning = false;
    setStatus("Stopping after the current card…");
  };

  function diagnose() {
    const input = getPromptInput();
    const buttons = deepQueryAll('button, [role="button"]').filter(
      (b) => !isOurElement(b) && isVisible(b)
    );
    const genCandidates = buttons
      .filter((b) =>
        /generat|submit|send|create/i.test(
          (b.getAttribute("aria-label") || "") + " " + (b.textContent || "")
        )
      )
      .map((b) => `${describeEl(b)}${b.disabled ? " [disabled]" : ""}`)
      .slice(0, 4);
    return {
      promptBox: describeEl(input),
      generateCandidates: genCandidates,
      iframes: document.querySelectorAll("iframe").length,
      fileInputs: deepQueryAll('input[type="file"]').map((i) => ({
        accept: i.accept || "(none)",
        multiple: !!i.multiple,
        visible: isVisible(i),
      })),
      uploadCandidates: deepQueryAll('button, [role="button"]')
        .filter((b) => {
          if (isOurElement(b) || !isVisible(b)) return false;
          const label = (
            (b.getAttribute("aria-label") || "") +
            " " +
            (b.getAttribute("title") || "") +
            " " +
            (b.textContent || "")
          )
            .toLowerCase()
            .trim();
          return /upload|attach|ingredient|add (image|media|photo|file|reference)|media|photo/.test(
            label
          );
        })
        .map((b) => describeEl(b))
        .slice(0, 4),
    };
  }

  diagBtn.onclick = () => {
    const report = diagnose();
    console.log(
      "[Renderly diagnostics] — copy this JSON if you report an issue:\n" +
        JSON.stringify(report, null, 1)
    );
    const fileInputs = report.fileInputs.length
      ? report.fileInputs
          .map(
            (f) =>
              `${f.accept}${f.multiple ? "+multi" : ""}${f.visible ? "" : "+hidden"}`
          )
          .join(" | ")
      : "none";
    setStatus(
      `Prompt: ${report.promptBox} · gen: ${
        report.generateCandidates.length ? report.generateCandidates.join(" | ") : "none"
      } · iframes: ${report.iframes} · fileInputs: ${fileInputs} · uploadBtns: ${
        report.uploadCandidates.length ? report.uploadCandidates.join(" | ") : "none"
      }`,
      report.promptBox === "null"
    );
  };

  masterTa.addEventListener("input", () => {
    chrome.storage.local.set({ dockMaster: masterTa.value });
  });
  chrome.storage.local.get("dockMaster").then(({ dockMaster }) => {
    if (dockMaster) masterTa.value = dockMaster;
  });

  const backendSetting = buildSettingItem("Renderly backend URL", [
    backendInput,
    backendSave,
  ]);
  const channelSetting = buildSettingItem("Renderly channel", channelSelect);
  const presetSetting = buildSettingItem("Preset / template (adds to master)", [
    presetSelect,
    presetBtn,
  ]);

  const scaleSelect = document.createElement("select");
  scaleSelect.style.cssText = selectStyle;
  UPSCALE_TIERS.forEach((tier) => {
    const opt = document.createElement("option");
    opt.value = tier;
    opt.textContent = UPSCALE_TIER_LABELS[tier];
    scaleSelect.appendChild(opt);
  });
  scaleSelect.onchange = async () => {
    await chrome.storage.local.set({ upscaleTier: scaleSelect.value });
    autoUpscaleText.textContent = `Auto-upscale to ${UPSCALE_TIER_LABELS[scaleSelect.value]} + download each result (local GPU)`;
    setStatus(`Resolution set to ${UPSCALE_TIER_LABELS[scaleSelect.value]}.`);
  };
  getUpscaleTier().then((tier) => {
    scaleSelect.value = tier;
    autoUpscaleText.textContent = `Auto-upscale to ${UPSCALE_TIER_LABELS[tier]} + download each result (local GPU)`;
  });
  const versionsSelect = document.createElement("select");
  versionsSelect.style.cssText = selectStyle;
  ["1", "2", "3", "4"].forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = `${s} version${s === "1" ? "" : "s"} per card`;
    versionsSelect.appendChild(opt);
  });
  versionsSelect.onchange = async () => {
    await chrome.storage.local.set({ cardVersions: Number(versionsSelect.value) });
    setStatus(`Each card will now generate ${versionsSelect.value} image(s).`);
  };
  chrome.storage.local.get("cardVersions").then(({ cardVersions }) => {
    versionsSelect.value = String(Number(cardVersions) || 1);
  });
  const versionsSetting = buildSettingItem("Versions per card", versionsSelect);

  const scaleSetting = buildSettingItem("Resolution", scaleSelect);

  const retrySelect = document.createElement("select");
  retrySelect.style.cssText = selectStyle;
  [
    ["0", "0 retries (off)"],
    ["1", "1 retry"],
    ["2", "2 retries"],
    ["3", "3 retries"],
  ].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    retrySelect.appendChild(opt);
  });
  retrySelect.onchange = async () => {
    await chrome.storage.local.set({ retryAttempts: Number(retrySelect.value) });
    setStatus(
      retrySelect.value === "0"
        ? "Auto-retry off — failed cards go straight to the retry chip."
        : `Failed cards auto-retry up to ${retrySelect.value} time(s).`
    );
  };
  chrome.storage.local.get("retryAttempts").then(({ retryAttempts }) => {
    retrySelect.value = String(Number(retryAttempts) || 2);
  });
  const retrySetting = buildSettingItem("Auto-retry failed cards", retrySelect);

  const pasteCheckLabel = document.createElement("label");
  pasteCheckLabel.style.cssText =
    "display:flex;align-items:center;gap:6px;font-size:12px;color:#e8eaed;cursor:pointer;";
  const pasteCheck = document.createElement("input");
  pasteCheck.type = "checkbox";
  pasteCheck.onchange = async () => {
    await chrome.storage.local.set({ pasteDialog: pasteCheck.checked });
    setStatus(
      pasteCheck.checked
        ? "Paste dialog enabled for failed fills."
        : "Paste dialog disabled — failed fills are skipped with a warning."
    );
  };
  pasteCheckLabel.appendChild(pasteCheck);
  const pasteCheckText = document.createElement("span");
  pasteCheckText.textContent = "Show paste dialog when auto-fill fails";
  pasteCheckLabel.appendChild(pasteCheckText);
  chrome.storage.local.get("pasteDialog").then(({ pasteDialog }) => {
    pasteCheck.checked = pasteDialog === true;
  });
  const pasteSetting = buildSettingItem("Prompt fill fallback", pasteCheckLabel);

  const focusCheckLabel = document.createElement("label");
  focusCheckLabel.style.cssText =
    "display:flex;align-items:center;gap:6px;font-size:12px;color:#e8eaed;cursor:pointer;";
  const focusCheck = document.createElement("input");
  focusCheck.type = "checkbox";
  focusCheck.onchange = async () => {
    await chrome.storage.local.set({ focusFlow: focusCheck.checked });
    setStatus(
      focusCheck.checked
        ? "Flow window is brought to the front while running."
        : "Flow runs in the background — window focus is only used when auto-fill fails."
    );
  };
  focusCheckLabel.appendChild(focusCheck);
  const focusCheckText = document.createElement("span");
  focusCheckText.textContent = "Bring Flow window to front while running";
  focusCheckLabel.appendChild(focusCheckText);
  chrome.storage.local.get("focusFlow").then(({ focusFlow }) => {
    focusCheck.checked = focusFlow === true;
  });
  const focusSetting = buildSettingItem("Window focus", focusCheckLabel);

  const diagSetting = buildSettingItem("Diagnose page", diagBtn);

  settingsRow.appendChild(backendSetting.wrap);
  settingsRow.appendChild(channelSetting.wrap);
  settingsRow.appendChild(presetSetting.wrap);
  settingsRow.appendChild(versionsSetting.wrap);
  settingsRow.appendChild(scaleSetting.wrap);
  settingsRow.appendChild(retrySetting.wrap);
  settingsRow.appendChild(pasteSetting.wrap);
  settingsRow.appendChild(focusSetting.wrap);
  settingsRow.appendChild(diagSetting.wrap);

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "⚠ Reset Renderly";
  resetBtn.title =
    "Complete reset: removes all cards, the master prompt, global references and statuses. Backend data is not touched.";
  resetBtn.style.cssText =
    "background:#5c1a1a;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px;";
  resetBtn.onclick = async () => {
    cards.forEach((c) => (c.refs || []).forEach(revokeRef));
    masterRefs.forEach(revokeRef);
    cards = [];
    masterRefs = [];
    masterTa.value = "";
    batchRunning = false;
    generateBtn.disabled = false;
    stopBtn.style.display = "none";
    await chrome.storage.local.set({ dockMaster: "" });
    await chrome.storage.local.remove("savedCards");
    renderCards();
    renderMasterRefs();
    setSettingsOpen(false);
    setProgress(null);
    setStatus("Renderly reset — the dock is back to its initial state.");
  };
  settingsPanel.appendChild(resetBtn);

  const delHiddenBtn = document.createElement("button");
  delHiddenBtn.textContent = "🗑 Delete hidden images";
  delHiddenBtn.title =
    "Permanently deletes every image you hid in this channel (files + records). Cannot be undone.";
  delHiddenBtn.style.cssText =
    "background:#5c1a1a;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px;";
  delHiddenBtn.onclick = async () => {
    if (!channelSelect.value) {
      setStatus("Pick a channel first.", true);
      return;
    }
    delHiddenBtn.disabled = true;
    let deleted = 0;
    try {
      // Loop until the channel has no hidden images left — the listing is
      // capped at 200 per call, so large cleanups take several passes.
      for (;;) {
        const gens = await backendJson(
          `/api/generations?channel_id=${channelSelect.value}&hidden=only&limit=200`
        );
        if (!gens.length) break;
        for (const g of gens) {
          await backendJson(`/api/generations/${g.id}`, { method: "DELETE" });
          deleted++;
        }
      }
      setStatus(
        deleted > 0
          ? `Deleted ${deleted} hidden image(s) from this channel.`
          : "No hidden images in this channel."
      );
    } catch (err) {
      setStatus(`Delete failed: ${err.message}`, true);
    } finally {
      delHiddenBtn.disabled = false;
    }
  };
  settingsPanel.appendChild(delHiddenBtn);

  body.appendChild(masterLabel);
  body.appendChild(masterTa);
  body.appendChild(masterRefsRow);
  body.appendChild(masterRefStrip);
  body.appendChild(masterPicker);
  body.appendChild(pasteLabel);
  body.appendChild(pasteTa);
  body.appendChild(splitRow);
  body.appendChild(cardsLabel);
  body.appendChild(cardsBox);
  body.appendChild(autoUpscaleLabel);
  body.appendChild(generateBtn);
  body.appendChild(stopBtn);
  body.appendChild(status);

  dock.appendChild(header);
  dock.appendChild(progressWrap);
  dock.appendChild(body);
  document.body.appendChild(dock);

  renderCards();
  renderMasterRefs();
  refreshChannels();

  // Restore cards from the last session (text + done/failed state; refs are
  // session-only and need re-attaching).
  chrome.storage.local.get("savedCards").then(({ savedCards }) => {
    if (Array.isArray(savedCards) && savedCards.length && !cards.length) {
      cards = savedCards.map((c) => ({
        id: ++cardSeq,
        text: c.text || "",
        name: c.name || null,
        refs: [],
        done: !!c.done,
        failed: !!c.failed,
      }));
      renderCards();
      setStatus(
        `Restored ${cards.length} card(s) from your last session — press ⚡ to continue.`
      );
    }
  });
}

function startObserver() {
  if (observer) return;
  // The dock is shown only by explicit user action (toolbar icon); the
  // observer just keeps scanning for generated images on the page.
  observer = new MutationObserver(() => scanForImages());
  observer.observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "toggleDock") {
    const dock = document.getElementById(DOCK_ID);
    if (dock) {
      dock.remove();
      const panel = document.getElementById(`${DOCK_ID}-settings`);
      if (panel) panel.remove();
      sendResponse({ visible: false });
    } else {
      buildDock();
      sendResponse({ visible: !!document.getElementById(DOCK_ID) });
    }
  }
  return false;
});

startObserver();
scanForImages();
