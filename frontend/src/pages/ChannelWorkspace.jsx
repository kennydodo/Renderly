import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api } from "../api/client.js";
import BatchGenerateForm from "../components/BatchGenerateForm.jsx";
import ImageCard from "../components/ImageCard.jsx";
import PromptForm from "../components/PromptForm.jsx";
import ReferencePicker from "../components/ReferencePicker.jsx";

export default function ChannelWorkspace() {
  const { channelId, projectId: routeProjectId } = useParams();
  const navigate = useNavigate();
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState(null);
  const [projects, setProjects] = useState([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [assets, setAssets] = useState([]);
  const [generations, setGenerations] = useState([]);

  const [refsSource, setRefsSource] = useState("assets");
  const [refChannelId, setRefChannelId] = useState(channelId);
  const [selectedRefs, setSelectedRefs] = useState([]);
  const [galleryItems, setGalleryItems] = useState([]);
  const [gallerySearch, setGallerySearch] = useState("");
  const [galleryLoading, setGalleryLoading] = useState(false);
  // Library view lives in the URL (?view=all) so refreshes keep the view.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") || "create";
  const [selectMode, setSelectMode] = useState(false);
  const [deleteSelection, setDeleteSelection] = useState(() => new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [refStrength, setRefStrength] = useState("balanced");
  const [templates, setTemplates] = useState([]);
  const [spend, setSpend] = useState(null);
  const [error, setError] = useState("");

  const searchTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const [channelList, projectList, generationData, templateData, spendData] =
        await Promise.all([
          api.listChannels(),
          api.listProjects(channelId).catch(() => []),
          api.listGenerations({
            channelId,
            projectId: routeProjectId === "unassigned" ? undefined : routeProjectId,
            hidden: "all",
          }),
          api.listTemplates(channelId).catch(() => []),
          api.spendSummary({ channelId }).catch(() => null),
        ]);
      setChannels(channelList);
      setChannel(channelList.find((c) => String(c.id) === channelId) || null);
      setProjects(projectList);
      setGenerations(generationData);
      setTemplates(templateData);
      setSpend(spendData);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [channelId, routeProjectId]);

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

  // Opening a DIFFERENT project lands on the composer; a plain refresh
  // keeps the library view via the ?view= query param.
  const prevProjectRef = useRef(null);
  useEffect(() => {
    if (prevProjectRef.current !== null && prevProjectRef.current !== routeProjectId) {
      setSearchParams({}, { replace: true });
    }
    prevProjectRef.current = routeProjectId;
  }, [routeProjectId, setSearchParams]);

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

  const setView = (v) => {
    setSearchParams(v === "create" ? {} : { view: v }, { replace: true });
    setSelectMode(false);
    setDeleteSelection(new Set());
  };

  const toggleDeleteSelection = (id) =>
    setDeleteSelection((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const handleGenerate = async ({ prompt, aspect_ratio, ref_strength, upscale_level }) => {
    setGenerating(true);
    try {
      const generation = await api.generate(channelId, {
        prompt,
        asset_ids: selectedRefs.filter((r) => r.type === "asset").map((r) => r.id),
        generation_ids: selectedRefs.filter((r) => r.type === "generation").map((r) => r.id),
        project_id: unassignedView ? undefined : routeProjectId || undefined,
        aspect_ratio: aspect_ratio || aspectRatio,
        ref_strength: ref_strength || refStrength,
        upscale_level,
      });
      if (generation.status === "error") setError(generation.error || "Generation failed");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateBatch = async ({ items, aspect_ratio, ref_strength, upscale_level, parallel }) => {
    setGenerating(true);
    try {
      const rows = await api.generateBatch(channelId, {
        items,
        asset_ids: selectedRefs.filter((r) => r.type === "asset").map((r) => r.id),
        generation_ids: selectedRefs.filter((r) => r.type === "generation").map((r) => r.id),
        project_id: unassignedView ? undefined : routeProjectId || undefined,
        aspect_ratio: aspect_ratio || aspectRatio,
        ref_strength: ref_strength || refStrength,
        upscale_level,
        parallel: Boolean(parallel),
      });
      const failed = rows.filter((r) => r.status === "error");
      if (failed.length > 0) {
        setError(
          failed.some((r) => (r.error || "").includes("quota/billing limit"))
            ? "Quota/billing limit reached — the batch was stopped. Retry the failed images manually."
            : `${failed.length} of ${rows.length} generations failed.`,
        );
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    try {
      const project = await api.createProject(channelId, name);
      setNewProjectName("");
      await load();
      navigate(`/channels/${channelId}/projects/${project.id}`);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteProject = async (id) => {
    if (
      !window.confirm(
        "Delete this project? Its generations move to another project of this channel.",
      )
    )
      return;
    try {
      await api.deleteProject(id);
      await load();
      navigate(`/channels/${channelId}`);
    } catch (err) {
      setError(err.message);
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

  const handleRetry = async (id) => {
    try {
      const generation = await api.retryGeneration(id);
      if (generation.status === "error") setError(generation.error || "Retry failed");
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteGeneration = async (id) => {
    if (!window.confirm("Delete this failed generation?")) return;
    try {
      await api.deleteGeneration(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteSelected = async () => {
    const ids = [...deleteSelection];
    if (!ids.length) return;
    // Two-step in-app confirm — browser confirm() dialogs can be silently
    // suppressed ("prevent this page from creating additional dialogs").
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    try {
      const results = await Promise.allSettled(ids.map((id) => api.deleteGeneration(id)));
      const failures = results.filter((r) => r.status === "rejected").length;
      if (failures) setError(`${failures} of ${ids.length} deletions failed.`);
      setDeleteSelection(new Set());
      setSelectMode(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveFromRecent = async (id) => {
    try {
      await api.patchGeneration(id, { recent_removed: true });
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

  const isProjectView = Boolean(routeProjectId);
  const unassignedView = routeProjectId === "unassigned";
  const project = projects.find((p) => String(p.id) === String(routeProjectId)) || null;
  const projectGenerations = unassignedView
    ? generations.filter((g) => g.project_id == null)
    : isProjectView
      ? generations.filter((g) => String(g.project_id) === String(routeProjectId))
      : [];
  const unassignedCount = generations.filter((g) => g.project_id == null).length;
  // Recent strip: latest 10 successful generations of this project, minus
  // ones the user removed - older ones backfill so it stays full when possible.
  const recentItems = projectGenerations
    .filter((g) => g.status === "done" && g.image_url && !g.recent_removed)
    .slice(0, 10);
  const projectCounts = {};
  generations.forEach((g) => {
    if (g.project_id != null) {
      projectCounts[g.project_id] = (projectCounts[g.project_id] || 0) + 1;
    }
  });

  return (
    <section>
      <div className="workspace-header">
        <div>
          <button
            type="button"
            className="ghost-btn"
            style={{ marginBottom: "0.5rem" }}
            onClick={() => navigate(isProjectView ? `/channels/${channelId}` : "/")}
          >
            {isProjectView ? "← Projects" : "← Channels"}
          </button>
          <h1>{unassignedView ? "Unsorted images" : isProjectView ? project?.name || "Project" : channel.name}</h1>
          {!isProjectView && channel.description && <p className="muted">{channel.description}</p>}
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

      {!isProjectView ? (
        <>
          <h2 style={{ marginTop: 0 }}>Projects in {channel.name}</h2>
          <div className="grid cards">
            {projects.map((p) => (
              <div key={p.id} className="card project-card">
                <button
                  type="button"
                  className="project-open"
                  onClick={() => navigate(`/channels/${channelId}/projects/${p.id}`)}
                >
                  <span className="project-name">📁 {p.name}</span>
                  <span className="muted small">
                    {projectCounts[p.id] || 0} generation
                    {(projectCounts[p.id] || 0) === 1 ? "" : "s"}
                  </span>
                </button>
                {projects.length > 1 && (
                  <button
                    type="button"
                    className="danger tiny project-del"
                    title="Delete project (generations move to another project)"
                    onClick={() => handleDeleteProject(p.id)}
                  >
                    🗑 Delete
                  </button>
                )}
              </div>
            ))}
            {unassignedCount > 0 && (
              <div className="card project-card">
                <button
                  type="button"
                  className="project-open"
                  onClick={() => navigate(`/channels/${channelId}/projects/unassigned`)}
                >
                  <span className="project-name">🗂 Unsorted</span>
                  <span className="muted small">
                    {unassignedCount} generation{unassignedCount === 1 ? "" : "s"}
                  </span>
                </button>
              </div>
            )}
            <div className="card project-card project-new">
              <h3>New project</h3>
              <input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                placeholder="e.g. Episode 12 — Winter Forest"
              />
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
              >
                ＋ Create project
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="channel-layout">
          <aside className="media-sidebar">
            <button className={view === "create" ? "on" : ""} onClick={() => setView("create")}>
              🎨 Create
            </button>
            <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>
              🖼 All media ({projectGenerations.length})
            </button>
            <button className={view === "image" ? "on" : ""} onClick={() => setView("image")}>
              📷 Images (
              {
                projectGenerations.filter((g) => (g.category || "image") === "image").length
              }
              )
            </button>
            <button
              className={view === "character" ? "on" : ""}
              onClick={() => setView("character")}
            >
              👤 Characters (
              {projectGenerations.filter((g) => g.category === "character").length})
            </button>
            <button className={view === "video" ? "on" : ""} onClick={() => setView("video")}>
              🎬 Videos ({projectGenerations.filter((g) => g.category === "video").length})
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
                    Attach once — these references are used by every generation in this
                    project. You can also pick from other projects and channels.
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
                    {selectedRefs.length} reference{selectedRefs.length === 1 ? "" : "s"}{" "}
                    selected.
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
                  {recentItems.length === 0 ? (
                    <p className="muted small">Nothing generated yet.</p>
                  ) : (
                    <div className="recent-strip">
                      {recentItems.map((g) => (
                        <span key={g.id} className="recent-item">
                          <img
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
                          <button
                            type="button"
                            className="recent-remove"
                            title="Remove from recent"
                            onClick={() => handleRemoveFromRecent(g.id)}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                {(() => {
                  const visible = projectGenerations.filter(
                    (g) => view === "all" || (g.category || "image") === view,
                  );
                  if (visible.length === 0) {
                    return <p className="muted">Nothing here yet.</p>;
                  }
                  return (
                    <>
                      <div
                        style={{
                          display: "flex",
                          gap: "10px",
                          alignItems: "center",
                          marginBottom: "12px",
                        }}
                      >
                        <button
                          type="button"
                          className={selectMode ? "on" : ""}
                          onClick={() => {
                            setSelectMode(!selectMode);
                            setDeleteSelection(new Set());
                            setConfirmingDelete(false);
                          }}
                        >
                          {selectMode ? "Cancel selection" : "Select"}
                        </button>
                        {selectMode && (
                          <>
                            <span className="muted small">
                              {deleteSelection.size} selected
                            </span>
                            <button
                              type="button"
                              className={confirmingDelete ? "danger" : "danger"}
                              onClick={handleDeleteSelected}
                              disabled={deleteSelection.size === 0}
                              title="Permanently delete the selected images from the database and disk"
                            >
                              {confirmingDelete
                                ? `⚠ Click again to delete ${deleteSelection.size} image(s)`
                                : "🗑 Delete selected"}
                            </button>
                          </>
                        )}
                      </div>
                      <div className="grid images">
                        {visible.map((generation) => (
                          <ImageCard
                            key={generation.id}
                            generation={generation}
                            channels={channels}
                            selected={selectedGenerationIds.includes(generation.id)}
                            multiSelect={selectMode}
                            multiChecked={deleteSelection.has(generation.id)}
                            onMultiToggle={toggleDeleteSelection}
                            onSelect={(id) => {
                              const gen = projectGenerations.find((g) => g.id === id);
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
                            onRetry={handleRetry}
                            onDelete={handleDeleteGeneration}
                            onHide={handleHide}
                            onSetCategory={handleSetCategory}
                          />
                        ))}
                      </div>
                    </>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
