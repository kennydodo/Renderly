const DOCK_ID = "rosterly-dock";
const DOCK_VERSION = "1.8.0";
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
let debounceTimer = null;
let templates = [];
let cards = []; // {id, text, refs: [{label, localFile}]}
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
  return !!el.closest && !!el.closest(`#${DOCK_ID}`);
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
    if (valueSetter) valueSetter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    return input.value === text;
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
  if (!ok) input.textContent = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  return (input.textContent || "").includes(text.slice(0, 40));
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

function urlToDataUrl(url) {
  return fetchImageAsBlob(url).then(fileToDataUrl);
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
  if (document.getElementById(DOCK_ID)) return;

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

  const collapseBtn = document.createElement("button");
  collapseBtn.textContent = "–";
  collapseBtn.title = "Collapse / expand";
  collapseBtn.style.cssText =
    "background:#303134;color:#e8eaed;border:1px solid #5f6368;border-radius:6px;width:24px;height:24px;cursor:pointer;line-height:1;";

  header.appendChild(title);
  header.appendChild(collapseBtn);

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

  const channelLabel = document.createElement("p");
  channelLabel.textContent = "Rosterly channel";
  channelLabel.style.cssText = labelStyle;

  const channelSelect = document.createElement("select");
  channelSelect.style.cssText = selectStyle;

  const masterLabel = document.createElement("p");
  masterLabel.textContent = "Master prompt (prepended to every card)";
  masterLabel.style.cssText = labelStyle;

  const masterTa = document.createElement("textarea");
  masterTa.rows = 2;
  masterTa.placeholder = "e.g. Warm 2D editorial illustration, Japanese rural setting —";
  masterTa.style.cssText = textareaStyle;

  const presetLabel = document.createElement("p");
  presetLabel.textContent = "Preset / template (adds to master)";
  presetLabel.style.cssText = labelStyle;

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
  splitRow.style.cssText = "display:flex;gap:6px;";

  const splitBtn = document.createElement("button");
  splitBtn.textContent = "✂ Split into cards";
  splitBtn.style.cssText = buttonStyle;

  const addCardBtn = document.createElement("button");
  addCardBtn.textContent = "+ Empty card";
  addCardBtn.style.cssText = smallBtnStyle;

  splitRow.appendChild(splitBtn);
  splitRow.appendChild(addCardBtn);

  const cardsLabel = document.createElement("p");
  cardsLabel.textContent = "Cards (each = one Flow generation)";
  cardsLabel.style.cssText = labelStyle;

  const cardsBox = document.createElement("div");
  cardsBox.style.cssText = "display:flex;flex-direction:column;gap:6px;";

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

  const importBtn = document.createElement("button");
  importBtn.textContent = "⬇ Import last image → Rosterly";
  importBtn.style.cssText = buttonStyle;

  const diagBtn = document.createElement("button");
  diagBtn.textContent = "🔍 Diagnose page";
  diagBtn.style.cssText = smallBtnStyle;

  const status = document.createElement("span");
  status.style.cssText = "font-size:12px;color:#9aa0a6;min-height:14px;white-space:normal;";

  const setStatus = (text, isError) => {
    status.textContent = text;
    status.style.color = isError ? "#f28b82" : "#9aa0a6";
  };

  collapseBtn.onclick = () => {
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "flex" : "none";
    collapseBtn.textContent = hidden ? "–" : "+";
  };

  /* ---- cards state & rendering ---- */

  const addCard = (text) => {
    cards.push({ id: ++cardSeq, text: text || "", refs: [] });
    renderCards();
  };

  const removeCard = (id) => {
    cards = cards.filter((c) => c.id !== id);
    renderCards();
  };

  const renderCards = () => {
    cardsBox.innerHTML = "";
    if (!cards.length) {
      const span = document.createElement("span");
      span.textContent = "No cards yet — paste prompts above and split, or add an empty card.";
      span.style.cssText = "font-size:11px;color:#9aa0a6;";
      cardsBox.appendChild(span);
      return;
    }
    cards.forEach((card, index) => {
      if (!Array.isArray(card.refs)) card.refs = [];
      const cardEl = document.createElement("div");
      cardEl.style.cssText =
        "border:1px solid #444746;border-radius:8px;padding:6px;background:#26282b;display:flex;flex-direction:column;gap:4px;";

      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;";

      const num = document.createElement("span");
      num.textContent = `${index + 1}`;
      num.style.cssText = "color:#9aa0a6;font-size:11px;flex:none;width:14px;";

      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.value = card.text;
      ta.placeholder = `Card ${index + 1} prompt`;
      ta.style.cssText = textareaStyle;
      ta.oninput = () => (card.text = ta.value);

      const refBtn = document.createElement("button");
      refBtn.textContent = `+ Add images${card.refs.length ? ` (${card.refs.length})` : ""}`;
      refBtn.title = "Attach reference images from your PC — used automatically by the engine";
      refBtn.style.cssText = smallBtnStyle;
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
      flowBtn.textContent = "🖼 From Flow";
      flowBtn.title =
        "Attach images currently visible in Flow (its gallery/results) as references";
      flowBtn.style.cssText = smallBtnStyle;
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

      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove card";
      del.style.cssText =
        "background:transparent;border:1px solid #f28b82;color:#f28b82;border-radius:6px;width:24px;cursor:pointer;font-size:11px;flex:none;";
      del.onclick = () => removeCard(card.id);

      row.appendChild(num);
      row.appendChild(ta);
      row.appendChild(refBtn);
      row.appendChild(flowBtn);
      row.appendChild(del);
      cardEl.appendChild(row);

      if (card.pickerOpen && card.flowPicker) {
        const picker = document.createElement("div");
        picker.style.cssText =
          "display:flex;flex-wrap:wrap;gap:4px;max-height:110px;overflow-y:auto;border:1px dashed #5f6368;border-radius:6px;padding:4px;";
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
          span.textContent = "No Flow images visible — generate something first.";
          span.style.cssText = "font-size:11px;color:#9aa0a6;";
          picker.appendChild(span);
        }

        flowImgs.forEach((imgInfo) => {
          const selected = card.refs.some((r) => r.url === imgInfo.src);
          const th = document.createElement("img");
          th.src = imgInfo.src;
          th.title = `Flow image — click to ${selected ? "remove" : "attach"} as reference`;
          th.style.cssText = `width:44px;height:44px;object-fit:cover;border-radius:4px;cursor:pointer;border:2px solid ${
            selected ? "#34a853" : "transparent"
          };`;
          th.onclick = () => {
            if (selected) {
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
        refStrip.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
        card.refs.forEach((ref, refIdx) => {
          const refItem = document.createElement("span");
          refItem.style.cssText =
            "position:relative;display:inline-flex;align-items:center;gap:3px;background:#303134;border:1px solid #5f6368;border-radius:6px;padding:2px 4px;font-size:10px;color:#e8eaed;max-width:130px;";
          const nameSpan = document.createElement("span");
          nameSpan.textContent = ref.label;
          nameSpan.style.cssText =
            "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px;";
          const rm = document.createElement("button");
          rm.textContent = "✕";
          rm.title = "Remove this image";
          rm.style.cssText =
            "background:none;border:none;color:#9aa0a6;cursor:pointer;font-size:10px;padding:0 2px;";
          rm.onclick = () => {
            card.refs.splice(refIdx, 1);
            renderCards();
          };
          refItem.appendChild(nameSpan);
          refItem.appendChild(rm);
          refStrip.appendChild(refItem);
        });
        cardEl.appendChild(refStrip);
      }

      const cardStatus = document.createElement("span");
      cardStatus.className = "card-status";
      cardStatus.dataset.cardId = card.id;
      cardStatus.style.cssText = "font-size:11px;color:#9aa0a6;min-height:12px;";
      cardEl.appendChild(cardStatus);

      cardsBox.appendChild(cardEl);
    });
  };

  const setCardStatus = (id, text, isError) => {
    const el = cardsBox.querySelector(`.card-status[data-card-id="${id}"]`);
    if (el) {
      el.textContent = text;
      el.style.color = isError ? "#f28b82" : "#9aa0a6";
    }
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
    pasteTa.value = "";
    setStatus(`${cards.length} card(s) created. Review them, then Send.`);
  };

  addCardBtn.onclick = () => addCard("");

  // Generate a card through the Rosterly engine: upload refs as channel
  // assets, run a single generation, then upscale/download like the Flow path.
  const runEngineCard = async (card, index, total, prompt, cardName, cardPrompt) => {
    setCardStatus(card.id, "Uploading references…");
    const assetIds = [];
    for (let i = 0; i < card.refs.length; i++) {
      setCardStatus(card.id, `Uploading ref ${i + 1}/${card.refs.length}…`);
      assetIds.push(await uploadRefAsset(channelSelect.value, card.refs[i], i));
    }

    setCardStatus(card.id, "Generating via Rosterly engine…");
    const body = { prompt, asset_ids: assetIds };
    if (cardName) body.name = cardName;
    const gen = await backendJson(`/api/channels/${channelSelect.value}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (gen.status !== "done" || !gen.image_url) {
      throw new Error(gen.error || "Generation failed in Rosterly");
    }
    let label = gen.name || cardName || "image";

    if (autoUpscaleCheck.checked) {
      setCardStatus(card.id, "Upscaling (local GPU)…");
      try {
        const up = await backendJson(`/api/generations/${gen.id}/upscale`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scale: 2 }),
        });
        label = `${up.name} (${up.image_size})`;
        const base = await getBackendBase();
        const res = await fetch(new URL(up.image_url, base).href);
        downloadBlob(await res.blob(), `${safeFileName(label)}.png`);
        setCardStatus(card.id, `✓ ${label} — downloaded`);
        return label;
      } catch (err) {
        setCardStatus(card.id, `Upscale skipped (${err.message})`);
      }
    }

    try {
      const base = await getBackendBase();
      const res = await fetch(new URL(gen.image_url, base).href);
      downloadBlob(await res.blob(), `${safeFileName(label)}.png`);
    } catch {
      /* the image stays in Rosterly's gallery */
    }
    setCardStatus(card.id, `✓ ${label} — done`);
    return label;
  };

  const runCard = async (card, index, total) => {
    const m = masterTa.value.trim();
    const { name: cardName, prompt: cardPrompt } = splitPromptName(card.text.trim());
    const prompt = m && cardPrompt ? `${m} ${cardPrompt}` : cardPrompt || m;
    card.displayName = cardName;

    // Cards with attached reference images bypass Flow's UI entirely:
    // refs are uploaded to Rosterly and passed to the engine as asset_ids,
    // so "every image added is automatically referenced" — no pasting.
    if (card.refs.length > 0) {
      return runEngineCard(card, index, total, prompt, cardName, cardPrompt);
    }

    setCardStatus(card.id, "Preparing…");

    setCardStatus(card.id, "Filling prompt…");
    const input = getPromptInput();
    if (!input) throw new Error("Flow's prompt box not found (run Diagnose)");
    const filled = setPromptText(input, prompt);
    if (!filled) {
      const copied = await copyTextToClipboard(prompt);
      await waitForContinue(
        `Card ${index + 1}: Flow blocked insertion. ` +
          (copied
            ? "The prompt is on your clipboard — paste it (Ctrl+V) in Flow's box, "
            : "Copy the prompt manually and paste it in Flow's box, ") +
          `then click Continue.`
      );
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

    setCardStatus(card.id, "Waiting for Flow…");
    const img = await waitForNewImage(before, 240000, (secs) =>
      setCardStatus(card.id, `Waiting… ${secs}s left`)
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

    if (autoUpscaleCheck.checked) {
      setCardStatus(card.id, "Upscaling (local GPU)…");
      try {
        const up = await backendJson(`/api/generations/${genRecord.id}/upscale`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scale: 2 }),
        });
        label = `${up.name} (${up.image_size})`;
        const base = await getBackendBase();
        const res = await fetch(new URL(up.image_url, base).href);
        downloadBlob(await res.blob(), `${safeFileName(label)}.png`);
        setCardStatus(card.id, `✓ ${label} — downloaded`);
        return label;
      } catch (err) {
        setCardStatus(card.id, `Upscale skipped (${err.message})`);
      }
    }

    try {
      const blob = await fetchImageAsBlob(img.currentSrc || img.src);
      downloadBlob(blob, `${safeFileName(label)}.png`);
    } catch {
      /* gallery copy still exists */
    }
    setCardStatus(card.id, `✓ ${label} — done`);
    return label;
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

    batchRunning = true;
    generateBtn.disabled = true;
    importBtn.disabled = true;
    stopBtn.style.display = "block";
    let done = 0;
    try {
      for (let i = 0; i < usable.length; i++) {
        if (!batchRunning) {
          setStatus(`Batch stopped at card ${i + 1}/${usable.length}.`, true);
          break;
        }
        setStatus(`Card ${i + 1}/${usable.length}…`);
        try {
          await runCard(usable[i], i, usable.length);
          done++;
        } catch (err) {
          setCardStatus(usable[i].id, `✕ ${err.message}`, true);
        }
        await sleep(1500);
      }
      setStatus(`Batch finished — ${done}/${usable.length} card(s) succeeded. ✓`);
    } finally {
      batchRunning = false;
      generateBtn.disabled = false;
      importBtn.disabled = false;
      stopBtn.style.display = "none";
    }
  };

  stopBtn.onclick = () => {
    batchRunning = false;
    setStatus("Stopping after the current card…");
  };

  importBtn.onclick = async () => {
    if (!channelSelect.value) {
      setStatus("Pick a channel first.", true);
      return;
    }
    importBtn.disabled = true;
    setStatus("Importing…");
    scanForImages();
    if (!lastFlowImage) {
      setStatus("No generated image found yet — generate one in Flow first.", true);
      importBtn.disabled = false;
      return;
    }
    try {
      const dataUrl = await imageToDataUrl(lastFlowImage);
      const genRecord = await importToRosterly(channelSelect.value, dataUrl);
      const label = genRecord && genRecord.name ? genRecord.name : "image";
      setStatus(`Imported "${label}" ✓`);
    } catch (err) {
      setStatus(`Import failed: ${err.message}`, true);
    } finally {
      importBtn.disabled = false;
    }
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

  body.appendChild(channelLabel);
  body.appendChild(channelSelect);
  body.appendChild(masterLabel);
  body.appendChild(masterTa);
  body.appendChild(presetLabel);
  body.appendChild(presetSelect);
  body.appendChild(presetBtn);
  body.appendChild(pasteLabel);
  body.appendChild(pasteTa);
  body.appendChild(splitRow);
  body.appendChild(cardsLabel);
  body.appendChild(cardsBox);
  body.appendChild(autoUpscaleLabel);
  body.appendChild(generateBtn);
  body.appendChild(stopBtn);
  body.appendChild(importBtn);
  body.appendChild(diagBtn);
  body.appendChild(status);

  dock.appendChild(header);
  dock.appendChild(body);
  document.body.appendChild(dock);

  renderCards();
  refreshChannels();
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(() => {
    scanForImages();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      chrome.storage.local
        .get("autoDock")
        .then(({ autoDock }) => {
          if (autoDock !== false) buildDock();
        })
        .catch(() => buildDock());
    }, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "injectDock") {
    buildDock();
    sendResponse({ injected: !!document.getElementById(DOCK_ID) });
  }
  if (msg.type === "dockStatus") {
    sendResponse({ injected: !!document.getElementById(DOCK_ID) });
  }
  return false;
});

startObserver();
scanForImages();
buildDock();
