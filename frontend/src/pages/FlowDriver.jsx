import { useCallback, useEffect, useRef, useState } from "react";

const DRIVER = "http://127.0.0.1:8030";

async function driverFetch(path, options) {
  const res = await fetch(`${DRIVER}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function FlowDriver() {
  const [status, setStatus] = useState(null);
  const [config, setConfigState] = useState(null);
  const [channels, setChannels] = useState([]);
  const [channelsError, setChannelsError] = useState("");
  const [projects, setProjects] = useState([]);
  const [pickPending, setPickPending] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);
  const dirtyRef = useRef(false);
  const logLength = status?.log?.length || 0;

  // Marks the form dirty so the 2.5s status poll never overwrites
  // unsaved edits (dialog picks or typing).
  const setConfig = (next) => {
    dirtyRef.current = true;
    setDirty(true);
    setConfigState((prev) => (typeof next === "function" ? next(prev) : next));
  };

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await driverFetch("/api/status"));
      setError("");
    } catch {
      setError(
        "Flow driver service not reachable — start it with start.bat (Flow Driver window) or driver.bat.",
      );
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await driverFetch("/api/config");
      dirtyRef.current = false;
      setDirty(false);
      setConfigState(cfg);
    } catch {
      /* status poll shows the service error */
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadConfig();
    const timer = setInterval(loadStatus, 2500);
    return () => clearInterval(timer);
  }, [loadStatus, loadConfig]);

  const loadChannels = useCallback(async () => {
    try {
      const list = await driverFetch("/api/channels");
      setChannels(list);
      setChannelsError("");
      // Self-heal: a saved channel that no longer exists on this machine
      // (fresh install, renamed channel) would fail at Start - fall back to
      // the first available one so the batch just works.
      setConfigState((cfg) => {
        if (!cfg || !list.length) return cfg;
        if (list.some((c) => c.name === cfg.channel)) return cfg;
        return { ...cfg, channel: list[0].name, project: "" };
      });
    } catch (err) {
      setChannelsError(err.message);
    }
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // Load the projects of the selected channel and self-heal a stale project.
  useEffect(() => {
    if (!channels.length || !(config?.channel || "").trim()) return;
    let cancelled = false;
    driverFetch(
      `/api/projects?channel=${encodeURIComponent(config.channel)}`,
    )
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setConfigState((cfg) => {
          if (!cfg) return cfg;
          if (!cfg.project && !list.length) return cfg;
          if (list.some((p) => String(p.id) === String(cfg.project))) return cfg;
          return { ...cfg, project: list[0] ? String(list[0].id) : "" };
        });
      })
      .catch(() => setProjects([]));
    return () => {
      cancelled = true;
    };
  }, [channels, config?.channel]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLength]);

  const saveConfig = async (silent) => {
    await driverFetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    dirtyRef.current = false;
    setDirty(false);
    if (!silent) setError("");
  };

  const start = async () => {
    setBusy(true);
    try {
      // Auto-save before launching so unsaved picks are never lost.
      await saveConfig(true);
      await driverFetch("/api/start", { method: "POST" });
      setError("");
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await driverFetch("/api/stop", { method: "POST" });
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Opens a REAL Windows dialog via the driver service (a page can never
  // get true filesystem paths, but the local service can).
  const browse = async (kind) => {
    if (pickPending) return;
    setPickPending(kind);
    try {
      const { paths } = await driverFetch(`/api/pick/${kind}`, { method: "POST" });
      if (!paths || !paths.length) return; // user cancelled
      setConfig((cfg) => {
        if (kind === "shotlist") return { ...cfg, shotlistPath: paths[0] };
        if (kind === "refs") return { ...cfg, refs: paths.join(",") };
        if (kind === "output") return { ...cfg, outPath: paths[0] };
        return cfg;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setPickPending(null);
    }
  };

  const running = status?.running;
  const counts = status?.counts || { ok: 0, failed: 0, total: 0 };

  const label = (text) => (
    <span className="muted small" style={{ display: "block", marginBottom: "4px" }}>
      {text}
    </span>
  );

  const pathRow = (key, placeholder, kind, buttonLabel) => (
    <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
      <div style={{ flex: 1 }}>
        <input
          type="text"
          value={config[key] || ""}
          placeholder={placeholder}
          onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
          style={{ width: "100%" }}
        />
      </div>
      <button className="ghost" onClick={() => browse(kind)} disabled={!!pickPending || busy}>
        {pickPending === kind ? "Pick in dialog…" : buttonLabel}
      </button>
    </div>
  );

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <h1>Flow Driver</h1>
        {status && (
          <span className={running ? "small" : "muted small"}>
            {running ? "● RUNNING" : "○ idle"}
            {running && status.currentCard ? ` — ${status.currentCard}` : ""}
          </span>
        )}
        {dirty && <span className="small">● unsaved changes</span>}
      </div>
      <p className="muted">
        Batch-generate images on Google Flow with automatic reference attachment and import
        them into Renderly. Runs the Playwright driver on this machine — no API key involved.
      </p>

      {error && <p className="error">{error}</p>}

      {config && (
        <div className="card" style={{ maxWidth: "820px" }}>
          <h2>Configuration</h2>

          {label("Shotlist file (read from)")}
          {pathRow("shotlistPath", "D:\\…\\shotlist.json", "shotlist", "Browse…")}

          <div style={{ height: "10px" }} />

          {label("Images are saved to")}
          {pathRow("outPath", "same folder as the driver if empty", "output", "Browse…")}

          <div style={{ height: "10px" }} />

          {label("Renderly channel")}
          {channels.length ? (
            <select
              value={config.channel || ""}
              onChange={(e) => setConfig({ ...config, channel: e.target.value })}
              style={{ width: "100%" }}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={config.channel || ""}
              onChange={(e) => setConfig({ ...config, channel: e.target.value })}
              style={{ width: "100%" }}
            />
          )}
          {channelsError && (
            <p className="muted small">
              {channelsError} — type the channel name manually or start the backend.
            </p>
          )}

          <div style={{ height: "10px" }} />

          {label("Project (imports land in this project)")}
          {projects.length ? (
            <select
              value={config.project || ""}
              onChange={(e) => setConfig({ ...config, project: e.target.value })}
              style={{ width: "100%" }}
            >
              <option value="">Channel default (Unsorted)</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={config.project || ""}
              placeholder="Project id (optional — blank = channel default)"
              onChange={(e) => setConfig({ ...config, project: e.target.value })}
              style={{ width: "100%" }}
            />
          )}

          <div style={{ height: "10px" }} />

          {label("Reference images (comma-separated; same refs for every image)")}
          {pathRow("refs", "D:\\…\\ref1.webp,D:\\…\\ref2.webp", "refs", "Browse…")}

          <div style={{ height: "10px" }} />

          {label("Master prompt (style prefix; optional — the shotlist style is used otherwise)")}
          <textarea
            value={config.master || ""}
            rows={3}
            onChange={(e) => setConfig({ ...config, master: e.target.value })}
            style={{ width: "100%" }}
          />

          <div style={{ height: "10px" }} />

          {label("Upscale factor (0 = off)")}
          <input
            type="number"
            min="0"
            max="4"
            value={config.upscale ?? 2}
            onChange={(e) => setConfig({ ...config, upscale: Number(e.target.value) })}
          />

          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button onClick={saveConfig} disabled={busy}>
              Save configuration
            </button>
            <button onClick={start} disabled={busy || running}>
              {dirty ? "Save & start batch" : "Start batch"}
            </button>
            <button className="danger" onClick={stop} disabled={busy || !running}>
              Stop batch
            </button>
          </div>
          <p className="muted small">
            The Renderly backend must be running for imports (start.bat). Browse buttons open a
            real Windows dialog via the driver service — pick files/folders there. Starting the
            batch saves the configuration automatically.
          </p>
        </div>
      )}

      <div className="card" style={{ maxWidth: "980px", marginTop: "16px" }}>
        <div style={{ display: "flex", gap: "18px", alignItems: "baseline" }}>
          <h2 style={{ marginBottom: "0" }}>Run log</h2>
          <span className="muted small">
            {counts.ok}/{counts.total || "?"} imported · {counts.failed} failed
          </span>
        </div>
        <pre
          ref={logRef}
          className="muted small"
          style={{
            background: "#111418",
            color: "#c8d0d8",
            padding: "12px",
            borderRadius: "8px",
            maxHeight: "420px",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            marginTop: "10px",
          }}
        >
          {status && status.log.length ? status.log.join("\n") : "No run yet."}
        </pre>
      </div>
    </section>
  );
}
