const backendInput = document.getElementById("backend");
const channelSelect = document.getElementById("channel");
const autoDock = document.getElementById("autoDock");
const statusEl = document.getElementById("status");

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#f28b82" : "#9aa0a6";
}

async function getBackend() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  return (backendUrl || "http://127.0.0.1:8022").replace(/\/+$/, "");
}

async function loadChannels() {
  channelSelect.innerHTML = "";
  try {
    const backend = backendInput.value.trim().replace(/\/+$/, "") || "http://127.0.0.1:8022";
    const res = await fetch(`${backend}/api/channels`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const channels = await res.json();
    if (!channels.length) {
      const opt = document.createElement("option");
      opt.textContent = "No channels yet";
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
    setStatus(`Found ${channels.length} channel(s).`);
  } catch (err) {
    setStatus(`Backend unreachable: ${err.message}`, true);
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const url = backendInput.value.trim().replace(/\/+$/, "") || "http://127.0.0.1:8022";
  await chrome.storage.local.set({
    backendUrl: url,
    channelId: channelSelect.value || null,
    autoDock: autoDock.checked,
  });
  setStatus("Settings saved.");
});

document.getElementById("inject").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab.", true);
    return;
  }
  if (
    !tab.url ||
    !(tab.url.startsWith("https://flow.google.com") || tab.url.startsWith("https://labs.google/fx"))
  ) {
    setStatus(
      "This button works on Google Flow tabs only — open flow.google.com or labs.google/fx/tools/flow.",
      true,
    );
    return;
  }

  const tryMessage = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "injectDock" }, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });

  setStatus("Connecting to page…");
  let res = await tryMessage();

  if (!res) {
    // Stale or missing content script - inject it programmatically and retry.
    setStatus("Injecting content script…");
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 400));
      res = await tryMessage();
    } catch (err) {
      setStatus(`Injection failed: ${err.message}`, true);
      return;
    }
  }

  setStatus(
    res && res.injected
      ? "Dock is visible on the page."
      : "Could not show the dock — reload the Flow page and try again.",
    !(res && res.injected),
  );
});

(async () => {
  const { backendUrl, autoDockSetting } = await chrome.storage.local.get([
    "backendUrl",
    "autoDock",
  ]);
  backendInput.value = backendUrl || "http://127.0.0.1:8022";
  autoDock.checked = autoDockSetting !== false;
  await loadChannels();
})();
