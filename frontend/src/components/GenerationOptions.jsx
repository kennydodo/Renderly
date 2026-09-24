const ASPECTS = ["16:9", "1:1", "9:16", "4:3", "3:4"];
const STRENGTHS = [
  ["balanced", "Balanced refs"],
  ["loose", "Loose refs"],
  ["strict", "Strict refs"],
];
const UPSCALE = [
  [0, "Off — keep native size"],
  [1, "1920 × 1080 (HD)"],
  [2, "2560 × 1440 (2K)"],
  [3, "3840 × 2160 (4K)"],
];

export default function GenerationOptions({ aspect, strength, upscale, onChange, compact = false }) {
  return (
    <div className={`form-row options-row${compact ? " compact" : ""}`}>
      <label className="option">
        <span>Ratio</span>
        <select value={aspect} onChange={(e) => onChange({ aspect: e.target.value })}>
          {ASPECTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="option">
        <span>Refs</span>
        <select value={strength} onChange={(e) => onChange({ strength: e.target.value })}>
          {STRENGTHS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="option">
        <span>Resolution</span>
        <select value={upscale} onChange={(e) => onChange({ upscale: Number(e.target.value) })}>
          {UPSCALE.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
