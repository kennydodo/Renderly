const ASPECTS = ["16:9", "1:1", "9:16", "4:3", "3:4"];
const STRENGTHS = [
  ["balanced", "Balanced refs"],
  ["loose", "Loose refs"],
  ["strict", "Strict refs"],
];
const SIZES = [
  ["1K", "720p-class"],
  ["2K", "1080p-class"],
  ["4K", "4K"],
];

export default function GenerationOptions({ aspect, strength, size, onChange, compact = false }) {
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
        <span>Res</span>
        <select value={size} onChange={(e) => onChange({ size: e.target.value })}>
          {SIZES.map(([value, label]) => (
            <option key={value} value={value}>
              {value} · {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
