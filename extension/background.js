const DEFAULT_BACKEND = "http://127.0.0.1:8022";

async function getBackend() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  return (backendUrl || DEFAULT_BACKEND).replace(/\/+$/, "");
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image data"));
    reader.readAsDataURL(blob);
  });
}

/* ================= trusted input (DevTools protocol) ================= */

// Flow's Angular composer ignores programmatic edits: the text lands in the DOM
// but the submit arrow never arms, so a synthetic click has nothing to fire.
// Replaying the fill + click over the DevTools protocol produces the trusted
// input Flow actually listens for.
const debuggerTabs = new Set();

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function attachDebugger(tabId) {
  if (debuggerTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerTabs.add(tabId);
}

async function detachDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* tab or session already gone */
  }
  debuggerTabs.delete(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => debuggerTabs.delete(tabId));
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId !== undefined) debuggerTabs.delete(source.tabId);
});

async function trustedFill(tabId, msg) {
  await attachDebugger(tabId);
  await clickPoint(tabId, msg.composer);
  await pause(150);
  // Clear whatever the synthetic fill left behind, then type it properly.
  await pressKey(tabId, "keyDown", "a", "KeyA", 65, 2);
  await pressKey(tabId, "keyUp", "a", "KeyA", 65, 2);
  await pressKey(tabId, "keyDown", "Delete", "Delete", 46);
  await pressKey(tabId, "keyUp", "Delete", "Delete", 46);
  await pause(100);
  await cdp(tabId, "Input.insertText", { text: msg.text });
  return { ok: true };
}

async function trustedClick(tabId, msg) {
  await attachDebugger(tabId);
  await clickPoint(tabId, msg.button);
  return { ok: true, clicked: true };
}

async function clickPoint(tabId, point) {
  const params = {
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: "left",
    clickCount: 1,
  };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...params });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...params });
}

function pressKey(tabId, type, keyName, code, vk, modifiers = 0) {
  return cdp(tabId, "Input.dispatchKeyEvent", {
    type,
    modifiers,
    key: keyName,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "getBackend") {
        sendResponse({ ok: true, backend: await getBackend() });
        return;
      }

      if (msg.type === "api") {
        const backend = await getBackend();
        const init = { method: msg.method || "GET", headers: {} };
        if (msg.body !== undefined) {
          init.body = JSON.stringify(msg.body);
          init.headers["Content-Type"] = "application/json";
        }
        const res = await fetch(`${backend}${msg.path}`, init);
        sendResponse({ ok: res.ok, status: res.status, data: await readJson(res) });
        return;
      }

      if (msg.type === "fetchImage") {
        const backend = await getBackend();
        // Accept relative /storage/... paths and resolve against the backend
        const url = new URL(msg.url, backend).href;
        const res = await fetch(url);
        if (!res.ok) {
          sendResponse({ ok: false, error: `Image fetch failed (${res.status})` });
          return;
        }
        const blob = await res.blob();
        let outBlob = blob;
        if (blob.type !== "image/png") {
          // Clipboard image writes are most reliable as PNG
          const bmp = await createImageBitmap(blob);
          const canvas = new OffscreenCanvas(bmp.width, bmp.height);
          canvas.getContext("2d").drawImage(bmp, 0, 0);
          outBlob = await canvas.convertToBlob({ type: "image/png" });
        }
        sendResponse({ ok: true, dataUrl: await blobToDataUrl(outBlob) });
        return;
      }

      if (msg.type === "thumb") {
        const backend = await getBackend();
        const url = new URL(msg.url, backend).href;
        const res = await fetch(url);
        if (!res.ok) {
          sendResponse({ ok: false, error: `Thumb fetch failed (${res.status})` });
          return;
        }
        sendResponse({ ok: true, dataUrl: await blobToDataUrl(await res.blob()) });
        return;
      }

      if (msg.type === "uploadAsset" || msg.type === "importGeneration") {
        const backend = await getBackend();
        const blob = await (await fetch(msg.dataUrl)).blob();
        const form = new FormData();
        form.append("file", blob, msg.filename || "flow-image.png");
        if (msg.type === "importGeneration") {
          form.append("prompt", msg.prompt || "Imported from Google Flow");
          if (msg.name) form.append("name", msg.name);
          const res = await fetch(`${backend}/api/channels/${msg.channelId}/import`, {
            method: "POST",
            body: form,
          });
          sendResponse({ ok: res.ok, status: res.status, data: await readJson(res) });
          return;
        }
        const res = await fetch(`${backend}/api/channels/${msg.channelId}/assets`, {
          method: "POST",
          body: form,
        });
        sendResponse({ ok: res.ok, status: res.status, data: await readJson(res) });
        return;
      }

      if (msg.type === "trustedFill") {
        const tab = sender && sender.tab;
        if (!tab || tab.id === undefined) {
          sendResponse({ ok: false, error: "No tab for trusted input" });
          return;
        }
        sendResponse(await trustedFill(tab.id, msg));
        return;
      }

      if (msg.type === "trustedClick") {
        const tab = sender && sender.tab;
        if (!tab || tab.id === undefined) {
          sendResponse({ ok: false, error: "No tab for trusted input" });
          return;
        }
        sendResponse(await trustedClick(tab.id, msg));
        return;
      }

      if (msg.type === "detachDebugger") {
        const tab = sender && sender.tab;
        if (tab && tab.id !== undefined) await detachDebugger(tab.id);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "focusPage") {
        // Programmatic prompt insertion fails while the window is unfocused.
        const tab = sender && sender.tab;
        if (tab && tab.windowId !== undefined) {
          try {
            await chrome.windows.update(tab.windowId, { focused: true });
          } catch {
            /* window may be gone */
          }
        }
        if (tab && tab.id !== undefined) {
          try {
            await chrome.tabs.update(tab.id, { active: true });
          } catch {
            /* ignore */
          }
        }
        sendResponse({ ok: true });
        return;
      }

      console.warn("Renderly extension: unknown message type", msg && msg.type);
      sendResponse({ ok: false, error: `Unknown message type: ${msg && msg.type}` });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  })();
  return true;
});

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      if (chrome.runtime.lastError) {
        void chrome.runtime.lastError;
        resolve(null);
      } else {
        resolve(res);
      }
    });
  });
}

// Toolbar icon toggles the dock on the active Flow tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (
    !tab?.id ||
    !tab.url ||
    !(
      tab.url.startsWith("https://flow.google.com") ||
      tab.url.startsWith("https://labs.google/fx")
    )
  ) {
    return;
  }
  let res = await sendToTab(tab.id, { type: "toggleDock" });
  if (res) return;

  // Content script not loaded (stale tab) — inject it and retry.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await new Promise((r) => setTimeout(r, 300));
    await sendToTab(tab.id, { type: "toggleDock" });
  } catch {
    /* page not injectable — nothing to do */
  }
});
