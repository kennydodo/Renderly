#!/usr/bin/env node
/*
 * Renderly extension-v2 — Playwright driver for Google Flow.
 *
 * Why this exists: the MV3 extension (../extension) cannot attach reference
 * images programmatically — Flow opens a NATIVE OS file picker, which content
 * scripts can never fill. Playwright intercepts that picker at the browser
 * level (filechooser event), so reference/ingredient attachment is finally
 * automated end to end.
 *
 * Usage:
 *   node flow.js --file prompts.json --channel 3
 *   node flow.js --prompt "a fox in the mist" --refs C:\pics\fox1.png,C:\pics\fox2.png
 *   node flow.js --diag            # dump Flow's prompt box / buttons / file inputs
 *
 * Prompts file: JSON array of { "file": "name.png", "prompt": "...", "refs": ["p1.png"] }
 * or a plain text file with one prompt per line (same "name.png prompt" token rule
 * as the extension).
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const DEFAULT_BACKEND = "http://127.0.0.1:8022";
const PROFILE_DIR = path.join(__dirname, "profile");
const OUTPUT_DIR = path.join(__dirname, "output");
const FLOW_URL = "https://flow.google.com/";

/* ================= CLI ================= */

function parseArgs(argv) {
  const opts = {
    backend: DEFAULT_BACKEND,
    versions: 1,
    upscale: 2, // 0 = off
    out: OUTPUT_DIR,
    refs: [],
    timeout: 240000,
    master: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--file") opts.file = next();
    else if (a === "--prompt") opts.prompt = next();
    else if (a === "--master") opts.master = next();
    else if (a === "--channel") opts.channel = next();
    else if (a === "--project") opts.project = next();
    else if (a === "--backend") opts.backend = String(next()).replace(/\/+$/, "");
    else if (a === "--refs")
      opts.refs = String(next())
        .split(",")
        .map((s) => path.resolve(s.trim()))
        .filter(Boolean);
    else if (a === "--versions") opts.versions = Number(next()) || 1;
    else if (a === "--upscale") opts.upscale = Number(next()) || 0;
    else if (a === "--out") opts.out = path.resolve(next());
    else if (a === "--timeout") opts.timeout = Number(next()) || opts.timeout;
    else if (a === "--diag") opts.diag = true;
    else if (a === "--attach-diag") opts.attachDiag = true;
    else if (a === "--click-diag") opts.clickDiag = next();
    else if (a === "--drop-test") opts.dropTest = true;
    else if (a === "--import-only") opts.importOnly = true;
    else if (a === "--browser") opts.browser = next();
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function usage() {
  console.log(`Renderly extension-v2 — Playwright driver for Google Flow

  node flow.js --file prompts.json [--channel 3] [--refs a.png,b.png]
  node flow.js --prompt "..." [--refs a.png] [--versions 2]
  node flow.js --diag

Options:
  --file <path>      Prompts file: JSON array, {master,cards} object, or shotlist
  --prompt "<text>"  Single prompt run
  --master "<text>"  Style prefix prepended to every card prompt
  --channel <id>     Renderly channel id — results are imported via /api/channels/{id}/import
  --project <id/name> Renderly project inside the channel — imports land there
  --refs <a,b,...>   Global reference images (attached once, persist for every card)
  --versions <1-4>   Generations per card (default 1)
  --upscale <0-4>    Renderly GPU upscale factor after import; 0 disables (default 2)
  --backend <url>    Renderly backend (default ${DEFAULT_BACKEND})
  --out <dir>        Local download folder (default ./output)
  --timeout <ms>     Per-generation wait limit (default 240000)
  --browser <name>   chrome (default) or chromium
  --diag             Print Flow page diagnostics and exit
  --attach-diag      Click the ingredient control, dump what opens, exit
  --click-diag <s>   Click the button whose aria-label contains <s>, dump, exit
`);
}

/* ================= Prompt parsing (ported from extension/content.js) ================= */

// `s` flag matches the backend's re.DOTALL copy (backend/routes/generate.py)
// so multi-line "NAME.png …" prompts strip the token the same way.
const NAME_TOKEN_RE = /^\s*([\w\-]+\.(?:png|jpe?g))\s+(.*)$/is;

function stemName(value) {
  let v = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  v = v.split(/[\\/]/).pop() || "";
  v = v.replace(/\.(png|jpe?g|webp)$/i, "").trim();
  return v || null;
}

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

function splitPromptName(text) {
  const raw = String(text || "").trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = extractFromObject(JSON.parse(raw));
      if (parsed) return { name: parsed.name, prompt: parsed.prompt || raw };
    } catch {
      /* fall through */
    }
  }
  const match = raw.match(NAME_TOKEN_RE);
  if (match && match[2].trim()) {
    return { name: stemName(match[1]), prompt: match[2].trim() };
  }
  const anyFile = raw.match(/[\w\-]+\.(?:png|jpe?g|webp)/i);
  if (anyFile) return { name: stemName(anyFile[0]), prompt: raw };
  return { name: null, prompt: raw };
}

function safeFileName(name) {
  let cleaned = String(name || "")
    .replace(/[^\w\-.]/g, "_")
    .replace(/^[._ ]+|[._ ]+$/g, "");
  if (/\.(png|jpe?g|webp)$/i.test(cleaned)) cleaned = cleaned.replace(/\.[^.]+$/, "");
  return cleaned || "image";
}

// What actually gets sent to Flow: master (style prefix) + card prompt.
function composePrompt(opts, card) {
  const master = (opts.master || "").trim();
  const p = String(card.prompt || "").trim();
  return master ? `${master} ${p}`.trim() : p;
}

function loadCards(opts) {
  const EXTS = ["", ".png", ".jpg", ".jpeg", ".webp"];
  const EXT_RE = /\.(png|jpe?g|webp)$/i;
  const baseDirs = [];
  if (opts.file) {
    const shotDir = path.dirname(path.resolve(opts.file));
    baseDirs.push(shotDir, path.join(shotDir, "refs"));
  }
  // Ref entries may be absolute paths, or bare names ("Maya", "conference")
  // sitting next to the shotlist file (or in its refs\ subfolder). Absolute
  // paths and cwd-relative paths keep working as before.
  const normalizeRefs = (arr) => {
    const out = [];
    for (const raw0 of arr || []) {
      const raw = String(raw0).trim();
      if (!raw) continue;
      const candidates = [path.resolve(raw)];
      if (!path.isAbsolute(raw)) {
        for (const b of baseDirs) {
          for (const ext of EXTS) candidates.push(path.join(b, raw + ext));
        }
      } else if (!EXT_RE.test(raw)) {
        for (const ext of EXTS.slice(1)) candidates.push(raw + ext);
      }
      const found = candidates.find(
        (c) => fs.existsSync(c) && fs.statSync(c).isFile()
      );
      if (found) {
        out.push(path.resolve(found));
        continue;
      }
      console.warn(`⚠ reference not found, skipping: ${path.resolve(raw)}`);
    }
    return [...new Set(out)];
  };

  if (opts.prompt) {
    const { name, prompt } = splitPromptName(opts.prompt);
    return [{ name, prompt, refs: normalizeRefs(opts.refs) }];
  }
  if (!opts.file) return null;
  const raw = fs.readFileSync(opts.file, "utf8").trim();
  // Object format: { "master": "style prefix", "cards": [ …entries… ] }
  if (raw.startsWith("{")) {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj.cards)) {
      opts.masterSource = String(obj.master || "").trim();
      return obj.cards
        .map((obj2) => {
          const e = extractFromObject(obj2);
          if (!e) return null;
          return {
            name: e.name,
            prompt: e.prompt || e.name || "",
            refs: normalizeRefs([...(obj2.refs || []), ...opts.refs]),
          };
        })
        .filter(Boolean);
    }
    // Shotlist format: { schema_version, video, style, shots, images }
    // — style becomes the master prompt, images[] is the generation list.
    if (Array.isArray(obj.images)) {
      opts.masterSource = String(obj.style || "").trim();
      return obj.images
        .map((img) => {
          const e = extractFromObject(img);
          if (!e) return null;
          return {
            name: e.name,
            prompt: e.prompt || e.name || "",
            refs: normalizeRefs([...(img.refs || []), ...opts.refs]),
          };
        })
        .filter(Boolean);
    }
  }
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw);
    return arr
      .map((obj) => {
        const e = extractFromObject(obj);
        if (!e) return null;
        return {
          name: e.name,
          prompt: e.prompt || e.name || "",
          refs: normalizeRefs([...(obj.refs || []), ...opts.refs]),
        };
      })
      .filter(Boolean);
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const { name, prompt } = splitPromptName(line);
      return { name, prompt, refs: normalizeRefs(opts.refs) };
    });
}

/* ================= Page-side helpers (installed once into the page) ================= */

