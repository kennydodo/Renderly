import { useCallback, useEffect, useState } from "react";

import { api } from "../api/client.js";

export default function Settings() {
  const [channels, setChannels] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const [hiddenItems, setHiddenItems] = useState([]);
  const [deletingAll, setDeletingAll] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [channelList, hiddenList] = await Promise.all([
        api.listChannels(),
        api.listGenerations({ hidden: "only", limit: 100 }),
      ]);
      setChannels(channelList);
      setHiddenItems(hiddenList);
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
