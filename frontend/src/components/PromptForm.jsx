import { useState } from "react";

import { api } from "../api/client.js";
import GenerationOptions from "./GenerationOptions.jsx";

export default function PromptForm({
  onGenerate,
  generating,
  channelId,
  templates,
  onDeleteTemplate,
}) {
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("16:9");
  const [strength, setStrength] = useState("balanced");
  const [upscale, setUpscale] = useState(4);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!prompt.trim() || generating) return;
    onGenerate({
      prompt: prompt.trim(),
      aspect_ratio: aspect,
      ref_strength: strength,
      upscale_level: upscale,
    });
    setPrompt("");
  };

  const saveTemplate = async () => {
    if (!prompt.trim()) return;
    try {
      await api.createTemplate(channelId, { text: prompt.trim() });
    } catch {
      /* surfaced elsewhere */
    }
  };

  return (
    <form onSubmit={handleSubmit} className="stack">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the image to generate…"
        rows={4}
      />

      {templates && templates.length > 0 && (
        <div className="form-row template-row">
          <select
            defaultValue=""
            onChange={(e) => {
              const template = templates.find((t) => String(t.id) === e.target.value);
              if (template) setPrompt(template.text);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Load a saved prompt…
            </option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          {templates.map((template) => (
            <button
              key={`del-${template.id}`}
              type="button"
              className="danger tiny"
              title={`Delete template "${template.name}"`}
              onClick={() => onDeleteTemplate(template.id)}
            >
              🗑
            </button>
          ))}
        </div>
      )}

      <GenerationOptions
        aspect={aspect}
        strength={strength}
        upscale={upscale}
        onChange={(patch) => {
          if (patch.aspect !== undefined) setAspect(patch.aspect);
          if (patch.strength !== undefined) setStrength(patch.strength);
          if (patch.upscale !== undefined) setUpscale(patch.upscale);
        }}
      />

      <div className="form-row">
        <button
          type="button"
          className="ghost small"
          title="Save this prompt as a reusable template"
          onClick={saveTemplate}
          disabled={!prompt.trim()}
        >
          Save prompt
        </button>
      </div>

      <button type="submit" disabled={!prompt.trim() || generating}>
        {generating ? "Generating…" : "Generate image"}
      </button>
    </form>
  );
}