async function installHelpers(page) {
  await page.evaluate(() => {
    if (window.__renderly) return;
    const H = {};

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
      const walker = root.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
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

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
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

    function getPromptInput() {
      // [contenteditable] matches any value ("", "true", "plaintext-only").
      const candidates = deepQueryAll(
        'textarea, [contenteditable][role="textbox"], [contenteditable], input[type="text"]'
      ).filter(isVisible);
      const pool = candidates.length ? candidates : deepQueryAll("textarea, [contenteditable]");
      return (
        pool.find((el) => el.tagName === "TEXTAREA") ||
        pool.find((el) => el.getAttribute("role") === "textbox") ||
        pool.find((el) => el.isContentEditable) ||
        pool[0] ||
        null
      );
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
        if ((input.value || "").trim() === text.trim()) return true;
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
          input.textContent = text;
          input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
        }
      }
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
      return (input.textContent || "").includes(text.slice(0, 40));
    }

    function promptFilled(input, prompt) {
      if (!input) return false;
      const needle = prompt.trim().slice(0, 40);
      if (!needle) return false;
      const value = input.value !== undefined ? String(input.value) : "";
      return value.includes(needle) || String(input.textContent || "").includes(needle);
    }

    H.getPromptInfo = () => {
      const el = getPromptInput();
      return el ? describeEl(el) : null;
    };

    // Fill, then verify — returns true when the text actually landed.
    // An empty prompt is never a success (it would "match" an empty box).
    H.fillPrompt = (text) => {
      if (!String(text || "").trim()) return false;
      const input = getPromptInput();
      if (!input) return false;
      if (setPromptText(input, text)) return true;
      return promptFilled(getPromptInput() || input, text);
    };

    H.triggerGenerate = () => {
      const input = getPromptInput();
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
        (b) => isVisible(b)
      );
      const byAria = buttons.find((b) => {
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        // Flow's submit is "Start generation" — "generat" covers it.
        return /generat|submit|send|create|start/i.test(label);
      });
      if (byAria) {
        // The submit stays disabled until the composer registers the text;
        // report that distinctly so the caller can refill and retry.
        return { clicked: !byAria.disabled, enabled: !byAria.disabled, how: describeEl(byAria) };
      }
      const byText = buttons.find(
        (b) => /generate|create|render|send|submit/i.test(b.textContent || "") && !b.disabled
      );
      if (byText) return { clicked: true, enabled: true, how: describeEl(byText) };
      const submit = buttons.find((b) => b.getAttribute("type") === "submit" && !b.disabled);
      if (submit) return { clicked: true, enabled: true, how: describeEl(submit) };
      return { clicked: false, enabled: false, how: null };
    };

    // Only images Flow itself produced (or page-local blob:/data: URLs)
    // count as results — unrelated large images on the page are ignored.
    // ".google" is Google's own TLD — result files live on
    // flow-content.google, grids on flow.google.com.
    function trustedSrc(src) {
      if (!src) return false;
      if (src.startsWith("blob:") || src.startsWith("data:")) return true;
      try {
        const host = new URL(src).hostname;
        return (
          host === "flow.google.com" ||
          host === "labs.google" ||
          host.endsWith(".google.com") ||
          host.endsWith(".googleusercontent.com") ||
          host.endsWith(".google")
        );
      } catch {
        return false;
      }
    }

    H.collectImages = () => {
      const out = [];
      deepQueryAll("img").forEach((img) => {
        if (img.complete && img.naturalWidth >= 512 && img.naturalHeight >= 512) {
          const src = img.currentSrc || img.src;
          if (trustedSrc(src)) out.push(src);
        }
      });
      return out;
    };

    // MutationObserver records qualifying images as they appear, so the
    // wait loop can poll a small array instead of re-walking the whole DOM.
    // Watches BOTH added nodes and src swaps on existing <img> elements —
    // virtualized grids reuse tiles instead of inserting new ones.
    H.__newSrcs = [];
    const considerImage = (img) => {
      if (!img || img.tagName !== "IMG") return;
      const check = () => {
        const src = img.currentSrc || img.src;
        if (
          src &&
          img.complete &&
          img.naturalWidth >= 512 &&
          img.naturalHeight >= 512 &&
          trustedSrc(src) &&
          !H.__newSrcs.includes(src)
        ) {
          H.__newSrcs.push(src);
        }
      };
      check();
      img.addEventListener("load", check);
    };
    H.__observer = new MutationObserver((muts) => {
      muts.forEach((m) => {
        if (m.type === "attributes") {
          considerImage(m.target);
          return;
        }
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.tagName === "IMG") considerImage(n);
          else if (n.querySelectorAll) n.querySelectorAll("img").forEach(considerImage);
        });
      });
    });
    H.__observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });

    H.takeNewSrcs = () => H.__newSrcs.slice();
    H.resetNewSrcs = () => {
      H.__newSrcs = [];
    };

    // True while Flow is still rendering. Returns the evidence too — if it
    // ever blocks a finished image, the log shows which button did it.
    H.generationBusy = () => {
      const btns = deepQueryAll('button, [role="button"]').filter(isVisible);
      const matches = btns
        .filter((b) =>
          /start generation|generat|stop|cancel/i.test(b.getAttribute("aria-label") || "")
        )
        .map((b) => ({
          label: b.getAttribute("aria-label"),
          disabled: !!b.disabled,
          ariaDisabled: b.getAttribute("aria-disabled"),
        }));
      const submit = matches.find((m) => /start generation|generat/i.test(m.label || ""));
      const stop = matches.find((m) => /stop|cancel/i.test(m.label || ""));
      return {
        busy: !!(submit && (submit.disabled || submit.ariaDisabled === "true")) || !!stop,
        detail: matches,
      };
    };

    // Everything currently in the DOM at any size — timeout forensics.
    H.imageDump = () =>
      deepQueryAll("img")
        .slice(0, 40)
        .map((img) => ({
          src: String(img.currentSrc || img.src || "").slice(0, 90),
          w: img.naturalWidth,
          h: img.naturalHeight,
          complete: img.complete,
        }));

    // Click Flow's upload / "Add ingredients" control. Returns a description
    // or false. The native file chooser it opens is caught by the Node side.
    // "Add ingredients to the prompt box" wins over the generic "Add media
    // menu" — only the ingredient one attaches references to the composer.
    H.clickUploadControl = () => {
      const label = (b) =>
        (
          (b.getAttribute("aria-label") || "") +
          " " +
          (b.getAttribute("title") || "") +
          " " +
          (b.textContent || "")
        )
          .toLowerCase()
          .trim();
      const cands = deepQueryAll('button, [role="button"], [role="menuitem"], a').filter(
        (b) => isVisible(b)
      );
      let el = cands.find((b) => /ingredient/.test(label(b)));
      if (!el) {
        el = cands.find((b) =>
          /upload|attach|add (image|media|photo|file|reference)|^add media/.test(label(b))
        );
      }
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
      return describeEl(el);
    };

    // Second step when the first click only opened a menu.
    H.clickMenuItemUpload = () => {
      const items = deepQueryAll(
        '[role="menuitem"], li, [role="option"], [role="button"], button'
      ).filter(isVisible);
      const el = items.find((e) =>
        /upload|choose (file|image)|from (your )?(computer|device)|add (image|media|file)s?/i.test(
          (e.textContent || "").trim()
        )
      );
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
      return describeEl(el);
    };

    // Generic probe: click the first visible control whose aria-label
    // contains `needle` (case-insensitive).
    H.clickByAria = (needle) => {
      const n = String(needle || "").toLowerCase();
      const cands = deepQueryAll('button, [role="button"], [role="menuitem"], a').filter(
        (b) => isVisible(b)
      );
      const el = cands.find((b) =>
        (b.getAttribute("aria-label") || "").toLowerCase().includes(n)
      );
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
      return describeEl(el);
    };

    // Snapshot of every visible element (menu diffing + generic probes).
    // Flow builds menus from custom elements, so no role/tag filtering.
    H.snapVisible = () => {
      const out = [];
      deepQueryAll("*").forEach((el) => {
        if (!isVisible(el)) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        const own = Array.from(el.childNodes)
          .filter((nd) => nd.nodeType === 3)
          .map((nd) => nd.textContent.trim())
          .join(" ")
          .trim();
        let cls = "";
        try {
          cls = String(
            el.className && el.className.baseVal !== undefined
              ? el.className.baseVal
              : el.className || ""
          ).slice(0, 70);
        } catch {
          cls = "";
        }
        out.push({ el: describeEl(el), own, cls });
      });
      return out;
    };

    // Drag-drop local files onto the composer. Uses the deep-walk finder —
    // Flow's prompt box lives inside shadow roots, where plain
    // document.querySelector cannot see.
    H.dropFiles = async (pls) => {
      const dt = new DataTransfer();
      for (const p of pls) {
        const bin = atob(p.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], p.name, { type: p.mime }));
      }
      // Drop on the real composer (contenteditable) — the textarea helper
      // is not the drop zone; the div is.
      const target =
        deepQueryAll("[contenteditable]").filter(isVisible)[0] ||
        getPromptInput() ||
        deepQueryAll("flow-prompt-box").filter(isVisible)[0] ||
        null;
      if (!target) return { ok: false, reason: "no drop target found" };
      const r = target.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      };
      target.dispatchEvent(new DragEvent("dragenter", init));
      target.dispatchEvent(new DragEvent("dragover", init));
      target.dispatchEvent(new DragEvent("drop", init));
      return { ok: true, target: describeEl(target) };
    };

    // Gallery tiles are aria-labeled with the asset's filename for uploads
    // and with the prompt-derived title for generations.
    H.galleryLabels = () =>
      deepQueryAll("flow-grid-tile-container")
        .map((t) => t.getAttribute("aria-label") || "")
        .filter(Boolean);

    // Robust "is this asset in the gallery?" check. Flow renders gallery
    // assets as BUTTONS whose accessible name is the asset name (textContent)
    // and not always as flow-grid-tile-container with an aria-label, so
    // checking only tile labels reported refs as missing.
    H.nameStem = (n) =>
      String(n || "")
        .toLowerCase()
        .replace(/\.(png|jpe?g|webp|gif|bmp)$/i, "")
        .trim();
    H.galleryHas = (name) => {
      const full = String(name || "").toLowerCase();
      const stem = H.nameStem(name);
      const hit = (h) => {
        const s = String(h || "").toLowerCase();
        return !!s && ((!!full && s.includes(full)) || (!!stem && s.includes(stem)));
      };
      return deepQueryAll(
        'flow-grid-tile-container, [role="option"], [role="listitem"], [role="checkbox"], button, img'
      )
        .filter(isVisible)
        .some((el) =>
          hit(
            el.getAttribute("aria-label") ||
              el.getAttribute("alt") ||
              (el.textContent || "")
          )
        );
    };

    // Chips live in `flow-ingredient-bar`, NOT inside the ProseMirror editor,
    // so a select-all in the editor never removes them. Prefer the semantic
    // tag (FlowImagesGen's primary selector), fall back to the aria chip.
    H.chips = () => {
      const byTag = deepQueryAll("flow-image-ingredient-chip").filter(isVisible);
      if (byTag.length) return byTag;
      return deepQueryAll("button[aria-label='Ingredient']").filter(isVisible);
    };
    H.hasIngredientChip = () => window.__renderly.chips().length > 0;
    H.chipCount = () => window.__renderly.chips().length;

    // Is the prompt text present in ANY visible composer editor? Focus alone
    // is not proof - the expanded overlay's editor is not always the active
    // element.
    H.composerHasText = (needle) =>
      deepQueryAll("[contenteditable]")
        .filter(isVisible)
        .some((e) => String(e.textContent || "").includes(needle));

    H.promptIsFilled = (text) => promptFilled(getPromptInput(), text);

    H.diagnose = () => {
      const input = getPromptInput();
      const allButtons = deepQueryAll('button, [role="button"]');
      const visibleButtons = allButtons.filter(isVisible);
      const genCandidates = visibleButtons
        .filter(
          (b) =>
            /generate|submit|send|create/i.test(
              (b.getAttribute("aria-label") || "") + (b.textContent || "")
            ) && !b.disabled
        )
        .map(describeEl)
        .slice(0, 4);
      return {
        url: location.href,
        readyState: document.readyState,
        bodyChildren: Array.from(document.body.children)
          .map((e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : ""))
          .slice(0, 20),
        promptBox: describeEl(input),
        promptVisible: input ? isVisible(input) : false,
        generateCandidates: genCandidates,
        visibleButtons: visibleButtons
          .map((b) => ({
            el: describeEl(b),
            text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
          }))
          .slice(0, 40),
        allButtons: allButtons
          .map((b) => ({
            el: describeEl(b),
            visible: isVisible(b),
            text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
          }))
          .slice(0, 60),
        // Icon-only controls are often divs/spans with an aria-label.
        ariaLabeled: deepQueryAll("[aria-label]")
          .filter((e) => e.tagName !== "BUTTON" && e.getAttribute("role") !== "button")
          .map((e) => ({ el: describeEl(e), label: e.getAttribute("aria-label") }))
          .slice(0, 60),
        // Menus/dialogs render in Angular Material's overlay container —
        // this is where the gallery picker's Upload control would live.
        overlayButtons: deepQueryAll(
          '.cdk-overlay-container button, .cdk-overlay-container [role="button"], .cdk-overlay-container [role="menuitem"], [role="dialog"] button, [role="dialog"] [role="button"], [role="dialog"] [role="menuitem"], mat-dialog-container button'
        )
          .filter(isVisible)
          .map((b) => ({
            el: describeEl(b),
            text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
          }))
          .slice(0, 40),
        // Raw overlay contents — catches menu items that aren't <button>s.
        menuPanels: deepQueryAll(
          '.cdk-overlay-container [role="menu"], .cdk-overlay-container .mat-mdc-menu-panel, .cdk-overlay-container [role="listbox"], .cdk-overlay-container [role="dialog"], .cdk-overlay-container [role="menuitem"]'
        )
          .map((p) => ({
            el: describeEl(p),
            text: (p.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
          }))
          .slice(0, 10),
        overlayText: (() => {
          const c = document.querySelector(".cdk-overlay-container");
          return c ? (c.textContent || "").trim().replace(/\s+/g, " ").slice(0, 500) : "";
        })(),
        iframeInfo: Array.from(document.querySelectorAll("iframe")).map((f) => {
          let access = "unknown";
          try {
            access = f.contentDocument ? "same-origin" : "cross-origin";
          } catch {
            access = "cross-origin";
          }
          return { src: (f.src || "").slice(0, 100), access };
        }),
        fileInputs: deepQueryAll('input[type="file"]').map((i) => ({
          accept: i.accept || "(none)",
          multiple: !!i.multiple,
          visible: isVisible(i),
        })),
        uploadCandidates: allButtons
          .filter((b) => {
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
          .map(describeEl)
          .slice(0, 4),
      };
    };

    window.__renderly = H;
  });
}

