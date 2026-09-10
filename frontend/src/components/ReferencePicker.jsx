import { api } from "../api/client.js";
import AssetPicker from "./AssetPicker.jsx";

export default function ReferencePicker({
  channels,
  currentChannelId,
  assets,
  selectedRefs,
  onToggleRef,
  onUpload,
  onDeleteAsset,
  uploading,
  refsSource,
  setRefsSource,
  refChannelId,
  setRefChannelId,
  galleryItems,
  gallerySearch,
  setGallerySearch,
  galleryLoading,
}) {
  const selectedAssetIds = selectedRefs
    .filter((r) => r.type === "asset")
    .map((r) => r.id);
  const selectedGenerationIds = selectedRefs
    .filter((r) => r.type === "generation")
    .map((r) => r.id);

  const toggleAsset = (asset) => {
    onToggleRef({ type: "asset", id: asset.id, url: asset.url_path, label: asset.original_name });
  };

  const toggleGeneration = (generation) => {
    onToggleRef({
      type: "generation",
      id: generation.id,
      url: generation.image_url,
      label: generation.name || generation.prompt,
    });
  };

  const refChannel = channels.find((c) => String(c.id) === String(refChannelId));

  return (
    <div>
      <div className="tabs">
        <button
          type="button"
          className={`tab${refsSource === "assets" ? " active" : ""}`}
          onClick={() => setRefsSource("assets")}
        >
          Channel assets
        </button>
        <button
          type="button"
          className={`tab${refsSource === "gallery" ? " active" : ""}`}
          onClick={() => setRefsSource("gallery")}
        >
          Generated gallery
        </button>
      </div>

      {refsSource === "assets" ? (
        <>
          <div className="form-row">
            <select
              value={refChannelId}
              onChange={(e) => setRefChannelId(e.target.value)}
              title="Pick which channel's assets to browse"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {String(c.id) === String(currentChannelId) ? `${c.name} (this channel)` : c.name}
                </option>
              ))}
            </select>
          </div>
          {refChannel && (
            <AssetPicker
              assets={assets}
              selectedIds={selectedAssetIds}
              onToggle={toggleAsset}
              onUpload={onUpload}
              onDelete={onDeleteAsset}
              uploading={uploading}
              readOnly={String(refChannelId) !== String(currentChannelId)}
            />
          )}
          {refChannel &&
            String(refChannelId) !== String(currentChannelId) && (
              <p className="muted hint">
                Browsing assets of “{refChannel.name}” — read-only. Upload happens in the asset’s
                own channel.
              </p>
            )}
        </>
      ) : (
        <>
          <input
            value={gallerySearch}
            onChange={(e) => setGallerySearch(e.target.value)}
            placeholder="Search generated images by name or prompt…"
          />
          {galleryLoading ? (
            <p className="muted">Loading…</p>
          ) : galleryItems.length === 0 ? (
            <p className="muted">No generated images match.</p>
          ) : (
            <div className="gen-grid">
              {galleryItems.map((generation) => {
                const selected = selectedGenerationIds.includes(generation.id);
                return (
                  <div
                    key={generation.id}
                    className={`gen-thumb${selected ? " selected" : ""}`}
                    onClick={() => toggleGeneration(generation)}
                    title={`${generation.name || "Untitled"} — ${generation.prompt}`}
                  >
                    <img src={generation.image_url} alt={generation.prompt} loading="lazy" />
                    <span className="glabel">{generation.name || "Untitled"}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="muted hint">
            Searchable across all channels by name or prompt. Click to use as reference.
          </p>
        </>
      )}

      {selectedRefs.length > 0 && (
        <div className="ref-chips">
          {selectedRefs.map((ref) => (
            <span key={`${ref.type}-${ref.id}`} className="chip">
              <img className="thumb" src={ref.url} alt="" />
              <span className="label">{ref.label}</span>
              <button
                type="button"
                className="x"
                title="Remove reference"
                onClick={() => onToggleRef(ref)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
