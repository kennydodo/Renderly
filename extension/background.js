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

      console.warn("Rosterly extension: unknown message type", msg && msg.type);
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