/* ================= Node-side helpers ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pause(message) {
  // Non-interactive contexts (the driver service spawns us without a TTY)
  // must never block on a prompt.
  if (!process.stdin || !process.stdin.isTTY) return Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(message || "Press Enter to continue…", () => {
      rl.close();
      resolve();
    })
  );
}

// Finished results live on Flow's asset host (flow-content.google/image/…);
// grid placeholders use flow.google.com/asb/…. Only the finished host counts
// as done regardless of any button state.
function isFinalResultUrl(src) {
  try {
    const u = new URL(src);
    return u.hostname === "flow-content.google" && /^\/image\//.test(u.pathname);
  } catch {
    return false;
  }
}

async function waitForNewImage(page, timeoutMs, onTick, sessionSeen) {
  const started = Date.now();
  const STABLE_MS = 5000;
  const STABLE_MS_ANY = 20000;
  let tick = 0;
  let candidate = null;
  let candidateSince = 0;
  let blockLogged = false;
  // A result belongs to exactly one card: a URL is acceptable only if this
  // session has NEVER seen it before - grid results, ref uploads and
  // stragglers from failed cards are all in sessionSeen.
  const isFresh = (s) => isFinalResultUrl(s) && !sessionSeen.has(s);
  while (Date.now() - started < timeoutMs) {
    let fresh = (await page.evaluate(() => window.__renderly.takeNewSrcs())).filter(isFresh);
    // Full-DOM sweep every ~3s: catches src swaps on reused tiles and
    // anything the observer missed. Cheap enough at this interval.
    if (!fresh.length && ++tick % 2 === 0) {
      const all = await page.evaluate(() => window.__renderly.collectImages());
      fresh = all.filter(isFresh);
    }
    if (fresh.length) {
      // Flow inserts the tile with a placeholder URL, then swaps to the
      // final result — always track the newest and accept it only once it
      // stops changing and the image looks finished.
      const newest = fresh[fresh.length - 1];
      if (newest !== candidate) {
        candidate = newest;
        candidateSince = Date.now();
      }
    }
    const stableFor = candidate ? Date.now() - candidateSince : 0;
    if (candidate && stableFor >= STABLE_MS) {
      // consume every fresh URL at acceptance, not just the candidate —
      // one generation can surface several URLs and the extras must never
      // be attributed to the next card
      for (const s of fresh) sessionSeen.add(s);
      sessionSeen.add(candidate);
      if (isFinalResultUrl(candidate)) return candidate;
      const busyRes = await page
        .evaluate(() => window.__renderly.generationBusy())
        .catch(() => null);
      if (!busyRes || !busyRes.busy) return candidate;
      if (!blockLogged && busyRes.detail) {
        console.log(`\n  ⚠ busy-check blocking acceptance: ${JSON.stringify(busyRes.detail)}`);
        blockLogged = true;
      }
      // Not finished by host or button state — a URL stable this long is
      // accepted anyway; a hard guarantee that a card can't stall.
      if (stableFor >= STABLE_MS_ANY) return candidate;
    }
    if (onTick) onTick(Math.round((Date.now() - started) / 1000));
    await sleep(1500);
  }
  // Timeout: return the best candidate seen (may be null) — the caller
  // reports the timeout but the image, if any, is still salvaged.
  if (candidate) sessionSeen.add(candidate);
  return candidate;
}

// After a failed card its generation may still be running on Flow's side —
// wait it out and mark every URL it produces as seen, so the next card does
// not adopt the result or queue a duplicate generation on top of it.
async function waitForIdle(page, timeoutMs, sessionSeen) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const busy = await page
      .evaluate(() => window.__renderly.generationBusy())
      .catch(() => null);
    const urls = await page.evaluate(() => window.__renderly.collectImages()).catch(() => []);
    for (const u of urls) {
      if (isFinalResultUrl(u)) sessionSeen.add(u);
    }
    if (!busy || !busy.busy) return true;
    await sleep(1500);
  }
  return false;
}

async function fetchImageDataUrl(page, src) {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read image data"));
      reader.readAsDataURL(blob);
    });
  }, src);
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error("Unexpected image data URL");
  return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
}

async function fetchProjects(backend, channelId) {
  const res = await fetch(`${backend}/api/projects?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function importToRenderly(backend, channelId, filePath, name, prompt, projectId) {
  const form = new FormData();
  // Explicit MIME type — the backend rejects parts without image/* (415).
  form.append(
    "file",
    new Blob([fs.readFileSync(filePath)], { type: mimeOf(filePath) }),
    path.basename(filePath)
  );
  form.append("prompt", prompt || "Generated in Google Flow");
  if (name) form.append("name", name);
  if (projectId) form.append("project_id", String(projectId));
  const res = await fetch(`${backend}/api/channels/${channelId}/import`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`import failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function upscaleGeneration(backend, id, scale) {
  const res = await fetch(`${backend}/api/generations/${id}/upscale`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scale }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function downloadUrl(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
}

// Never overwrite an existing output — earlier batches stay intact.
function uniqueFilePath(dir, baseName) {
  let p = path.join(dir, `${baseName}.png`);
  let i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${baseName}-${i++}.png`);
  return p;
}

function mimeOf(p) {
  if (/\.jpe?g$/i.test(p)) return "image/jpeg";
  if (/\.png$/i.test(p)) return "image/png";
  return "image/webp";
}

// PNG IHDR / JPEG SOF - enough to tell a ref-plate echo from a generation
// (generations come in the motion-code canvas size, refs in their own).
function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 &&
          marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * Make sure every ref exists in Flow's gallery: upload the missing ones via
 * drop (the global drop handler uploads files; tiles get the filename as
 * label). Used both for the once-per-batch pre-upload and by attachRefs.
 */
