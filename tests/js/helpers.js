// Loads real functions out of the extension sources so the tests break when
// the source changes, not when a copy of the logic drifts away from it.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// Extract source between two unique markers (start inclusive, end exclusive).
function slice(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `Could not slice ${label || startMarker} ("${startMarker}" -> "${endMarker}"). ` +
        "The source moved or was renamed - update the markers in tests/js/helpers.js."
    );
  }
  return source.slice(start, end);
}

// Evaluate extracted source with stub globals and return the named functions.
function loadFunctions(rel, startMarker, endMarker, stubs, names, label) {
  const code = slice(read(rel), startMarker, endMarker, label);
  const keys = Object.keys(stubs);
  const factory = new Function(
    ...keys,
    `"use strict";\n${code}\nreturn { ${names.join(", ")} };`
  );
  return factory(...keys.map((k) => stubs[k]));
}

module.exports = { ROOT, read, slice, loadFunctions };
