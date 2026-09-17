import { useEffect, useState } from "react";

import { api } from "../api/client.js";

export default function ImageCard({
  generation,
  channels,
  selected,
  onSelect,
  onRename,
  onSaveToChannel,
  onRegenerate,
  onRetry,
  onDelete,
  onHide,
  onUpscale,
  onSetCategory,
}) {
  const [lightbox, setLightbox] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(generation.name);
  const [saveOpen, setSaveOpen] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState(null);
  const [regenDraft, setRegenDraft] = useState("");
  const [upscaling, setUpscaling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDraftName(generation.name);
  }, [generation.name]);

  useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setLightbox(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const created = new Date(generation.created_at + "Z").toLocaleString();
  const isDone = generation.status === "done" && generation.image_url;
  const statusClass = isDone ? "done" : generation.status;
  const displayName = generation.name || `generation-${generation.id}`;
  // Clean download name: strip the stored ".png" suffix and the " (4x)"
  // marker from upscaled copies — matches the extension's naming.
  const downloadName = `${(displayName || `generation-${generation.id}`)
    .replace(/\.(png|jpe?g|webp)$/i, "")
    .replace(/\s*\(\d+x\)\s*/i, "")
    .trim()}.png`;
  const sizeLabel = { "1K": "720p", "2K": "1080p", "4K": "4K" }[generation.image_size] || generation.image_size;

  const commitRename = () => {
    setEditing(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== generation.name) onRename(generation.id, trimmed);
    else setDraftName(generation.name);
  };

  const startRegenerate = () => {
    if (!onRegenerate || regenBusy) return;
    setRegenDraft(generation.prompt);
    setRegenPrompt(generation.id);
  };

  const submitRegenerate = async () => {
    if (!onRegenerate || regenBusy) return;
    setRegenBusy(true);
    try {
      await onRegenerate(generation.id, {
        prompt: regenDraft.trim() || generation.prompt,
        aspect_ratio: generation.aspect_ratio,
        ref_strength: generation.ref_strength,
      });
      setRegenPrompt(null);
    } finally {
      setRegenBusy(false);
    }
  };

  const regenerateButton = (
    <button className="overlay-btn" onClick={startRegenerate} disabled={regenBusy}>
      {regenBusy ? "Regenerating…" : "↻ Regenerate"}
    </button>
  );

  const handleUpscale = async (scale) => {
    if (!onUpscale || upscaling) return;
    setUpscaling(true);
    try {
      await onUpscale(generation.id, scale);
    } finally {
      setUpscaling(false);
    }
  };

  const handleRetry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry(generation.id);
    } finally {
      setRetrying(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete(generation.id);
    } finally {
      setDeleting(false);
    }
  };

  const isFailed = generation.status === "error";

  const upscaleButtons = onUpscale ? (
    <div className="overlay-actions upscale-row">
      <button
        className="overlay-btn"
        onClick={() => handleUpscale(2)}
        disabled={upscaling}
        title="Local Real-ESRGAN 2x upscale (free)"
      >
        {upscaling ? "Upscaling…" : "⤢ Upscale 2×"}
      </button>
      <button
        className="overlay-btn"
        onClick={() => handleUpscale(4)}
        disabled={upscaling}
        title="Local Real-ESRGAN 4x upscale (free, slower)"
      >
        ⤢ 4×
      </button>
    </div>
  ) : null;

  return (
    <>
      <figure className={`image-card ${statusClass}${selected ? " selected" : ""}`}>
        <div
          className="image-frame"
          onClick={() => isDone && setLightbox(true)}
          title={isDone ? "Click to enlarge" : undefined}
        >
          {isDone ? (
            <img src={generation.image_url} alt={generation.prompt} loading="lazy" />
          ) : (
            <div className="image-placeholder">
              {isFailed ? "Failed" : "Generating…"}
              {isFailed && (onRetry || onDelete) && (
                <div className="failed-actions">
                  {onRetry && (
                    <button
                      type="button"
                      className="overlay-btn"
                      disabled={retrying}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRetry();
                      }}
                    >
                      {retrying ? "Retrying…" : "↻ Retry"}
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      className="overlay-btn danger"
                      disabled={deleting}
                      title="Delete this failed generation"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete();
                      }}
                    >
                      {deleting ? "Deleting…" : "🗑 Delete"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {!isDone && (
            <span className={`badge${isFailed ? " error" : ""}`}>
              {isFailed ? "Failed" : "Pending"}
            </span>
          )}

          {onSelect && isDone && (
            <button
              type="button"
              className={`ref-toggle${selected ? " on" : ""}`}
              title={selected ? "Unselect as reference" : "Use as reference"}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(generation.id);
              }}
            >
              {selected ? "✓ Reference" : "Use as reference"}
            </button>
          )}

          {isDone && (
            <div className="image-overlay" onClick={(e) => e.stopPropagation()}>
              <div className="overlay-actions">
                {regenerateButton}
                {upscaleButtons}
                {onHide && (
                  <button
                    className="overlay-btn"
                    title="Remove from the gallery (kept in database)"
                    onClick={() => onHide(generation.id)}
                  >
                    🗑 Hide
                  </button>
                )}
                <button className="overlay-btn" onClick={() => setSaveOpen((v) => !v)}>
                  Save to channel
                </button>
                {onSetCategory && (
                  <button
                    className="overlay-btn"
                    title={
                      generation.category === "character"
                        ? "Remove from Characters"
                        : "Add to Characters — reusable reference for future prompts"
                    }
                    onClick={() =>
                      onSetCategory(
                        generation.id,
                        generation.category === "character" ? "image" : "character",
                      )
                    }
                  >
                    {generation.category === "character" ? "👤 Unset" : "👤 Character"}
                  </button>
                )}
                <a
                  href={generation.image_url}
                  download={downloadName}
                  className="overlay-btn"
                >
                  Download
                </a>
              </div>
              {saveOpen && (
                <select
                  className="overlay-select"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      onSaveToChannel(generation.id, Number(e.target.value));
                      setSaveOpen(false);
                    }
                  }}
                >
                  <option value="" disabled>
                    Pick a channel…
                  </option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        <figcaption>
          {editing ? (
            <input
              className="rename-input"
              value={draftName}
              autoFocus
              maxLength={255}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraftName(generation.name);
                  setEditing(false);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <p
              className="prompt name"
              title="Click to rename"
              onClick={() => isDone && setEditing(true)}
            >
              {displayName}
            </p>
          )}
          <p className="prompt small">{generation.prompt}</p>
          <p className="muted small">
            {created} · {generation.aspect_ratio} · {sizeLabel} · {generation.model}
            {generation.status === "done" && generation.cost_usd > 0 && (
              <> · ≈${generation.cost_usd.toFixed(3)}</>
            )}
          </p>
          {generation.error && <p className="error small">{generation.error}</p>}
        </figcaption>
      </figure>

      {lightbox && isDone && (
        <div className="lightbox" onClick={() => setLightbox(false)}>
          <button className="lightbox-close" title="Close (Esc)" onClick={() => setLightbox(false)}>
            ✕
          </button>
          <img
            src={generation.image_url}
            alt={generation.prompt}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="lightbox-meta" onClick={(e) => e.stopPropagation()}>
            {editing ? (
              <input
                className="rename-input"
                value={draftName}
                autoFocus
                maxLength={255}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    setDraftName(generation.name);
                    setEditing(false);
                  }
                }}
              />
            ) : (
              <p className="lightbox-name" title="Click to rename" onClick={() => setEditing(true)}>
                {displayName}
              </p>
            )}
            <div className="overlay-actions">
              {regenerateButton}
              <a
                href={generation.image_url}
                download={downloadName}
                className="overlay-btn"
              >
                Save / Download
              </a>
              <button className="overlay-btn" onClick={() => setLightbox(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {regenPrompt === generation.id && (
        <div className="lightbox regen-dialog" onClick={() => !regenBusy && setRegenPrompt(null)}>
          <div className="regen-box" onClick={(e) => e.stopPropagation()}>
            <h3>Regenerate with edited prompt</h3>
            <p className="muted small">
              Same references, ratio ({generation.aspect_ratio}) and refs strength (
              {generation.ref_strength}) as the original.
            </p>
            <textarea
              value={regenDraft}
              rows={5}
              onChange={(e) => setRegenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitRegenerate();
              }}
              autoFocus
            />
            <div className="form-row">
              <button onClick={submitRegenerate} disabled={regenBusy || !regenDraft.trim()}>
                {regenBusy ? "Generating…" : "↻ Generate new image"}
              </button>
              <button
                className="ghost"
                onClick={() => setRegenPrompt(null)}
                disabled={regenBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