async function ensureRefsInGallery(page, refPaths) {
  const addBtn = page
    .getByRole("button", { name: "Add ingredients to the prompt box" })
    .first();
  const search = page.getByRole("textbox", { name: "Search assets" }).first();
  const panelOpen = async () =>
    (await search.isVisible().catch(() => false)) ||
    (await page
      .locator('[role="listbox"][aria-label="Asset list"]')
      .isVisible()
      .catch(() => false));
  const openPanel = async () => {
    if (await panelOpen()) return;
    await addBtn.click({ timeout: 10000 }).catch(() => {});
    await search.waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(1200);
  };
  const closePanel = async () => {
    for (let i = 0; i < 3; i++) {
      if (!(await panelOpen())) return;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(600);
      const closeBtn = page.getByRole("button", { name: "Close" }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click({ timeout: 4000 }).catch(() => {});
        await sleep(500);
      }
    }
  };
  const missingOf = async () => {
    const out = [];
    for (const p of refPaths) {
      const found = await page
        .evaluate((n) => window.__renderly.galleryHas(n), path.basename(p))
        .catch(() => false);
      if (!found) out.push(p);
    }
    return out;
  };

  // The gallery only exists while the ingredient panel is OPEN. The old code
  // read project grid tiles instead, so every ref looked missing and got
  // re-uploaded (or the attach was skipped).
  await openPanel();
  let missing = await missingOf();
  await closePanel();
  if (!missing.length) return true;

  console.log(`  uploading ${missing.length} ref(s) to Flow's gallery via drop…`);
  // small chunks: dropping a dozen full-res files at once allocates them
  // all inside the page and crashes the tab. Drop with the panel CLOSED -
  // dropFiles targets the composer, and an open panel would capture it.
  const CHUNK = 3;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const payloads = chunk.map((p) => ({
      name: path.basename(p),
      mime: mimeOf(p),
      b64: fs.readFileSync(p).toString("base64"),
    }));
    const up = await page.evaluate((pls) => window.__renderly.dropFiles(pls), payloads);
    if (!up.ok) return false;
    await sleep(2500);
  }

  // Verify with the panel open again.
  await openPanel();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    missing = await missingOf();
    if (!missing.length) {
      await closePanel();
      return true;
    }
    await sleep(1500);
  }
  await closePanel();
  return false;
}

/**
 * Open the ingredient panel if needed and mark every asset preview URL as
 * seen: panel tiles are GALLERY ASSETS (uploaded refs, background plates) -
 * they must never be accepted as a card's generation result.
 */
async function harvestAssetPanel(page, sessionSeen) {
  const addBtn = page
    .getByRole("button", { name: "Add ingredients to the prompt box" })
    .first();
  const search = page.getByRole("textbox", { name: "Search assets" }).first();
  const isOpen = async () =>
    (await search.isVisible().catch(() => false)) ||
    (await page
      .locator('[role="listbox"][aria-label="Asset list"]')
      .isVisible()
      .catch(() => false));
  if (!(await isOpen().catch(() => false))) {
    await addBtn.click({ timeout: 10000 }).catch(() => {});
    await search.waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(1500);
  }
  const urls = await page
    .evaluate(() => {
      const lb = document.querySelector('[role="listbox"][aria-label="Asset list"]');
      if (!lb) return [];
      return [...lb.querySelectorAll("img")]
        .map((i) => String(i.currentSrc || i.src || ""))
        .filter(Boolean);
    })
    .catch(() => []);
  for (const u of urls) sessionSeen.add(u);
}

/**
 * Attach reference images as Flow ingredients:
 *  1. ensure every ref exists in Flow's gallery (upload via drop — the
 *     global drop handler uploads files; tiles get the filename as label)
 *  2. open the ingredient picker ("Add ingredients to the prompt box")
 *  3. click the gallery tiles matching the ref filenames, then "Done editing"
 *  4. verify the Ingredient chip is present in the composer
 */
/* ---------- Asset-library helpers (FlowImagesGen's proven model) ---------- */

/** Is Flow's inline asset library (the prompt box "+" picker) open? */
async function assetLibraryOpen(page) {
  return page
    .locator(
      "flow-add-menu-asset-list, input.search-input[aria-label='Search assets'], input[placeholder='Search assets'], .asset-list-viewport"
    )
    .first()
    .isVisible()
    .catch(() => false);
}

async function openAssetLibrary(page) {
  if (await assetLibraryOpen(page)) return true;
  const addBtn = page
    .getByRole("button", { name: "Add ingredients to the prompt box" })
    .first();
  await addBtn.click({ timeout: 8000 }).catch(() => {});
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await assetLibraryOpen(page)) {
      await sleep(600);
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function closeAssetLibrary(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await assetLibraryOpen(page))) return true;
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
  }
  return !(await assetLibraryOpen(page));
}

/**
 * Reuse an existing project asset by name. Clicking a result attaches it AND
 * closes the library in one action; some builds instead show a preview that
 * still needs "Add to prompt", so the confirm step is conditional.
 */
