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
      if (byAria && !byAria.disabled) return { clicked: true, how: describeEl(byAria) };
      const byText = buttons.find(
        (b) => /generate|create|render|send|submit/i.test(b.textContent || "") && !b.disabled
      );
      if (byText) return { clicked: true, how: describeEl(byText) };
      const submit = buttons.find((b) => b.getAttribute("type") === "submit" && !b.disabled);
      if (submit) return { clicked: true, how: describeEl(submit) };
      return { clicked: false, how: null };
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

    H.hasIngredientChip = () =>
      deepQueryAll('[aria-label="Ingredient"]').filter(isVisible).length > 0;

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

async function waitForNewImage(page, beforeSet, timeoutMs, onTick) {
  const started = Date.now();
  const STABLE_MS = 5000;
  const STABLE_MS_ANY = 20000;
  let tick = 0;
  let candidate = null;
  let candidateSince = 0;
  let blockLogged = false;
  while (Date.now() - started < timeoutMs) {
    let fresh = (await page.evaluate(() => window.__renderly.takeNewSrcs())).filter(
      (s) => !beforeSet.has(s)
    );
    // Full-DOM sweep every ~3s: catches src swaps on reused tiles and
    // anything the observer missed. Cheap enough at this interval.
    if (!fresh.length && ++tick % 2 === 0) {
      const all = await page.evaluate(() => window.__renderly.collectImages());
      fresh = all.filter((s) => !beforeSet.has(s));
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
  return candidate;
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

async function importToRenderly(backend, channelId, filePath, name, prompt) {
  const form = new FormData();
  // Explicit MIME type — the backend rejects parts without image/* (415).
  form.append(
    "file",
    new Blob([fs.readFileSync(filePath)], { type: mimeOf(filePath) }),
    path.basename(filePath)
  );
  form.append("prompt", prompt || "Generated in Google Flow");
  if (name) form.append("name", name);
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

/**
 * Attach reference images as Flow ingredients:
 *  1. ensure every ref exists in Flow's gallery (upload via drop — the
 *     global drop handler uploads files; tiles get the filename as label)
 *  2. open the ingredient picker ("Add ingredients to the prompt box")
 *  3. click the gallery tiles matching the ref filenames, then "Done editing"
 *  4. verify the Ingredient chip is present in the composer
 */
async function attachRefs(page, refPaths) {
  const names = refPaths.map((p) => path.basename(p));
  const labelHas = (labelList, name) =>
    labelList.some((l) => l.toLowerCase() === name.toLowerCase());

  const labels = await page.evaluate(() => window.__renderly.galleryLabels()).catch(() => []);
  let missing = refPaths.filter((p) => !labelHas(labels, path.basename(p)));
  // The grid hydrates lazily — give the tiles a moment before deciding
  // anything is missing, otherwise refs get uploaded twice.
  if (missing.length) {
    const gridDeadline = Date.now() + 15000;
    while (Date.now() < gridDeadline) {
      const nowLabels = await page
        .evaluate(() => window.__renderly.galleryLabels())
        .catch(() => []);
      if (nowLabels.length) {
        missing = refPaths.filter((p) => !labelHas(nowLabels, path.basename(p)));
        break;
      }
      await sleep(1000);
    }
  }
  if (missing.length) {
    console.log(`  uploading ${missing.length} ref(s) to Flow's gallery via drop…`);
    const payloads = missing.map((p) => ({
      name: path.basename(p),
      mime: mimeOf(p),
      b64: fs.readFileSync(p).toString("base64"),
    }));
    const up = await page.evaluate((pls) => window.__renderly.dropFiles(pls), payloads);
    if (!up.ok) return { attached: false, reason: up.reason };
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      const nowLabels = await page
        .evaluate(() => window.__renderly.galleryLabels())
        .catch(() => []);
      if (names.every((n) => labelHas(nowLabels, n))) {
        ready = true;
        break;
      }
      await sleep(1500);
    }
    if (!ready) return { attached: false, reason: "gallery tiles never appeared after upload" };
  }

  // Open the ingredient panel ("Add assets to the project" dialog), click the
  // options matching the ref filenames, then close the dialog. Flow attaches
  // immediately on selection; older builds showed an "Add to prompt" confirm.
  const addBtn = page
    .getByRole("button", { name: "Add ingredients to the prompt box" })
    .first();
  // A panel left open by a previous failed card swallows the click
  // (overlay intercepts pointer events) - close it first.
  if ((await addBtn.getAttribute("aria-expanded").catch(() => null)) === "true") {
    await addBtn.click({ timeout: 10000 }).catch(() => {});
    await sleep(1200);
  }
  await addBtn.click({ timeout: 20000 });
  const addPromptBtn = page.getByRole("button", { name: "Add to prompt" }).first();
  const hasConfirm = await addPromptBtn
    .waitFor({ timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  const search = page.getByRole("textbox", { name: "Search assets" }).first();
  await search.waitFor({ timeout: 10000 }).catch(() => {});

  let selected = 0;
  for (const name of names) {
    try {
      // Filter the virtual-scrolled asset list to this ref before clicking -
      // otherwise the tile under the locator can be recycled to another
      // asset between resolve and click (wrong ref attached).
      if (await search.isVisible().catch(() => false)) {
        await search.fill("");
        await search.fill(name);
        await sleep(800);
      }
      await page.getByRole("option", { name }).first().click({ timeout: 10000 });
      selected++;
      await sleep(400);
    } catch {
      console.log(`  ⚠ gallery option not found: ${name}`);
    }
  }
  if (await search.isVisible().catch(() => false)) {
    await search.fill("").catch(() => {});
  }
  if (!selected) {
    return { attached: false, reason: "no matching options in the ingredient panel" };
  }

  // Some Flow builds attach immediately on selection and close the panel;
  // others wait for "Add to prompt". Handle both.
  if (hasConfirm) {
    const stillOpen = await addPromptBtn.isVisible().catch(() => false);
    if (stillOpen) {
      await addPromptBtn.click({ timeout: 10000 });
    }
  }

  // Close the dialog promptly - a leftover overlay blocks every later card.
  await sleep(500);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(600);
  const closeBtn = page.getByRole("button", { name: "Close" }).first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ timeout: 4000 }).catch(() => {});
    await sleep(600);
  }

  let chip = await page.evaluate(() => window.__renderly.hasIngredientChip()).catch(() => false);
  return { attached: !!chip || !hasConfirm, how: `panel: ${selected} selected` };
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
          composePrompt(opts, card)
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
    process.stdout.write("  filling prompt… ");
    let filled = await page.evaluate((t) => window.__renderly.fillPrompt(t), composePrompt(opts, card));
    if (!filled) {
      await sleep(500);
      filled = await page.evaluate((t) => window.__renderly.fillPrompt(t), composePrompt(opts, card));
    }
    console.log(filled ? "ok" : "FAILED (Flow may reuse its previous prompt)");
    if (!filled) {
      console.log("  Run `node flow.js --diag` and adjust the fill logic for your Flow build.");
    }

    // 2. References — attached on EVERY card (and every version): Flow's
    //    composer wipe (select-all + insert on each fill) also clears the
    //    ingredient chips, so they never survive from the previous card.
    const cardRefs = card.refs.filter((r) => !opts.refs.includes(r));
    const pending = [...masterRefPaths, ...cardRefs];
    if (pending.length) {
      console.log(`  attaching ${pending.length} reference image(s) via Flow's gallery…`);
      const res = await attachRefs(page, pending);
      if (res.attached) {
        console.log(`  attached (${res.how})`);
      } else {
        console.log(`  ⚠ could not attach automatically: ${res.reason}`);
        console.log("    Attach them manually in Flow now, then continue.");
        await pause("  Press Enter after attaching…");
      }

      // The ingredient picker navigates away and can clear the composer —
      // refill the prompt if Flow dropped it.
      const still = await page
        .evaluate((t) => window.__renderly.promptIsFilled(t), composePrompt(opts, card))
        .catch(() => true);
      if (!still) {
        console.log("  prompt lost in the picker — refilling…");
        await page.evaluate((t) => window.__renderly.fillPrompt(t), composePrompt(opts, card));
      }
    }

    // 3. Snapshot, then trigger (or catch an auto-generation).
    const beforeSet = new Set(await page.evaluate(() => window.__renderly.collectImages()));
    await page.evaluate(() => window.__renderly.resetNewSrcs());
    const gen = await page.evaluate(() => window.__renderly.triggerGenerate());
    if (!gen.clicked) {
      console.log("  ⚠ no Generate button found — press Flow's Generate yourself.");
      await pause("  Press Enter after triggering…");
    }

    process.stdout.write("  waiting for Flow…");
    const src = await waitForNewImage(page, beforeSet, opts.timeout, (secs) =>
      process.stdout.write(` ${secs}s`)
    );
    console.log("");
    if (!src) {
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

    // 4. Fetch the result, save locally, import to Renderly.
    const dataUrl = await fetchImageDataUrl(page, src);
    const { buffer } = dataUrlToBuffer(dataUrl);
    const filePath = uniqueFilePath(opts.out, baseName);
    fs.writeFileSync(filePath, buffer);
    console.log(`  saved ${filePath}`);

    if (opts.channel) {
      const finalBase = path.basename(filePath, ".png");
      const record = await importToRenderly(
        opts.backend,
        opts.channel,
        filePath,
        finalBase,
        composePrompt(opts, card)
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
