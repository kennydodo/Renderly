import { useRef, useState } from "react";

import GenerationOptions from "./GenerationOptions.jsx";
import ReferenceMiniPicker from "./ReferenceMiniPicker.jsx";

const NAME_TOKEN_RE = /^\s*([\w\-]+\.(?:png|jpe?g))\s+(.*)$/i;

// "images/S02_05_PROC_PV.png" → "S02_05_PROC_PV"
function stemName(value) {
  let v = String(value || "").trim().replace(/^["']|["']$/g, "");
  v = v.split(/[\\/]/).pop() || "";
  v = v.replace(/\.(png|jpe?g|webp)$/i, "").trim();
  return v || null;
}

function extractFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const fileField =
    obj.file || obj.filename || obj.file_name || obj.name || obj.image || obj.output;
  const promptField = obj.prompt || obj.text || obj.description || obj.body || "";
  const name = fileField ? stemName(fileField) : null;
  const prompt = String(promptField).trim();
  if (!name && !prompt) return null;
  return { name, prompt };
}

export function splitPromptName(text) {
  const raw = String(text || "").trim();

  // JSON batch entry: { "file": "S02_05_PROC_PV.png", "prompt": "…" }
  if (raw.startsWith("{")) {
    try {
      const parsed = extractFromObject(JSON.parse(raw));
      if (parsed) return { name: parsed.name, prompt: parsed.prompt || raw };
    } catch {
      /* not valid JSON — fall through */
    }
  }

  // Leading "NAME.png" token.
  const match = raw.match(NAME_TOKEN_RE);
  if (match && match[2].trim()) {
    return { name: stemName(match[1]), prompt: match[2].trim() };
  }

  // A file token anywhere in the line names the output.
  const anyFile = raw.match(/[\w\-]+\.(?:png|jpe?g|webp)/i);
  if (anyFile) {
    return { name: stemName(anyFile[0]), prompt: raw };
  }

  return { name: null, prompt: raw };
}

export default function BatchGenerateForm({
  onGenerateBatch,
  generating,
  open,
  onOpenChange,
  channelId,
}) {
  const [master, setMaster] = useState("");
  const [prompts, setPrompts] = useState([createRow()]);
  const [pasteBox, setPasteBox] = useState("");
  const [pickerRow, setPickerRow] = useState(null);
  const [aspect, setAspect] = useState("16:9");
  const [strength, setStrength] = useState("balanced");
  const [size, setSize] = useState("1K");
  const [parallel, setParallel] = useState(false);
  const masterRef = useRef(null);

  function createRow() {
    return { text: "", assetIds: [], generationIds: [] };
  }

  const update = (index, value) =>
    setPrompts((list) => list.map((p, i) => (i === index ? { ...p, text: value } : p)));

  const addPrompt = () => setPrompts((list) => [...list, createRow()]);

  const removePrompt = (index) =>
    setPrompts((list) => (list.length > 1 ? list.filter((_, i) => i !== index) : list));

  const splitIntoCards = () => {
    const raw = pasteBox.trim();
    if (!raw) return;

    // A JSON array of batch entries creates one card per entry; the
    // "file"-style field becomes the leading NAME token so naming keeps working.
    if (raw.startsWith("[")) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const rows = arr
            .map((obj) => extractFromObject(obj))
            .filter(Boolean)
            .map((e) => ({
              text: e.name ? `${e.name} ${e.prompt || ""}`.trim() : e.prompt,
              assetIds: [],
              generationIds: [],
            }))
            .filter((r) => r.text);
          if (rows.length) {
            setPrompts(rows);
            setPasteBox("");
            return;
          }
        }
      } catch {
        /* not a JSON array — fall through to line splitting */
      }
    }

    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length) {
      setPrompts(lines.map((line) => ({ ...createRow(), text: line })));
      setPasteBox("");
    }
  };

  const removeAllPrompts = () => setPrompts([createRow()]);

  const compose = (child) => {
    const m = master.trim();
    const c = child.trim();
    if (m && c) return `${m} ${c}`;
    return m || c;
  };

  const valid = prompts.map((p) => p.text.trim()).filter(Boolean);
  const previewText = valid.length ? compose(splitPromptName(valid[0]).prompt) : "";

  const setRowRefs = (index, refs) => {
    setPrompts((list) =>
      list.map((p, i) =>
        i === index ? { ...p, assetIds: refs.assetIds, generationIds: refs.generationIds } : p,
      ),
    );
  };

  const startDrag = (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = masterRef.current.offsetHeight;
    const onMove = (e) => {
      const height = Math.min(600, Math.max(60, startHeight + e.clientY - startY));
      masterRef.current.style.height = `${height}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resetHeight = () => {
    masterRef.current.style.height = "";
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (valid.length === 0 || generating) return;
    onGenerateBatch({
      items: prompts
        .filter((p) => p.text.trim())
        .map((p) => {
          const { name, prompt } = splitPromptName(p.text.trim());
          return {
            prompt: compose(prompt),
            name,
            asset_ids: p.assetIds,
            generation_ids: p.generationIds,
          };
        }),
      aspect_ratio: aspect,
      ref_strength: strength,
      image_size: size,
      parallel,
    });
    setPrompts([createRow()]);
    setPickerRow(null);
  };

  return (
    <form onSubmit={handleSubmit} className="stack batch-form">
      <button type="button" className="link" onClick={() => onOpenChange(!open)}>
        {open ? "− Hide batch mode" : "+ Batch mode"}
      </button>
      {open && (
        <>
          <label className="field-label" htmlFor="master-prompt">
            Master prompt — prepended to every prompt below
          </label>
          <textarea
            id="master-prompt"
            ref={masterRef}
            value={master}
            onChange={(e) => setMaster(e.target.value)}
            placeholder="e.g. Square YouTube thumbnail, bold colors, cinematic lighting —"
            rows={3}
            className="master-prompt"
          />
          <div
            className="drag-handle"
            title="Drag to resize · double-click to reset"
            onMouseDown={startDrag}
            onDoubleClick={resetHeight}
          />

          <label className="field-label" htmlFor="paste-prompts">
            Paste multiple prompts — one per line (or a JSON array)
          </label>
          <textarea
            id="paste-prompts"
            value={pasteBox}
            onChange={(e) => setPasteBox(e.target.value)}
            placeholder={"S02_05_PROC_PV.png prompt one\nS02_06_PROC_ZO.png prompt two"}
            rows={3}
          />
          <div className="form-row">
            <button type="button" onClick={splitIntoCards} disabled={!pasteBox.trim()}>
              ✂ Split into cards
            </button>
            <button
              type="button"
              className="danger"
              onClick={removeAllPrompts}
              disabled={prompts.length === 1 && !prompts[0].text.trim()}
            >
              🗑 Remove all
            </button>
          </div>

          <div className="stack prompt-list">
            {prompts.map((row, index) => (
              <div key={index} className="prompt-card">
                <div className="prompt-row">
                  <span className="muted small prompt-num">{index + 1}</span>
                  <input
                    value={row.text}
                    onChange={(e) => update(index, e.target.value)}
                    placeholder={`Prompt ${index + 1}`}
                    maxLength={2000}
                  />
                  <button
                    type="button"
                    className={`tiny ref-pick${pickerRow === index ? " on" : ""}`}
                    title="Attach images to this prompt only"
                    onClick={() => setPickerRow(pickerRow === index ? null : index)}
                  >
                    🖼 {row.assetIds.length + row.generationIds.length || ""}
                  </button>
                  <button
                    type="button"
                    className="danger tiny"
                    title="Remove prompt"
                    onClick={() => removePrompt(index)}
                    disabled={prompts.length === 1}
                  >
                    ✕
                  </button>
                </div>

                {pickerRow === index && (
                  <ReferenceMiniPicker
                    onPick={(refs) => setRowRefs(index, refs)}
                    initialAssetIds={row.assetIds}
                    initialGenerationIds={row.generationIds}
                    currentChannelId={channelId}
                  />
                )}

                <p className="muted tiny-hint">
                  {row.assetIds.length + row.generationIds.length > 0
                    ? "Uses its own attached images."
                    : "Falls back to the main selected references."}
                </p>
              </div>
            ))}
          </div>

          <div className="form-row">
            <button type="button" onClick={addPrompt}>
              + Add prompt
            </button>
            <span className="muted small">
              {prompts.length} row{prompts.length === 1 ? "" : "s"}
              {valid.length ? ` · ${valid.length} ready` : ""}
              {prompts.length > 4 && !parallel ? " · consider Parallel for long batches" : ""}
            </span>
          </div>

          <GenerationOptions
            aspect={aspect}
            strength={strength}
            size={size}
            onChange={(patch) => {
              if (patch.aspect !== undefined) setAspect(patch.aspect);
              if (patch.strength !== undefined) setStrength(patch.strength);
              if (patch.size !== undefined) setSize(patch.size);
            }}
          />

          <label
            className="option checkbox-option"
            title="Run prompts concurrently (faster, uses more quota)"
          >
            <input
              type="checkbox"
              checked={parallel}
              onChange={(e) => setParallel(e.target.checked)}
            />
            <span>Parallel</span>
          </label>

          {master.trim() && valid.length > 0 && (
            <p className="muted hint compose-preview">
              Preview: “{previewText.slice(0, 140)}
              {previewText.length > 140 ? "…" : ""}”
            </p>
          )}

          <button type="submit" disabled={valid.length === 0 || generating}>
            {generating ? "Generating…" : `Generate batch (${valid.length})`}
          </button>
        </>
      )}
    </form>
  );
}