async function attachExistingAsset(page, name, sessionSeen) {
  if (!(await openAssetLibrary(page))) return false;
  await harvestAssetPanel(page, sessionSeen);
  const search = page
    .locator("input.search-input[aria-label='Search assets'], input[placeholder='Search assets']")
    .first();
  const stem = name.replace(/\.[a-z0-9]+$/i, "");
  const nameLow = name.toLowerCase();
  const target = stem.toLowerCase();
  const items = page.locator("button.asset-item[role='option']");
  const readTitles = async () => {
    const n = await items.count().catch(() => 0);
    const out = [];
    for (let index = 0; index < n; index++) {
      const title = (
        (await items
          .nth(index)
          .locator("span.asset-title, .asset-title")
          .first()
          .innerText()
          .catch(() => "")) || ""
      ).trim();
      out.push({ index, title });
    }
    return out;
  };
  const searchFor = async (term) => {
    if (!(await search.isVisible().catch(() => false))) return;
    await search.fill("").catch(() => {});
    await search.fill(term).catch(() => {});
    await sleep(1800);
  };

  // Search the full filename first (assets uploaded through the picker are
  // named after the file); fall back to the stem for prefixed assets.
  await searchFor(name);
  let rows = await readTitles();
  if (!rows.length) {
    await searchFor(stem);
    rows = await readTitles();
  }

  // Score so a PROMPT-TITLED generation tile ("Maya holding perfume bottle")
  // can never beat the actual reference asset ("Maya.png" / "refupload__Maya__…").
  const fileish = (t) => /\.[a-z0-9]+$/i.test(t) || /refupload/i.test(t);
  let chosen = -1;
  let chosenTitle = "";
  let best = 0;
  let fuzzy = -1;
  for (const { index, title } of rows) {
    if (!title) continue;
    if (fuzzy < 0) fuzzy = index;
    const low = title.toLowerCase();
    const titleStem = low.replace(/\.[a-z0-9]+$/i, "");
    let score = 0;
    if (low === nameLow || titleStem === target) score = 3;
    else if (fileish(title) && (titleStem === target || titleStem.includes(target))) score = 2;
    else if (fileish(title) && low.includes(target)) score = 1;
    if (score > best) {
      best = score;
      chosen = index;
      chosenTitle = title;
      if (score === 3) break;
    }
  }
  if (chosen < 0 && fuzzy >= 0) {
    chosen = fuzzy;
    chosenTitle = (rows.find((r) => r.index === fuzzy) || {}).title || "";
  }
  if (chosen < 0) return false;
  console.log(`  reusing project asset "${chosenTitle}" for "${name}"`);
  await items.nth(chosen).click({ timeout: 8000 }).catch(() => {});
  await sleep(1800);
  if (await assetLibraryOpen(page)) {
    const attach = page.getByRole("button", { name: /add to prompt/i }).first();
    if (await attach.isVisible().catch(() => false)) {
      await attach.click({ timeout: 8000 }).catch(() => {});
      await sleep(1500);
    }
  }
  return true;
}

/**
 * Upload one local file through the library's "Upload media" file input and
 * attach it. ONE file per session - uploading several at once only ever
 * attaches the first one.
 */
async function attachUploadedFile(page, filePath, sessionSeen) {
  const name = path.basename(filePath);
  // Reopen the library FRESH: a previous reuse leaves it filtered, and
  // "Upload media" only exists in the unfiltered view.
  await closeAssetLibrary(page);
  await sleep(600);
  if (!(await openAssetLibrary(page))) {
    console.log(`  ⚠ could not open the asset library to upload ${name}`);
    return false;
  }
  await harvestAssetPanel(page, sessionSeen);
  const search = page
    .locator("input.search-input[aria-label='Search assets'], input[placeholder='Search assets']")
    .first();
  await search.fill("").catch(() => {});
  await sleep(1200);
  const items = page.locator("button.asset-item[role='option']");
  const beforeCount = await items.count().catch(() => 0);

  // The control's LABEL is an aria-label ("Upload media") while its
  // textContent is just the icon ligature ("upload") - so match the
  // accessible name, not :has-text().
  const media = page
    .getByRole("button", { name: /upload media/i })
    .first();
  const mediaAlt = page
    .locator("button[aria-label*='upload' i], [role='menuitem']:has-text('Upload media'), [role='menuitem']:has-text('Upload')")
    .first();
  const mediaCount =
    (await media.count().catch(() => 0)) + (await mediaAlt.count().catch(() => 0));
  if (mediaCount === 0) {
    const btns = await page
      .evaluate(() => {
        const vis = (el) =>
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const out = [];
        for (const b of document.querySelectorAll(
          "button, [role='menuitem'], [role='button'], a"
        )) {
          if (!vis(b)) continue;
          const label = b.getAttribute("aria-label") || "";
          const text = (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
          if (!label && !text) continue;
          out.push(`${label}|${text}`);
        }
        return out.slice(0, 25);
      })
      .catch(() => []);
    console.log(`  ⚠ no "Upload media" control. Visible controls: ${btns.join(" ; ")}`);
    return false;
  }

  // "Upload media" may open a NATIVE file chooser (no <input> in the DOM) or
  // spawn a hidden input - listen for the chooser while clicking.
  const mediaTarget = (await media.count().catch(() => 0)) > 0 ? media : mediaAlt;
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null),
    mediaTarget.click({ timeout: 8000 }).catch(() => {}),
  ]);
  if (chooser) {
    await chooser.setFiles(filePath).catch(() => {});
  } else {
    // Pick the IMAGE file input, not merely the first one: the page can host
    // other (non-image) file inputs, and setting those uploads nothing.
    let input = null;
    const pickDeadline = Date.now() + 10000;
    while (Date.now() < pickDeadline && !input) {
      const inputs = page.locator("input[type=file]");
      const n = await inputs.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const candidate = inputs.nth(i);
        const accept = (await candidate.getAttribute("accept").catch(() => "")) ?? "";
        if (accept === "" || /image/i.test(accept)) {
          input = candidate;
          break;
        }
      }
      if (!input) await sleep(300);
    }
    if (!input) {
      console.log(`  ⚠ no image file input appeared after clicking "Upload media"`);
      return false;
    }
    await input.setInputFiles(filePath).catch(() => {});
  }

  // Wait until the upload actually lands: a NEW item in the library, or Flow
  // marking it selected. Large plates (BG_*.png, 14-18 MB) need real time.
  // Wait until the upload lands: a NEW item in the library, or Flow marking
  // it selected. Large plates (BG_*.png, 14-18 MB) need real time. The list
  // does not always refresh in place, so a miss here is not fatal - the
  // caller re-attaches from the project once the upload has been indexed.
  const settle = Date.now() + 60000;
  let landed = false;
  while (Date.now() < settle) {
    const nowCount = await items.count().catch(() => 0);
    const selected = await page
      .locator("button.asset-item[role='option'][aria-selected='true'], .asset-item-active")
      .count()
      .catch(() => 0);
    if (nowCount > beforeCount || selected >= 1) {
      landed = true;
      await sleep(800);
      break;
    }
    if (!(await assetLibraryOpen(page))) break;
    await sleep(700);
  }
  if (!landed) {
    console.log(`  uploaded ${name} - it is not listed yet, will attach from the project`);
    return true;
  }

  // Attach. "Add to prompt" stays DISABLED until the selection registers, and
  // a click on a disabled button silently does nothing.
  const attach = page.getByRole("button", { name: /add to prompt/i }).first();
  const confirmDeadline = Date.now() + 30000;
  while (Date.now() < confirmDeadline) {
    if (!(await assetLibraryOpen(page))) return true; // picker closed = attached
    if (
      (await attach.count().catch(() => 0)) > 0 &&
      (await attach.isEnabled().catch(() => false))
    ) {
      await attach.click({ timeout: 8000 }).catch(() => {});
      await sleep(1500);
      return true;
    }
    await sleep(500);
  }
  // Fall back to clicking the newest item (some builds attach on click).
  const last = items.last();
  if ((await last.count().catch(() => 0)) > 0) {
    await last.click({ timeout: 8000 }).catch(() => {});
    await sleep(1500);
    return true;
  }
  console.log(`  ⚠ uploaded ${name} but could not confirm the attach`);
  return true;
}

/**
 * Attach reference images as Flow ingredients - ONE picker session per ref.
 *
 * Flow's picker only ever attaches one selection per session, so each ref is
 * opened/searched/clicked/closed on its own (FlowImagesGen's model). Existing
 * project assets are reused by name; a local file is uploaded only when the
 * name is not found. Refuses to continue unless the composer ends up holding
 * exactly one chip per requested ref.
 */
async function attachRefs(page, refPaths, sessionSeen) {
  for (const refPath of refPaths) {
    const name = path.basename(refPath);
    const chipCount = () =>
      page.evaluate(() => window.__renderly.chipCount()).catch(() => 0);
    const before = await chipCount();
    let ok = await attachExistingAsset(page, name, sessionSeen);
    let chips = await chipCount();
    if (!ok || chips <= before) {
      // Not in the project (or the reuse click did not attach): upload it.
      console.log(`  "${name}" not in the project - uploading it…`);
      await attachUploadedFile(page, refPath, sessionSeen);
      await closeAssetLibrary(page);
      chips = await chipCount();
      if (chips <= before) {
        // The upload populated the project but did not attach the chip - now
        // attach it through the reuse path, which is the reliable one. The
        // new asset can take a moment to appear in the library's index, so
        // retry a few times rather than skipping the card.
        console.log(`  attaching the uploaded "${name}" from the project…`);
        for (let attempt = 1; attempt <= 3 && chips <= before; attempt++) {
          await closeAssetLibrary(page);
          await sleep(1500);
          ok = await attachExistingAsset(page, name, sessionSeen);
          chips = await chipCount();
        }
      }
    }
    if (!ok || chips <= before) {
      await closeAssetLibrary(page);
      return { attached: false, reason: `could not attach "${name}"` };
    }
    await closeAssetLibrary(page);
    console.log(`  after "${name}": ${chips} chip(s)`);
  }
  const deadline = Date.now() + 15000;
  let chips = 0;
  while (Date.now() < deadline) {
    chips = await page.evaluate(() => window.__renderly.chipCount()).catch(() => 0);
    if (chips >= refPaths.length) break;
    await sleep(400);
  }
  if (chips !== refPaths.length) {
    await closeAssetLibrary(page);
    return {
      attached: false,
      reason: `chip count ${chips} != refs ${refPaths.length}`,
    };
  }
  return { attached: true, how: `${chips} chip(s)` };
}

