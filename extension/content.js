const DOCK_ID = "rosterly-dock";
const DOCK_VERSION = "1.9.1";
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

function triggerGenerate(input) {
  if (input) {
    ["keydown", "keypress", "keyup"].forEach((type) => {
      input.dispatchEvent(
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
  }

  const buttons = deepQueryAll('button, [role="button"], input[type="submit"]').filter(
    (b) => !isOurElement(b) && isVisible(b)
  );
  const byAria = buttons.find((b) => {
    const label = (b.getAttribute("aria-label") || "").toLowerCase();
    return /generate|submit|send|create/.test(label);
  });
  if (byAria && !byAria.disabled) return { clicked: true, how: describeEl(byAria) };

  const byText = buttons.find(
    (b) => /generate|create|render|send|submit/i.test(b.textContent || "") && !b.disabled
  );
  if (byText) return { clicked: true, how: describeEl(byText) };

  const submit = buttons.find((b) => b.getAttribute("type") === "submit" && !b.disabled);
  if (submit) return { clicked: true, how: describeEl(submit) };

  return { clicked: false, how: null };
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
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/* ================= Rosterly backend ================= */

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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
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

async function importToRosterly(channelId, dataUrl, name, prompt) {
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

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ================= Rosterly engine helpers ================= */

// A leading "NAME.png" / "NAME.jpg" token in a prompt names the output.
const NAME_TOKEN_RE = /^\s*([\w\-]+\.(?:png|jpe?g))\s+(.*)$/i;

function splitPromptName(text) {
  const match = text.trim().match(NAME_TOKEN_RE);
  if (!match || !match[2].trim()) return { name: null, prompt: text.trim() };
  return { name: match[1], prompt: match[2].trim() };
}

// Mirrors the backend's _sanitize_filename: safe for use as a download name.
function safeFileName(name) {
  let cleaned = String(name || "")
    .replace(/[^\w\-.]/g, "_")
    .replace(/^[._ ]+|[._ ]+$/g, "");
  if (/\.(png|jpe?g|webp)$/i.test(cleaned)) cleaned = cleaned.replace(/\.[^.]+$/, "");
  return cleaned || "image";
}

// Persisted upscale factor for the auto-upscale step (2× default, 3×/4× optional).
async function getUpscaleScale() {
  try {
    const { upscaleScale } = await chrome.storage.local.get("upscaleScale");
    const n = Number(upscaleScale);
    if (n >= 2 && n <= 4) return n;
  } catch {
    /* fall through to default */
  }
  return 2;
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

// Aspect ratio for engine-generated cards (Flow-path cards use Flow's own setting).
async function getAspectRatio() {
  try {
    const { aspectRatio } = await chrome.storage.local.get("aspectRatio");
    if (["16:9", "4:3", "1:1", "3:4", "9:16"].includes(aspectRatio)) return aspectRatio;
  } catch {
    /* fall through to default */
  }
  return "16:9";
}

// Engine cards run 4-at-a-time when enabled (Flow-path cards always run solo).
async function getParallelGen() {
  try {
    const { parallelGen } = await chrome.storage.local.get("parallelGen");
    return parallelGen !== false;
  } catch {
    /* fall through to default */
  }
  return true;
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

function urlToDataUrl(url) {
  return fetchImageAsBlob(url).then(fileToDataUrl);
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

// Generate via the Rosterly engine directly (used for cards with refs).
// Reference images are uploaded to the channel and passed as asset_ids,
// so they are guaranteed to be used — no clipboard, no manual pasting.
async function uploadRefAsset(channelId, ref, index) {
  let dataUrl;
  if (ref.localFile) {
    dataUrl = await fileToDataUrl(ref.localFile);
  } else if (ref.url) {
    dataUrl = await urlToDataUrl(ref.url);
  } else {
    throw new Error(`Reference ${index + 1} has no image data`);
  }
  const res = await sendToBackground({
    type: "uploadAsset",
    channelId,
    dataUrl,
    filename: `${safeFileName(ref.label || `ref-${index + 1}`)}.png`,
  });
  const asset = res.data;
  if (!asset || !asset.id) {
    throw new Error(`Uploading "${ref.label || "reference"}" failed`);
  }
  return asset.id;
}

/* ================= Dock UI ================= */

function buildDock() {
  // Remove any orphaned dock/panel/style left by a previous content script
  // (e.g. after an extension reload without a tab reload), then build fresh.
  const existingDock = document.getElementById(DOCK_ID);
  if (existingDock) existingDock.remove();
  const existingPanel = document.getElementById(`${DOCK_ID}-settings`);
  if (existingPanel) existingPanel.remove();
  const existingStyle = document.getElementById(`${DOCK_ID}-style`);
  if (existingStyle) existingStyle.remove();

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
  title.textContent = `Rosterly for Flow v${DOCK_VERSION}`;
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
  panelTitle.textContent = "Rosterly settings";
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

  const masterRefsRow = document.createElement("div");
  masterRefsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";

  const masterRefBtn = document.createElement("button");
  masterRefBtn.className = "chip-btn";
  masterRefBtn.textContent = "＋ Global images";
  masterRefBtn.title =
    "Reference images used by EVERY card — all cards are then generated by the Rosterly engine";
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
        setStatus("Global references set — every card will generate via the Rosterly engine.");
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
  autoUpscaleText.textContent = "Auto-upscale 2× + download each result (local GPU)";
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
          done: !!c.done,
          failed: !!c.failed,
        })),
      });
    }, 500);
  };

  collapseBtn.onclick = () => {
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "flex" : "none";
    collapseBtn.textContent = hidden ? "–" : "+";
  };

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
      refBtn.title = "Attach reference images from your PC — used automatically by the engine";
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
        opt.textContent = "No channels — create one in Rosterly";
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
      // Surface the gear and open the backend section so the user can fix it.
      backendInput.value = await getBackendBase();
      setSettingsOpen(true);
      backendSetting.open();
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
    const lines = pasteTa.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) {
      setStatus("Paste at least one prompt line first.", true);
      return;
    }
    cards = lines.map((line) => ({ id: ++cardSeq, text: line, refs: [] }));
    renderCards();
    scheduleSaveCards();
    pasteTa.value = "";
    setStatus(`${cards.length} card(s) created. Review them, then Send.`);
  };

  addCardBtn.onclick = () => addCard("");

  // Upload a ref once per channel and cache the asset id on the ref object —
  // global refs are uploaded a single time no matter how many cards run.
  const ensureUploadedId = async (channelId, ref, index) => {
    if (ref._assetId && ref._assetChannel === channelId) return ref._assetId;
    const id = await uploadRefAsset(channelId, ref, index);
    ref._assetId = id;
    ref._assetChannel = channelId;
    return id;
  };

  // Generate a card through the Rosterly engine: upload global + card refs as
  // channel assets, run a single generation, then upscale/download like the Flow path.
  const runEngineCard = async (card, index, total, prompt, cardName, cardPrompt) => {
    const uploadTotal = masterRefs.length + card.refs.length;
    const assetIds = [];
    let uploadIdx = 0;
    for (const ref of masterRefs) {
      setCardStatus(card.id, `Uploading global ref ${++uploadIdx}/${uploadTotal}…`);
      assetIds.push(await ensureUploadedId(channelSelect.value, ref, uploadIdx - 1));
    }
    for (const ref of card.refs) {
      setCardStatus(card.id, `Uploading ref ${++uploadIdx}/${uploadTotal}…`);
      assetIds.push(await ensureUploadedId(channelSelect.value, ref, uploadIdx - 1));
    }
    const uniqueAssetIds = [...new Set(assetIds)];

    const versions = await getCardVersions();
    const ratio = await getAspectRatio();
    setCardStatus(
      card.id,
      versions > 1
        ? `Generating ${versions} versions via Rosterly engine…`
        : "Generating via Rosterly engine…"
    );
    // Versions are independent — fire them all at once.
    const gens = await Promise.all(
      Array.from({ length: versions }, () =>
        backendJson(`/api/channels/${channelSelect.value}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            asset_ids: uniqueAssetIds,
            aspect_ratio: ratio,
            ...(cardName ? { name: cardName } : {}),
          }),
        })
      )
    );
    for (const gen of gens) {
      if (gen.status !== "done" || !gen.image_url) {
        throw new Error(gen.error || "Generation failed in Rosterly");
      }
      runCostUsd += gen.cost_usd || 0;
    }

    const labels = [];
    for (let v = 0; v < gens.length; v++) {
      const gen = gens[v];
      let label = gen.name || cardName || "image";
      const suffix = gens.length > 1 ? `-v${v + 1}` : "";
      if (autoUpscaleCheck.checked) {
        setCardStatus(
          card.id,
          gens.length > 1 ? `Upscaling ${v + 1}/${gens.length}…` : "Upscaling (local GPU)…"
        );
        try {
          const up = await backendJson(`/api/generations/${gen.id}/upscale`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scale: await getUpscaleScale() }),
          });
          label = `${up.name} (${up.image_size})`;
          runCostUsd += up.cost_usd || 0;
          const base = await getBackendBase();
          const res = await fetch(new URL(up.image_url, base).href);
          downloadBlob(await res.blob(), `${safeFileName(label)}${suffix}.png`);
          labels.push(label);
          continue;
        } catch (err) {
          setCardStatus(card.id, `Upscale skipped (${err.message})`);
        }
      }

      try {
        const base = await getBackendBase();
        const res = await fetch(new URL(gen.image_url, base).href);
        downloadBlob(await res.blob(), `${safeFileName(label)}${suffix}.png`);
      } catch {
        /* the image stays in Rosterly's gallery */
      }
      labels.push(label);
    }
    setCardStatus(card.id, `✓ ${labels.length} image(s) — done`);
    return labels.join(", ");
  };

  const runCard = async (card, index, total) => {
    const m = masterTa.value.trim();
    const { name: cardName, prompt: cardPrompt } = splitPromptName(card.text.trim());
    const prompt = m && cardPrompt ? `${m} ${cardPrompt}` : cardPrompt || m;
    card.displayName = cardName;

    // Cards with attached references — their own or global ones — bypass
    // Flow's UI entirely: refs are uploaded to Rosterly and passed to the
    // engine as asset_ids, so "every image added is automatically referenced".
    if (card.refs.length > 0 || masterRefs.length > 0) {
      return runEngineCard(card, index, total, prompt, cardName, cardPrompt);
    }

    setCardStatus(card.id, "Preparing…");

    const versions = await getCardVersions();
    const labels = [];
    for (let v = 0; v < versions; v++) {
      const suffix = versions > 1 ? `-v${v + 1}` : "";
      const versionLabel = versions > 1 ? ` (${v + 1}/${versions})` : "";

      setCardStatus(card.id, "Filling prompt…");
      const input = getPromptInput();
      if (!input) throw new Error("Flow's prompt box not found (run Diagnose)");
      // Flow's box rejects programmatic insertion while the window is unfocused.
      try {
        await sendToBackground({ type: "focusPage" });
      } catch {
        /* ignore */
      }
      let filled = setPromptText(input, prompt);
      if (!filled) {
        // One retry after a short pause — focus/DOM can settle late.
        await sleep(400);
        filled = setPromptText(getPromptInput() || input, prompt);
      }
      if (!filled) {
        // Editor state can settle asynchronously — re-check before giving up.
        await sleep(600);
        filled = promptFilled(getPromptInput() || input, prompt);
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

      const before = captureImageSet();
      await sleep(500);
      const gen = triggerGenerate(input);
      if (!gen.clicked) {
        await waitForContinue(
          `Card ${index + 1}: no Generate button found — press Flow's Generate yourself, ` +
            `then click Continue.`
        );
      }

      setCardStatus(card.id, `Waiting for Flow…${versionLabel}`);
      const img = await waitForNewImage(before, 240000, (secs) =>
        setCardStatus(card.id, `Waiting… ${secs}s left${versionLabel}`)
      );
      if (!img) throw new Error("timed out waiting for the image");
      lastFlowImage = img;

      setCardStatus(card.id, "Importing to Rosterly…");
      const dataUrl = await imageToDataUrl(img);
      const genRecord = await importToRosterly(
        channelSelect.value,
        dataUrl,
        cardName,
        cardPrompt || "Generated in Google Flow"
      );
      let label = genRecord && genRecord.name ? genRecord.name : cardName || "flow-image";
      runCostUsd += (genRecord && genRecord.cost_usd) || 0;

      if (autoUpscaleCheck.checked) {
        setCardStatus(card.id, `Upscaling (local GPU)…${versionLabel}`);
        try {
          const up = await backendJson(`/api/generations/${genRecord.id}/upscale`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scale: await getUpscaleScale() }),
          });
          label = `${up.name} (${up.image_size})`;
          runCostUsd += up.cost_usd || 0;
          const base = await getBackendBase();
          const res = await fetch(new URL(up.image_url, base).href);
          downloadBlob(await res.blob(), `${safeFileName(label)}${suffix}.png`);
          labels.push(label);
          continue;
        } catch (err) {
          setCardStatus(card.id, `Upscale skipped (${err.message})`);
        }
      }

      try {
        const blob = await fetchImageAsBlob(img.currentSrc || img.src);
        downloadBlob(blob, `${safeFileName(label)}${suffix}.png`);
      } catch {
        /* gallery copy still exists */
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

    const parallel = await getParallelGen();
    const retryAttempts = await getRetryAttempts();
    const isEngine = (c) => c.refs.length > 0 || masterRefs.length > 0;

    // Aspect ratio only reaches the engine — warn when Flow-path cards exist.
    const { aspectRatio: activeRatio } = await chrome.storage.local.get("aspectRatio");
    const flowCount = usable.filter((c) => !isEngine(c)).length;
    if (activeRatio && activeRatio !== "16:9" && flowCount > 0) {
      setStatus(
        `Note: ${flowCount} Flow-path card(s) will use Flow's own aspect ratio, not ${activeRatio}.`
      );
    }

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
      if (parallel) {
        // Flow-path cards share the one Flow prompt box — always sequential.
        const flowCards = usable.filter((c) => !isEngine(c));
        let seq = 0;
        for (const card of flowCards) {
          if (!batchRunning) break;
          setStatus(`Card ${++seq}/${flowCards.length} (Flow)…`);
          await runOne(card, usable.indexOf(card));
          await sleep(1500);
        }
        // Engine cards hit the backend API — run up to 4 concurrently.
        const engineCards = usable.filter(isEngine);
        let next = 0;
        const workers = Array.from(
          { length: Math.min(4, engineCards.length) },
          async () => {
            while (batchRunning && next < engineCards.length) {
              const card = engineCards[next++];
              setStatus(
                `Engine cards: ${Math.min(next, engineCards.length)}/${engineCards.length} dispatched…`
              );
              await runOne(card, usable.indexOf(card));
            }
          }
        );
        await Promise.all(workers);
      } else {
        for (let i = 0; i < usable.length; i++) {
          if (!batchRunning) {
            setStatus(`Batch stopped at card ${i + 1}/${usable.length}.`, true);
            break;
          }
          setStatus(`Card ${i + 1}/${usable.length}…`);
          await runOne(usable[i], i);
          await sleep(1500);
        }
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
      .filter(
        (b) =>
          /generate|submit|send|create/i.test(
            (b.getAttribute("aria-label") || "") + (b.textContent || "")
          ) && !b.disabled
      )
      .map((b) => describeEl(b))
      .slice(0, 4);
    return {
      promptBox: describeEl(input),
      generateCandidates: genCandidates,
      iframes: document.querySelectorAll("iframe").length,
    };
  }

  diagBtn.onclick = () => {
    const report = diagnose();
    console.log("[Rosterly diagnostics]", report);
    setStatus(
      `Prompt box: ${report.promptBox} · generate: ${
        report.generateCandidates.length ? report.generateCandidates.join(" | ") : "none"
      } · iframes: ${report.iframes}`,
      report.promptBox === "null"
    );
  };

  masterTa.addEventListener("input", () => {
    chrome.storage.local.set({ dockMaster: masterTa.value });
  });
  chrome.storage.local.get("dockMaster").then(({ dockMaster }) => {
    if (dockMaster) masterTa.value = dockMaster;
  });

  const backendSetting = buildSettingItem("Rosterly backend URL", [
    backendInput,
    backendSave,
  ]);
  const channelSetting = buildSettingItem("Rosterly channel", channelSelect);
  const presetSetting = buildSettingItem("Preset / template (adds to master)", [
    presetSelect,
    presetBtn,
  ]);

  const scaleSelect = document.createElement("select");
  scaleSelect.style.cssText = selectStyle;
  ["2", "3", "4"].forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = `${s}×`;
    scaleSelect.appendChild(opt);
  });
  scaleSelect.onchange = async () => {
    await chrome.storage.local.set({ upscaleScale: Number(scaleSelect.value) });
    autoUpscaleText.textContent = `Auto-upscale ${scaleSelect.value}× + download each result (local GPU)`;
    setStatus(`Upscale target set to ${scaleSelect.value}×.`);
  };
  chrome.storage.local.get("upscaleScale").then(({ upscaleScale }) => {
    const s = Number(upscaleScale) || 2;
    scaleSelect.value = String(s);
    autoUpscaleText.textContent = `Auto-upscale ${s}× + download each result (local GPU)`;
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

  const ratioSelect = document.createElement("select");
  ratioSelect.style.cssText = selectStyle;
  ["16:9", "4:3", "1:1", "3:4", "9:16"].forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    ratioSelect.appendChild(opt);
  });
  ratioSelect.onchange = async () => {
    await chrome.storage.local.set({ aspectRatio: ratioSelect.value });
    setStatus(`Aspect ratio set to ${ratioSelect.value} (engine-generated cards).`);
  };
  chrome.storage.local.get("aspectRatio").then(({ aspectRatio }) => {
    if (aspectRatio) ratioSelect.value = aspectRatio;
  });
  const ratioSetting = buildSettingItem("Aspect ratio", ratioSelect);

  const scaleSetting = buildSettingItem("Auto-upscale target", scaleSelect);

  const parallelCheckLabel = document.createElement("label");
  parallelCheckLabel.style.cssText =
    "display:flex;align-items:center;gap:6px;font-size:12px;color:#e8eaed;cursor:pointer;";
  const parallelCheck = document.createElement("input");
  parallelCheck.type = "checkbox";
  parallelCheck.onchange = async () => {
    await chrome.storage.local.set({ parallelGen: parallelCheck.checked });
    setStatus(
      parallelCheck.checked
        ? "Parallel generation on — engine cards run 4 at a time."
        : "Parallel generation off — cards run one at a time."
    );
  };
  parallelCheckLabel.appendChild(parallelCheck);
  const parallelCheckText = document.createElement("span");
  parallelCheckText.textContent = "Generate engine cards 4 at a time (parallel)";
  parallelCheckLabel.appendChild(parallelCheckText);
  chrome.storage.local.get("parallelGen").then(({ parallelGen }) => {
    parallelCheck.checked = parallelGen !== false;
  });
  const parallelSetting = buildSettingItem("Parallel generation", parallelCheckLabel);

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

  const diagSetting = buildSettingItem("Diagnose page", diagBtn);

  settingsRow.appendChild(backendSetting.wrap);
  settingsRow.appendChild(channelSetting.wrap);
  settingsRow.appendChild(presetSetting.wrap);
  settingsRow.appendChild(versionsSetting.wrap);
  settingsRow.appendChild(ratioSetting.wrap);
  settingsRow.appendChild(scaleSetting.wrap);
  settingsRow.appendChild(parallelSetting.wrap);
  settingsRow.appendChild(retrySetting.wrap);
  settingsRow.appendChild(pasteSetting.wrap);
  settingsRow.appendChild(diagSetting.wrap);

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "⚠ Reset Rosterly";
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
    setStatus("Rosterly reset — the dock is back to its initial state.");
  };
  settingsPanel.appendChild(resetBtn);

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
