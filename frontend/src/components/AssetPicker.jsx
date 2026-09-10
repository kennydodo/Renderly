import { useRef } from "react";

export default function AssetPicker({
  assets,
  selectedIds,
  onToggle,
  onUpload,
  onDelete,
  uploading,
  readOnly = false,
}) {
  const fileInput = useRef(null);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (file) onUpload(file);
    event.target.value = "";
  };

  return (
    <div>
      {!readOnly && (
        <div className="form-row">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFileChange}
            disabled={uploading}
          />
          {uploading && <span className="muted">Uploading…</span>}
        </div>
      )}

      {assets.length === 0 ? (
        <p className="muted">{readOnly ? "No assets in this channel." : "No assets uploaded yet."}</p>
      ) : (
        <div className="asset-grid">
          {assets.map((asset) => {
            const selected = selectedIds.includes(asset.id);
            return (
              <div key={asset.id} className={`asset-thumb${selected ? " selected" : ""}`}>
                <img
                  src={asset.url_path}
                  alt={asset.original_name}
                  title={asset.original_name}
                  onClick={() => onToggle(asset)}
                />
                {!readOnly && (
                  <button
                    className="danger tiny"
                    title="Delete asset"
                    onClick={() => onDelete(asset.id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="muted hint">Click an image to select it as a generation reference.</p>
    </div>
  );
}