/**
 * Trusted prompt fill: click the real composer, select-all + Delete, then
 * insert the text at the CDP level so Angular's model actually registers it.
 * The page-side fillPrompt() mutates the DOM synthetically, which Flow often
 * ignores - leaving the submit arrow disabled and the card waiting forever.
 */
async function trustedFill(page, text) {
  if (!String(text || "").trim()) return false;
  const input = page
    .locator(
      "flow-rich-text-editor .ProseMirror[contenteditable='true'], div.base-prompt-box div[contenteditable='true'], div[contenteditable='true']"
    )
    .first();
  await input.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  if ((await input.count().catch(() => 0)) === 0) return false;
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: 8000 }).catch(() => {});
  await sleep(300);
  await page.keyboard.press("Control+a").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  await sleep(200);
  let typed = false;
  await page.keyboard
    .insertText(text)
    .then(() => {
      typed = true;
    })
    .catch(() => {});
  if (!typed) {
    await page.keyboard.type(text, { delay: 1 }).catch(() => {});
  }
  await sleep(600);
  // Success = the submit arrow actually armed.
  const btn = page
    .locator("button[aria-label='Start generation'], button.generate-icon-button")
    .first();
  const deadline = Date.now() + 12000;
  const needle = text.trim().slice(0, 30);
  while (Date.now() < deadline) {
    if (
      (await btn.count().catch(() => 0)) > 0 &&
      (await btn.isEnabled().catch(() => false))
    ) {
      return true;
    }
    if (
      await page
        .evaluate((n) => window.__renderly.composerHasText(n), needle)
        .catch(() => false)
    ) {
      await sleep(800);
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isEnabled().catch(() => false))) {
        return true;
      }
    }
    await sleep(400);
  }
  return false;
}

/**
 * Trusted click on Flow's "Start generation" arrow.
 *
 * The page-side triggerGenerate() only REPORTS that a button exists - it never
 * clicks, relying on a synthetic Enter that Flow's Angular state ignores. That
 * is why a card could sit "waiting for Flow" forever with nothing running.
 * This waits for the real button to enable and clicks it for real.
 */
async function clickGenerate(page) {
  const btn = page
    .locator("button[aria-label='Start generation'], button.generate-icon-button")
    .first();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if ((await btn.count().catch(() => 0)) > 0) {
      if (await btn.isEnabled().catch(() => false)) {
        await btn.click({ timeout: 5000 }).catch(() => {});
        await sleep(1200);
        const busy = await page
          .evaluate(() => window.__renderly.generationBusy())
          .catch(() => null);
        return { clicked: true, enabled: true, busy: !!(busy && busy.busy) };
      }
    }
    await sleep(400);
  }
  return { clicked: false, enabled: false, how: "no enabled Start generation button" };
}

/**
 * Detach every ingredient chip. The chips live in `flow-ingredient-bar`, NOT
 * inside the ProseMirror editor, so a select-all + Delete never removed them;
 * each chip has its own hover-revealed remove control, clicked with force
 * because the overlay is transparent until hovered.
 */
async function clearChipsTrusted(page) {
  const chip = page.locator(
    "flow-image-ingredient-chip button.chip-container, flow-image-ingredient-chip, button[aria-label='Ingredient']"
  );
  const rm = page.locator(
    "flow-image-ingredient-chip div.hover-icon-overlay, flow-image-ingredient-chip mat-icon.hover-icon"
  );
  for (let i = 0; i < 12; i++) {
    const n = await chip.count().catch(() => 0);
    if (!n) return 0;
    if ((await rm.count().catch(() => 0)) === 0) return n;
    await rm.first().click({ force: true, timeout: 4000 }).catch(() => {});
    await sleep(600);
  }
  return chip.count().catch(() => 0);
}

/* ================= Main ================= */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const cards = loadCards(opts);
  if (opts.diag || opts.attachDiag || opts.clickDiag !== undefined || opts.dropTest) {
    // Diagnostics run without needing cards.
  } else if (!cards || !cards.length) {
    usage();
    process.exitCode = 1;
    return;
  }
  // Master prompt: --master flag wins, else the JSON file's "master" field.
  opts.master = (opts.master || "").trim() || (opts.masterSource || "").trim();

  fs.mkdirSync(opts.out, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  if (opts.channel) {
    // Accept a numeric id or a channel name — resolve names via /api/channels.
    let channelId = opts.channel;
    const direct = await fetch(
      `${opts.backend}/api/channels/${encodeURIComponent(channelId)}`
    ).catch(() => null);
    if (!direct || !direct.ok) {
      const listRes = await fetch(`${opts.backend}/api/channels`).catch(() => null);
      if (!listRes || !listRes.ok) {
        throw new Error(
          `Renderly backend unreachable at ${opts.backend} — run start.bat first`
        );
      }
      const channels = await listRes.json();
      const match = channels.find(
        (c) => (c.name || "").toLowerCase() === channelId.toLowerCase()
      );
      if (!match) {
        throw new Error(
          `no channel named "${channelId}" (have: ${channels.map((c) => c.name).join(", ")})`
        );
      }
      channelId = String(match.id);
    }
    opts.channel = channelId;
    // Resolve the target project: numeric id accepted as-is, otherwise match
    // the project name inside the channel (imports land in the channel's
    // default/unsorted view when absent or unresolvable).
    opts.projectId = null;
    if ((opts.project || "").trim()) {
      const rawProject = String(opts.project).trim();
      if (/^\d+$/.test(rawProject)) {
        opts.projectId = Number(rawProject);
      } else {
        try {
          const projects = await fetchProjects(opts.backend, channelId);
          const match = projects.find(
            (p) => (p.name || "").toLowerCase() === rawProject.toLowerCase()
          );
          if (match) {
            opts.projectId = match.id;
          } else {
            console.log(
              `⚠ project "${rawProject}" not found in the channel — imports land in the channel default`
            );
          }
        } catch (err) {
          console.log(`⚠ could not resolve project: ${err.message}`);
        }
      }
    }
  }

  if (opts.importOnly) {
    // Re-import already-generated images from output\ — no Flow involved.
    // Recovery path for batches that generated fine but failed to import.
    let ok = 0;
    for (let ci = 0; ci < cards.length; ci++) {
      const card = cards[ci];
      const baseName =
        safeFileName(card.name || splitPromptName(card.prompt).name || `card-${ci + 1}`);
      const exact = path.join(opts.out, `${baseName}.png`);
      let filePath = fs.existsSync(exact) ? exact : null;
      if (!filePath && fs.existsSync(opts.out)) {
        const suffixed = fs
          .readdirSync(opts.out)
          .filter((f) => f.startsWith(`${baseName}-`) && f.endsWith(".png"))
          .sort();
        if (suffixed.length) filePath = path.join(opts.out, suffixed[0]);
      }
      if (!filePath) {
        console.log(`✕ ${baseName}: no file in output\\ — skipped`);
        continue;
      }
      try {
        const record = await importToRenderly(
          opts.backend,
          opts.channel,
          filePath,
          baseName,
          composePrompt(opts, card),
          opts.projectId
        );
        console.log(`✓ ${record.name} imported`);
        if (opts.upscale > 0) {
          try {
            const up = await upscaleGeneration(opts.backend, record.id, opts.upscale);
            // Replace in place: the upscaled image keeps the exact original
            // filename (no "-upscaled" duplicate next to it).
            await downloadUrl(new URL(up.image_url, opts.backend).href, filePath);
            console.log(`  upscaled in place → ${up.image_size}`);
          } catch (err) {
            console.log(`  ⚠ upscale skipped: ${err.message}`);
          }
        }
        ok++;
      } catch (err) {
        console.log(`✕ ${baseName}: ${err.message}`);
      }
    }
    console.log(`\nImport finished — ${ok}/${cards.length}`);
    return;
  }

  console.log("Launching Chrome (persistent profile keeps you signed in)…");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: opts.browser || "chrome",
    headless: false,
    viewport: null,
    chromiumSandbox: true, // avoids Chrome's "--no-sandbox unsupported" warning bar
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      // Keep generating while the window is minimized or covered: without
      // these, Windows occlusion marks the page hidden and Flow pauses.
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await runFlowSession(page, opts, cards);
  } finally {
    // Always close: a mid-batch failure must not hang the process or keep
    // the persistent profile locked for the next launch.
    await context.close().catch(() => {});
  }
}

