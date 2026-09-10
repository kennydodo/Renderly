import { useEffect, useState } from "react";

import { api } from "../api/client.js";

export default function ReferenceMiniPicker({
  onPick,
  initialAssetIds,
  initialGenerationIds,
  currentChannelId,
}) {
  const [channels, setChannels] = useState([]);
  const [channelId, setChannelId] = useState("");
  const [assets, setAssets] = useState([]);
  const [assetIds, setAssetIds] = useState(initialAssetIds);
  const [generationIds, setGenerationIds] = useState(initialGenerationIds);
  const [gallery, setGallery] = useState([]);
  const [gallerySearch, setGallerySearch] = useState("");
  const [tab, setTab] = useState("assets");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .listChannels()
      .then((list) => {
        setChannels(list);
        const preferred = currentChannelId != null ? String(currentChannelId) : null;
        const match = list.find((c) => String(c.id) === preferred);
        setChannelId(String((match || list[0]).id));
      })
      .catch((err) => setError(err.message));
  }, [currentChannelId]);

  useEffect(() => {
    if (!channelId) return;
    api
      .listAssets(channelId)
      .then(setAssets)
      .catch((err) => setError(err.message));
  }, [channelId]);

  useEffect(() => {
    if (tab !== "gallery") return;
    const timer = setTimeout(async () => {
      try {
        setGallery(
          await api.listGenerations({
            search: gallerySearch || undefined,
            status: "done",
            limit: 30,
          }),
        );
      } catch (err) {
        setError(err.message);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [tab, gallerySearch]);

  const handleUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0 || !channelId) return;
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of files) {
        uploaded.push(await api.uploadAsset(channelId, file));
      }
      setAssets((list) => [...uploaded, ...list]);
      const next = [...assetIds, ...uploaded.map((a) => a.id)];
      setAssetIds(next);
      onPick({ assetIds: next, generationIds });
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const toggleAndEmit = (type, id) => {
    if (type === "asset") {
      const next = assetIds.includes(id) ? assetIds.filter((x) => x !== id) : [...assetIds, id];
      setAssetIds(next);
      onPick({ assetIds: next, generationIds });
    } else {
      const next = generationIds.includes(id)
        ? generationIds.filter((x) => x !== id)
        : [...generationIds, id];
      setGenerationIds(next);
      onPick({ assetIds, generationIds: next });
    }
  };

  return (
    <div className="mini-picker">
      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === "assets" ? " active" : ""}`}
          onClick={() => setTab("assets")}
        >
          Assets
        </button>
        <button
          type="button"
          className={`tab${tab === "gallery" ? " active" : ""}`}
          onClick={() => setTab("gallery")}
        >
          Gallery
        </button>
      </div>

      {error && <p className="error small">{error}</p>}

      {tab === "assets" ? (
        <>
          <div className="form-row">
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className="mini-channel-select"
              title="Channel the uploaded images go to"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <label className="mini-upload">
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={handleUpload}
              disabled={uploading}
            />
            <span className="muted tiny-hint">
              {uploading
                ? "Uploading…"
                : "Pick image(s) from your PC — they upload to the channel and attach to this prompt."}
            </span>
          </label>
          {assets.length === 0 ? (
            <p className="muted tiny-hint">No assets in this channel yet.</p>
          ) : (
            <div className="mini-grid">
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className={`mini-thumb${assetIds.includes(asset.id) ? " selected" : ""}`}
                  onClick={() => toggleAndEmit("asset", asset.id)}
                  title={asset.original_name}
                >
                  <img src={asset.url_path} alt="" loading="lazy" />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <input
            value={gallerySearch}
            onChange={(e) => setGallerySearch(e.target.value)}
            placeholder="Search generated images…"
          />
          {gallery.length === 0 ? (
            <p className="muted tiny-hint">Nothing matches.</p>
          ) : (
            <div className="mini-grid">
              {gallery.map((generation) => (
                <div
                  key={generation.id}
                  className={`mini-thumb${generationIds.includes(generation.id) ? " selected" : ""}`}
                  onClick={() => toggleAndEmit("generation", generation.id)}
                  title={generation.name || generation.prompt}
                >
                  <img src={generation.image_url} alt="" loading="lazy" />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
