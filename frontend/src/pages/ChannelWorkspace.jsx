import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client.js";
import BatchGenerateForm from "../components/BatchGenerateForm.jsx";
import ImageCard from "../components/ImageCard.jsx";
import PromptForm from "../components/PromptForm.jsx";
import ReferencePicker from "../components/ReferencePicker.jsx";

export default function ChannelWorkspace() {
  const { channelId } = useParams();
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState(null);
  const [assets, setAssets] = useState([]);
  const [generations, setGenerations] = useState([]);

  const [refsSource, setRefsSource] = useState("assets");
  const [refChannelId, setRefChannelId] = useState(channelId);
  const [selectedRefs, setSelectedRefs] = useState([]);
  const [galleryItems, setGalleryItems] = useState([]);
  const [gallerySearch, setGallerySearch] = useState("");
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [view, setView] = useState("create");

  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [refStrength, setRefStrength] = useState("balanced");
  const [templates, setTemplates] = useState([]);
  const [spend, setSpend] = useState(null);
  const [upscalerAvailable, setUpscalerAvailable] = useState(false);
  const [error, setError] = useState("");

  const searchTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const [channelList, generationData, templateData, spendData, upscaleData] =
        await Promise.all([
          api.listChannels(),
          api.listGenerations({ channelId }),
          api.listTemplates(channelId).catch(() => []),
          api.spendSummary({ channelId }).catch(() => null),
          api.upscaleStatus().catch(() => ({ available: false })),
        ]);
      setChannels(channelList);
      setChannel(channelList.find((c) => String(c.id) === channelId) || null);
      setGenerations(generationData);
      setTemplates(templateData);
      setSpend(spendData);
      setUpscalerAvailable(Boolean(upscaleData.available));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [channelId]);

  const loadAssets = useCallback(async (channelIdToLoad) => {
    try {
      setAssets(await api.listAssets(channelIdToLoad));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    loadAssets(refChannelId);
  }, [load, loadAssets, refChannelId]);

  useEffect(() => {
    if (refsSource !== "gallery") return undefined;
    setGalleryLoading(true);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        // The picker only needs the LATEST 20 generations (newest first).
        setGalleryItems(
          await api.listGenerations({
            search: gallerySearch || undefined,
            status: "done",
            limit: 20,
          }),
        );
        setGalleryLoading(false);
      } catch (err) {
        setError(err.message);
        setGalleryLoading(false);
      }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [refsSource, gallerySearch]);

  if (!channel) {
    return <p className="muted">{error || "Loading…"}</p>;
  }

  const toggleRef = (ref) => {
    setSelectedRefs((refs) =>
      refs.some((r) => r.type === ref.type && r.id === ref.id)
        ? refs.filter((r) => !(r.type === ref.type && r.id === ref.id))
        : [...refs, ref],
    );
  };

  const handleUpload = async (file) => {
    setUploading(true);
    try {
      await api.uploadAsset(refChannelId, file);
      await loadAssets(refChannelId);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteAsset = async (assetId) => {
    try {
      await api.deleteAsset(assetId);
      setSelectedRefs((refs) => refs.filter((r) => !(r.type === "asset" && r.id === assetId)));
      await loadAssets(refChannelId);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleGenerate = async ({ prompt, aspect_ratio, ref_strength }) => {
    setGenerating(true);
    try {
      await api.generate(channelId, {
        prompt,
        asset_ids: selectedRefs.filter((r) => r.type === "asset").map((r) => r.id),
        generation_ids: selectedRefs.filter((r) => r.type === "generation").map((r) => r.id),
        aspect_ratio: aspect_ratio || aspectRatio,
        ref_strength: ref_strength || refStrength,
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateBatch = async ({ items, aspect_ratio, ref_strength, image_size, parallel }) => {
    setGenerating(true);
    try {
      await api.generateBatch(channelId, {
        items,
        asset_ids: selectedRefs.filter((r) => r.type === "asset").map((r) => r.id),
        generation_ids: selectedRefs.filter((r) => r.type === "generation").map((r) => r.id),
        aspect_ratio: aspect_ratio || aspectRatio,
        ref_strength: ref_strength || refStrength,
        image_size: image_size || "1K",
        parallel: Boolean(parallel),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerate = async (id, body = {}) => {
    try {
      await api.regenerate(id, body);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteTemplate = async (id) => {
    try {
      await api.deleteTemplate(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleHide = async (id) => {
    try {
      await api.patchGeneration(id, { hidden: true });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSetCategory = async (id, category) => {
    try {
      await api.patchGeneration(id, { category });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUpscale = async (id, scale) => {
    try {
      await api.upscaleGeneration(id, scale);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRename = async (id, name) => {
    try {
      await api.renameGeneration(id, name);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveToChannel = async (id, targetChannelId) => {
    try {
      await api.saveGenerationAsAsset(id, targetChannelId);
      if (String(targetChannelId) === String(refChannelId)) {
        await loadAssets(refChannelId);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const selectedGenerationIds = selectedRefs
    .filter((r) => r.type === "generation")
    .map((r) => r.id);

  return (
    <section>
        <div className="workspace-header">
          <div>
            <h1>{channel.name}</h1>
            {channel.description && <p className="muted">{channel.description}</p>}
            {spend && (
              <p className="muted small">
                Est. spend: ${spend.total_usd.toFixed(2)} · {spend.image_count} image
                {spend.image_count === 1 ? "" : "s"}
                {spend.failed_count > 0 && ` · ${spend.failed_count} failed`}
                {spend.prices &&
                  ` · $${spend.prices["1K"].toFixed(3)}/1K, $${spend.prices["2K"].toFixed(
                    3,
                  )}/2K, $${spend.prices["4K"].toFixed(3)}/4K each`}
              </p>
            )}
          </div>
          <a className="ghost-btn" href={api.exportChannelUrl(channelId)}>
            ⬇ Export images (.zip)
          </a>
        </div>
      {error && <p className="error">{error}</p>}

      <div className="channel-layout">
        <aside className="media-sidebar">
          <button className={view === "create" ? "on" : ""} onClick={() => setView("create")}>
            🎨 Create
          </button>
          <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>
            🖼 All media ({generations.length})
          </button>
          <button className={view === "image" ? "on" : ""} onClick={() => setView("image")}>
            📷 Images ({generations.filter((g) => (g.category || "image") === "image").length})
          </button>
          <button
            className={view === "character" ? "on" : ""}
            onClick={() => setView("character")}
          >
            👤 Characters ({generations.filter((g) => g.category === "character").length})
          </button>
          <button className={view === "video" ? "on" : ""} onClick={() => setView("video")}>
            🎬 Videos ({generations.filter((g) => g.category === "video").length})
          </button>
        </aside>

        <div className="channel-main">
          {view !== "create" && (
            <h2>
              {view === "all"
                ? "All media"
                : view === "image"
                  ? "Images"
                  : view === "character"
                    ? "Characters"
                    : "Videos"}
            </h2>
          )}

          {view === "create" ? (
            <>
              <div className="panel" style={{ marginBottom: "1.25rem" }}>
                <h2>Reference images</h2>
                <p className="muted small">
                  Attached references are used by every generation below.
                </p>
                <ReferencePicker
                  channels={channels}
                  currentChannelId={channelId}
                  assets={assets}
                  selectedRefs={selectedRefs}
                  onToggleRef={toggleRef}
                  onUpload={handleUpload}
                  onDeleteAsset={handleDeleteAsset}
                  uploading={uploading}
                  refsSource={refsSource}
                  setRefsSource={setRefsSource}
                  refChannelId={refChannelId}
                  setRefChannelId={setRefChannelId}
                  galleryItems={galleryItems}
                  gallerySearch={gallerySearch}
                  setGallerySearch={setGallerySearch}
                  galleryLoading={galleryLoading}
                />
              </div>

              <div className="panel">
                <h2>Generate</h2>
                <p className="muted">
                  {selectedRefs.length} reference{selectedRefs.length === 1 ? "" : "s"} selected.
                </p>
                {!batchOpen ? (
                  <PromptForm
                    onGenerate={handleGenerate}
                    generating={generating}
                    channelId={channelId}
                    templates={templates}
                    onDeleteTemplate={handleDeleteTemplate}
                  />
                ) : (
                  <p className="muted hint">
                    Single-prompt form hidden while batch mode is active.
                  </p>
                )}
                <BatchGenerateForm
                  onGenerateBatch={handleGenerateBatch}
                  generating={generating}
                  open={batchOpen}
                  onOpenChange={setBatchOpen}
                  channelId={channelId}
                />

                <label className="field-label">Recent generations</label>
                {generations.length === 0 ? (
                  <p className="muted small">Nothing generated yet.</p>
                ) : (
                  <div className="recent-strip">
                    {generations.slice(0, 10).map((g) =>
                      g.image_url ? (
                        <img
                          key={g.id}
                          src={g.image_url}
                          alt={g.name || g.prompt}
                          title={`${g.name || g.prompt} — click to use as reference`}
                          onClick={() =>
                            toggleRef({
                              type: "generation",
                              id: g.id,
                              url: g.image_url,
                              label: g.name || g.prompt,
                            })
                          }
                        />
                      ) : (
                        <span key={g.id} className="muted small" title="failed">
                          ✕
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {(() => {
                const visible = generations.filter(
                  (g) => view === "all" || (g.category || "image") === view,
                );
                if (visible.length === 0) {
                  return <p className="muted">Nothing here yet.</p>;
                }
                return (
                  <div className="grid images">
                    {visible.map((generation) => (
                      <ImageCard
                        key={generation.id}
                        generation={generation}
                        channels={channels}
                        selected={selectedGenerationIds.includes(generation.id)}
                        onSelect={(id) => {
                          const gen = generations.find((g) => g.id === id);
                          if (gen) {
                            toggleRef({
                              type: "generation",
                              id: gen.id,
                              url: gen.image_url,
                              label: gen.name || gen.prompt,
                            });
                          }
                        }}
                        onRename={handleRename}
                        onSaveToChannel={handleSaveToChannel}
                        onRegenerate={handleRegenerate}
                        onHide={handleHide}
                        onUpscale={upscalerAvailable ? handleUpscale : null}
                        onSetCategory={handleSetCategory}
                      />
                    ))}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