async function runFlowSession(page, opts, cards) {
  await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });

  // First run: sign in once inside the automated browser — the profile
  // remembers it for every later run.
  try {
    await page.waitForURL(/accounts\.google\.(?:com|co)/, { timeout: 6000 });
    console.log("\nSign-in required: log into Google in the opened browser window.");
    await pause("Press Enter here after you are signed in…");
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  } catch {
    /* no sign-in redirect — the prompt-box check below verifies the state */
  }

  await installHelpers(page);
  // Every result URL this session saves or sees goes into sessionSeen - a
  // URL can be accepted as a card's result exactly once, so ref uploads,
  // grid re-entry and stragglers from failed cards are never misattributed.
  const sessionSeen = new Set();
  const promptUp = await page
    .waitForFunction(() => window.__renderly && window.__renderly.getPromptInfo(), null, {
      timeout: 15000,
    })
    .then(() => true)
    .catch(() => false);
  if (!promptUp) {
    console.log("\nFlow's prompt box not found — you are probably not signed in.");
    await pause("Sign into Google in the opened browser window, then press Enter…");
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
    await installHelpers(page);
    await page.waitForFunction(() => window.__renderly && window.__renderly.getPromptInfo(), null, {
      timeout: 60000,
    });
  }

  // Baseline: everything already on the page belongs to earlier sessions.
  for (const u of await page.evaluate(() => window.__renderly.collectImages()).catch(() => [])) {
    if (isFinalResultUrl(u)) sessionSeen.add(u);
  }
  // Pre-upload every unique ref for the whole batch ONCE, before any card:
  // a mid-batch upload creates a fresh gallery asset whose URL would
  // otherwise be indistinguishable from a generation result.
  const uniqueRefs = [
    ...new Set(
      cards
        .flatMap((c) => c.refs || [])
        .map((r) => String(r).trim())
        .filter(Boolean)
    ),
  ];
  if (uniqueRefs.length) {
    // No pre-upload. Each card's attach reuses the project asset by name and
    // uploads only when it is missing (FlowImagesGen's model). Uploading via
    // the picker also keeps assets named after the file, which the name
    // lookup relies on - the old drop path prefixed them with "refupload__".
    console.log(
      `References: ${uniqueRefs.length} unique image(s) - reused from the project, uploaded when missing`
    );
  }
  const sessionRefs = uniqueRefs;

  if (opts.clickDiag !== undefined) {
    // Real (trusted) click on a named control, then diff visible elements.
    const btn = page.getByRole("button", { name: opts.clickDiag }).first();
    await btn.waitFor({ timeout: 20000 });
    const key = (r) => `${r.el}|${r.own}|${r.cls}`;
    const before = new Set((await page.evaluate(() => window.__renderly.snapVisible())).map(key));
    await btn.click();
    await sleep(2500);
    const after = await page.evaluate(() => window.__renderly.snapVisible());
    const added = after.filter((r) => !before.has(key(r))).slice(0, 150);
    const reportPath = path.join(__dirname, "click-diag-report.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ clicked: opts.clickDiag, added }, null, 2)
    );
    console.log(`\n${added.length} new control(s) after the click — report saved to ${reportPath}`);
    return;
  }

  if (opts.dropTest) {
    // Drag-and-drop local files onto Flow's prompt box — bypasses every
    // menu, gallery and file dialog. Flow's own drop handler creates the
    // ingredient (this is how manual drag-drop works in the UI).
    let refPaths = opts.refs.filter((p) => fs.existsSync(p));
    if (!refPaths.length) {
      const dir = path.join(__dirname, "refs");
      refPaths = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .map((f) => path.join(dir, f))
            .filter((f) => fs.statSync(f).isFile())
        : [];
    }
    refPaths = refPaths.slice(0, 3); // Flow allows up to 3 ingredients
    if (!refPaths.length) {
      throw new Error("no reference files found — put them in refs/ or pass --refs");
    }
    const payloads = refPaths.map((p) => ({
      name: path.basename(p),
      mime: /\.jpe?g$/i.test(p)
        ? "image/jpeg"
        : /\.png$/i.test(p)
          ? "image/png"
          : "image/webp",
      b64: fs.readFileSync(p).toString("base64"),
    }));
    console.log(`dropping ${payloads.length} file(s) onto the prompt box…`);
    const res = await page.evaluate((pls) => window.__renderly.dropFiles(pls), payloads);
    console.log(`drop result: ${JSON.stringify(res)}`);
    await sleep(6000);
    const report = await page.evaluate(() => window.__renderly.diagnose());
    const reportPath = path.join(__dirname, "drop-test-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nDrop report saved to ${reportPath}`);
    return;
  }

  if (opts.attachDiag) {
    // Open the ingredient picker, toggle its selection mode, and dump the
    // state — this maps the multi-select flow for reference attachment.
    const addBtn = page
      .getByRole("button", { name: "Add ingredients to the prompt box" })
      .first();
    await addBtn.waitFor({ timeout: 20000 });
    await addBtn.click();
    await sleep(2500);
    const selBtn = page.getByRole("button", { name: "image selection menu" }).first();
    try {
      await selBtn.click({ timeout: 8000 });
      console.log("clicked: selection menu toggle");
    } catch (err) {
      console.log(`no selection menu button: ${err.message.split("\n")[0]}`);
    }
    await sleep(2500);
    const report = await page.evaluate(() => window.__renderly.diagnose());
    const reportPath = path.join(__dirname, "attach-diag-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await page
      .screenshot({ path: path.join(__dirname, "attach-diag-screenshot.png") })
      .catch(() => {});
    console.log(`\nAttach report saved to ${reportPath}`);
    return;
  }

  if (opts.diag) {
    // Give the SPA time to hydrate before probing the DOM.
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    await sleep(5000);
    const report = await page.evaluate(() => window.__renderly.diagnose());
    const reportPath = path.join(__dirname, "diag-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const shotPath = path.join(__dirname, "diag-screenshot.png");
    await page.screenshot({ path: shotPath }).catch(() => {});
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nReport saved to ${reportPath}`);
    console.log(`Screenshot saved to ${shotPath}`);
    return;
  }

  const versions = Math.min(4, Math.max(1, opts.versions));
  const masterRefPaths = cards[0] ? cards[0].refs.filter((r) => opts.refs.includes(r)) : [];
  let ok = 0;
  let failed = 0;
  let costUsd = 0;

  // One generation: fill prompt → attach refs → trigger → fetch/save/import.
  // Throws on failure; the batch loop catches and continues with the rest.
  const runVersion = async (card, ci, v) => {
    const cardLabel = card.name || `card ${ci + 1}`;
    const versionLabel = versions > 1 ? ` (${v + 1}/${versions})` : "";
    const baseName =
      versions > 1
        ? `${safeFileName(card.name || `card-${ci + 1}`)}-v${v + 1}`
        : safeFileName(card.name || `card-${ci + 1}`);
    console.log(`▶ ${cardLabel}${versionLabel}`);

    if (!composePrompt(opts, card).trim()) {
      throw new Error("empty prompt — nothing to generate");
    }

    // 1. Prompt first — Flow may auto-generate the moment a reference
    //    lands in the composer, so the prompt must already be there.
    //    Detach stale chips FIRST: they survive across cards and runs (they
    //    live in flow-ingredient-bar, outside the editor the fill wipes) and
    //    Flow would render the chip's content instead of the prompt.
    const chipsBefore = await page
      .evaluate(() => window.__renderly.chipCount())
      .catch(() => 0);
    const chipsLeft = await clearChipsTrusted(page);
    if (chipsBefore > 0) {
      console.log(`  cleared ${chipsBefore - chipsLeft}/${chipsBefore} stale ingredient chip(s)`);
    }
    if (chipsLeft) {
      throw new Error(
        `composer still holds ${chipsLeft} ingredient chip(s) before filling - refusing to generate`
      );
    }
    process.stdout.write("  filling prompt… ");
    let filled = await trustedFill(page, composePrompt(opts, card));
    if (!filled) {
      await sleep(500);
      filled = await trustedFill(page, composePrompt(opts, card));
    }
    if (!filled) {
      filled = await page.evaluate((t) => window.__renderly.fillPrompt(t), composePrompt(opts, card));
    }
    console.log(filled ? "ok" : "FAILED (Flow may reuse its previous prompt)");
    if (!filled) {
      console.log("  Run `node flow.js --diag` and adjust the fill logic for your Flow build.");
    }

    // 1b. Reset the per-card observer so only URLs appearing from attach
    //     time onward register as new - sessionSeen already contains every
    //     result this session has ever saved or seen.
    await page.evaluate(() => window.__renderly.resetNewSrcs());

    // 2. References — attached on EVERY card (and every version): Flow's
    //    composer wipe (select-all + insert on each fill) also clears the
    //    ingredient chips, so they never survive from the previous card.
    const cardRefs = card.refs.filter((r) => !opts.refs.includes(r));
    // Card-specific refs win over global ones when Flow's 3-ingredient cap
    // forces a cut - they are what makes THIS image on-model.
    const pending = [...cardRefs, ...masterRefPaths].slice(0, 3);
    const cut = [...cardRefs, ...masterRefPaths].length - pending.length;
    if (cut > 0) {
      console.log(`  ⚠ ${cut} reference(s) dropped - Flow allows up to 3 per generation`);
    }
    if (pending.length) {
      console.log(`  attaching ${pending.length} reference image(s) via Flow's gallery…`);
      const res = await attachRefs(page, pending, sessionSeen);
      if (res.attached) {
        console.log(`  attached (${res.how})`);
      } else {
        // NEVER generate without the references this card asked for - a
        // missing ref silently produces the wrong image. The driver service
        // is non-interactive, so the old manual "attach then press Enter"
        // path just continued and rendered an unreferenced frame.
        if (process.stdin && process.stdin.isTTY) {
          console.log(`  ⚠ could not attach automatically: ${res.reason}`);
          console.log("    Attach them manually in Flow now, then continue.");
          await pause("  Press Enter after attaching…");
        } else {
          throw new Error(`could not attach ${pending.length} reference(s): ${res.reason}`);
        }
      }

      // The ingredient picker navigates away and can clear the composer —
      // refill the prompt if Flow dropped it.
      const still = await page
        .evaluate((t) => window.__renderly.promptIsFilled(t), composePrompt(opts, card))
        .catch(() => true);
      if (!still) {
        console.log("  prompt lost in the picker — refilling…");
        if (!(await trustedFill(page, composePrompt(opts, card)))) {
          await page.evaluate((t) => window.__renderly.fillPrompt(t), composePrompt(opts, card));
        }
      }
    }

    // 3. Trigger. ONLY Flow's own busy state counts as "already generating":
    //    a fresh flow-content URL can just be a reference plate (an echo), and
    //    treating that as a started generation made the driver skip the
    //    trigger and then stall with nothing running.
    let gen = { clicked: true, enabled: true, how: "auto" };
    let triggered = false;
    const busyRes = await page
      .evaluate(() => window.__renderly.generationBusy())
      .catch(() => null);
    if (busyRes && busyRes.busy) {
      triggered = true;
      console.log("  a generation is already running — skipping trigger");
    } else {
      for (let attempt = 1; attempt <= 4; attempt++) {
        gen = await clickGenerate(page);
        if (gen.clicked) {
          triggered = true;
          break;
        }
        // a generation may have started on its own mid-retry - never stack
        // a duplicate on top of it
        const busyNow = await page
          .evaluate(() => window.__renderly.generationBusy())
          .catch(() => null);
        if (busyNow && busyNow.busy) {
          triggered = true;
          break;
        }
        if (attempt < 4) {
          console.log(`  submit not enabled (attempt ${attempt}) — refilling prompt…`);
          if (!(await trustedFill(page, composePrompt(opts, card)))) {
            await page.evaluate((t) => window.__renderly.fillPrompt(t), composePrompt(opts, card));
          }
          await sleep(2000);
        }
      }
      if (!gen.clicked) {
        console.log(`  ⚠ no enabled Generate button (${gen.how || "none"}) — press Flow's Generate yourself.`);
        await pause("  Press Enter after triggering…");
      } else if (gen.enabled === false) {
        console.log(`  ⚠ submit stayed disabled (${gen.how}) — generation may not start.`);
      }
    }

    process.stdout.write("  waiting for Flow…");
    let waitedMs = 0;
    let src = null;
    let finalBuffer = null;
    // Ingredient-echo guard: a freshly uploaded/mounted gallery asset (a ref
    // plate) shows up as a new flow-content URL just like a real result.
    // A real generation comes in the motion-code canvas size, an echo in
    // the ref file's own size - never save an echo; trigger instead.
    const refDims = sessionRefs
      .map((p) => ({ p, d: imageDimensions(fs.readFileSync(p)) }))
      .filter((x) => x.d);
    let echoCount = 0;
    while (true) {
      const remaining = opts.timeout - waitedMs;
      if (remaining <= 0) break;
      const started = Date.now();
      src = await waitForNewImage(page, remaining, (secs) => {
        process.stdout.write(` ${Math.round((waitedMs + (Date.now() - started)) / 1000)}s`);
      }, sessionSeen);
      waitedMs += Date.now() - started;
      console.log("");
      if (!src) break;
      const dataUrl = await fetchImageDataUrl(page, src).catch(() => null);
      if (!dataUrl) { sessionSeen.add(src); src = null; continue; }
      const { buffer } = dataUrlToBuffer(dataUrl);
      const dims = imageDimensions(buffer);
      const echo = dims && refDims.some((r) => r.d.w === dims.w && r.d.h === dims.h);
      if (!echo) {
        finalBuffer = buffer;
        break;
      }
      echoCount++;
      sessionSeen.add(src);
      if (echoCount >= 2) {
        console.log("  ⚠ still receiving ingredient echoes - giving up on this card");
        break;
      }
      console.log(`  ⚠ ingredient echo detected (${dims.w}x${dims.h} matches a ref) - waiting for the real generation…`);
      const busy = await page
        .evaluate(() => window.__renderly.generationBusy())
        .catch(() => null);
      if (!busy || !busy.busy) {
        if (triggered) {
          // We already clicked Generate for this card; the echo is just the
          // reference plate landing. Keep waiting - never stack a duplicate.
          console.log("  echo before the generation registered — still waiting");
        } else {
          console.log("  no generation is running (the echo faked the trigger) - refilling the prompt and starting it now…");
          await page.evaluate((t) => window.__renderly.fillPrompt(t), composePrompt(opts, card));
          await sleep(1000);
          const g2 = await clickGenerate(page);
          if (g2.clicked) triggered = true;
          else console.log(`  ⚠ could not start the generation after the echo (${g2.how || "no button"})`);
          waitedMs = 0; // the real generation gets a full window
        }
      }
      src = null;
    }
    if (!finalBuffer) {
      if (echoCount >= 2) {
        throw new Error(`kept receiving ingredient echoes for "${cardLabel}"`);
      }
      // Forensics: what images were on the page when we gave up? If the
      // result is there at a small size, the threshold needs adjusting.
      const dump = await page.evaluate(() => window.__renderly.imageDump()).catch(() => []);
      const seen = dump
        .filter((d) => d.w > 0)
        .map((d) => `${d.w}x${d.h} ${d.src}`)
        .slice(0, 12);
      if (seen.length) console.log("  images on page at timeout:\n    " + seen.join("\n    "));
      throw new Error(`timed out waiting for the image of "${cardLabel}"`);
    }
    const filePath = uniqueFilePath(opts.out, baseName);
    fs.writeFileSync(filePath, finalBuffer);
    console.log(`  saved ${filePath}`);

    if (opts.channel) {
      const finalBase = path.basename(filePath, ".png");
      const record = await importToRenderly(
        opts.backend,
        opts.channel,
        filePath,
        finalBase,
        composePrompt(opts, card),
        opts.projectId
      );
      costUsd += record.cost_usd || 0;
      console.log(`  imported to Renderly as "${record.name}"`);

      if (opts.upscale > 0) {
        try {
          const up = await upscaleGeneration(opts.backend, record.id, opts.upscale);
          costUsd += up.cost_usd || 0;
          // Replace in place: the upscaled image keeps the exact shotlist
          // filename (S##_##_TYPE_MOTION.png) - no "-upscaled" duplicate.
          await downloadUrl(new URL(up.image_url, opts.backend).href, filePath);
          console.log(`  upscaled in place → ${up.image_size} (${path.basename(filePath)})`);
        } catch (err) {
          console.log(`  ⚠ upscale skipped: ${err.message}`);
        }
      }
    }

    console.log("");
  };

  console.log(`\nBatch: ${cards.length} card(s) × ${versions} version(s)\n`);

  for (let ci = 0; ci < cards.length; ci++) {
    for (let v = 0; v < versions; v++) {
      try {
        await runVersion(cards[ci], ci, v);
        ok++;
      } catch (err) {
        failed++;
        console.log(`  ✕ failed: ${err.message}`);
        // The failed card's generation may still be running on Flow's
        // side - wait it out and mark its result as seen so the next card
        // does not adopt it or queue a duplicate generation on top of it.
        if (!(await waitForIdle(page, 120000, sessionSeen))) {
          console.log("  ⚠ Flow still busy after the failure - continuing");
        }
      }
      await sleep(1500);
    }
  }

  console.log(
    `Batch finished — ${ok}/${cards.length * versions} succeeded` +
      (failed ? `, ${failed} failed` : "") +
      ` · $${costUsd.toFixed(2)}`
  );
  await pause("Press Enter to close the browser…");
}

main().catch((err) => {
  console.error(`\n✕ ${err.message}`);
  process.exitCode = 1;
});
