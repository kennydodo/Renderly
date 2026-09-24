import { useCallback, useEffect, useState } from "react";

import { api } from "../api/client.js";

export default function Settings() {
  const [channels, setChannels] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const [hiddenItems, setHiddenItems] = useState([]);
  const [deletingAll, setDeletingAll] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [genSettings, setGenSettings] = useState(null);
  const [savingGen, setSavingGen] = useState(false);
  const [genSaved, setGenSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [channelList, hiddenList, gen] = await Promise.all([
        api.listChannels(),
        api.listGenerations({ hidden: "only", limit: 100 }),
        api.getSettings(),
      ]);
      setChannels(channelList);
      setHiddenItems(hiddenList);
      setGenSettings(gen);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveGenSettings = async () => {
    setSavingGen(true);
    setGenSaved(false);
    try {
      const saved = await api.updateSettings({
        upscale_level: genSettings.upscale_level,
        auto_download: genSettings.auto_download,
        download_dir: genSettings.download_dir,
      });
      setGenSettings(saved);
      setGenSaved(true);
      setTimeout(() => setGenSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingGen(false);
    }
  };

  const doRemove = async (channel) => {
    try {
      await api.deleteChannel(channel.id);
      setRemovingId(null);
      await load();
    } catch (err) {
      setError(err.message);
      setRemovingId(null);
    }
  };

  const restoreHidden = async (id) => {
    try {
      await api.patchGeneration(id, { hidden: false });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const purgeHidden = async (id) => {
    if (
      !window.confirm(
        "Permanently delete this image from the database and disk? This cannot be undone.",
      )
    )
      return;
    try {
      await api.deleteGeneration(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteAllHidden = async () => {
    if (
      !window.confirm(
        `Permanently delete ALL ${hiddenItems.length} hidden image(s) from the database and disk? This cannot be undone.`,
      )
    )
      return;
    setDeletingAll(true);
    try {
      // Delete in passes — the listing is capped at 100 per call, so large
      // cleanups continue until nothing is hidden anymore.
      for (;;) {
        const batch = await api.listGenerations({ hidden: "only", limit: 100 });
        if (!batch.length) break;
        await Promise.all(batch.map((item) => api.deleteGeneration(item.id)));
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingAll(false);
    }
  };

  return (
    <section>
      <h1>Settings</h1>
      <p className="muted">
        Manage channels here. Removing a channel permanently deletes its assets and all
        generated images.
      </p>

      {genSettings && (
        <div className="card" style={{ maxWidth: "720px", marginBottom: "18px" }}>
          <h2>Generation defaults</h2>
          <div className="form-row" style={{ alignItems: "center" }}>
            <label style={{ minWidth: "140px" }}>Resolution</label>
            <select
              value={genSettings.upscale_level}
              onChange={(e) =>
                setGenSettings({ ...genSettings, upscale_level: Number(e.target.value) })
              }
            >
              <option value={0}>Off — keep native size</option>
              <option value={1}>1920 × 1080 (HD)</option>
              <option value={2}>2560 × 1440 (2K)</option>
              <option value={3}>3840 × 2160 (4K)</option>
            </select>
          </div>
          <div className="form-row" style={{ alignItems: "center" }}>
            <label style={{ minWidth: "140px" }}>Auto download</label>
            <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={!!genSettings.auto_download}
                onChange={(e) =>
                  setGenSettings({ ...genSettings, auto_download: e.target.checked })
                }
              />
              <span className="muted small">
                Save every finished image to the download folder automatically
              </span>
            </label>
          </div>
          <div className="form-row" style={{ alignItems: "center" }}>
            <label style={{ minWidth: "140px" }}>Download folder</label>
            <input
              type="text"
              style={{ flex: 1 }}
              value={genSettings.download_dir || ""}
              placeholder="e.g. E:\YOUTUBE — images land in <folder>\<channel name>"
              onChange={(e) =>
                setGenSettings({ ...genSettings, download_dir: e.target.value })
              }
            />
          </div>
          <div className="form-row">
            <button onClick={saveGenSettings} disabled={savingGen}>
              {savingGen ? "Saving…" : genSaved ? "Saved ✓" : "Save generation defaults"}
            </button>
            <span className="muted small">
              Applies to new generations: auto-upscale runs first, then auto-download.
            </span>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : channels.length === 0 ? (
        <p className="muted">No channels yet.</p>
      ) : (
        <div className="settings-list">
          {channels.map((channel) => (
            <div key={channel.id} className="card settings-row">
              <div className="settings-info">
                <h2>{channel.name}</h2>
                <p className="muted">{channel.description || "No description"}</p>
              </div>
              {removingId === channel.id ? (
                <div className="confirm-row">
                  <span className="muted small">Delete all assets and images?</span>
                  <button className="danger small" onClick={() => doRemove(channel)}>
                    Yes, remove
                  </button>
                  <button className="ghost small" onClick={() => setRemovingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="danger" onClick={() => setRemovingId(channel.id)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <h2>Hidden images ({hiddenItems.length})</h2>
        {hiddenItems.length > 0 && (
          <button className="danger" onClick={deleteAllHidden} disabled={deletingAll}>
            {deletingAll ? "Deleting…" : "Delete all hidden"}
          </button>
        )}
      </div>
      <p className="muted">
        Failed generations land here automatically. Successful images you removed from the
        gallery live here too — restore them or delete them permanently.
      </p>
      {hiddenItems.length === 0 ? (
        <p className="muted">Nothing hidden.</p>
      ) : (
        <div className="hidden-grid">
          {hiddenItems.map((item) => (
            <div key={item.id} className="hidden-item">
              {item.status === "done" && item.image_url ? (
                <img src={item.image_url} alt={item.name} loading="lazy" />
              ) : (
                <div className="hidden-failed">
                  <span className="error small">Failed</span>
                </div>
              )}
              <div className="row">
                {item.status === "done" && (
                  <button onClick={() => restoreHidden(item.id)}>Restore</button>
                )}
                <button className="danger" onClick={() => purgeHidden(item.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
