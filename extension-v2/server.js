#!/usr/bin/env node
/*
 * Renderly Flow driver service — wraps flow.js behind a local HTTP API so
 * the Renderly web UI ("Flow Driver" menu) can start, stop and monitor
 * Flow batches. Local machine only; no authentication by design.
 *
 * Endpoints:
 *   GET  /api/status  — { running, startedAt, currentCard, counts, log }
 *   GET  /api/config  — { shotlistPath, channel, refs, master, upscale }
 *   POST /api/config  — save config (JSON body)
 *   POST /api/start   — start a batch using the saved config
 *   POST /api/stop    — kill the running batch (process tree)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const PORT = Number(process.env.FLOW_DRIVER_PORT || 8030);
const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, "driver-config.json");
const FLOW_JS = path.join(DIR, "flow.js");

const DEFAULT_CONFIG = {
  shotlistPath: path.join(DIR, "shotlist.json"),
  outPath: "",
  channel: "The Nature Made Us",
  refs: [
    path.join(DIR, "refs", "CHAR-HUMAN-FEMALE-01-SIT.webp"),
    path.join(DIR, "refs", "CHAR HUMAN MAKE.webp"),
  ].join(","),
  master: "",
  upscale: 2,
};

const DIALOGS = path.join(DIR, "dialogs");
const BACKEND = "http://127.0.0.1:8022";

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let run = null; // { child, startedAt, log, currentCard, counts, exitCode }

function isRunning() {
  return !!(run && run.child && run.exitCode === null);
}

function startRun(config) {
  if (isRunning()) throw new Error("a batch is already running — stop it first");

  if (!config.shotlistPath || !fs.existsSync(config.shotlistPath)) {
    throw new Error(`shotlist not found: ${config.shotlistPath}`);
  }

  const args = ["--file", config.shotlistPath, "--channel", config.channel];
  if ((config.refs || "").trim()) args.push("--refs", config.refs.trim());
  if ((config.master || "").trim()) args.push("--master", config.master.trim());
  if ((config.outPath || "").trim()) args.push("--out", config.outPath.trim());
  if (config.upscale !== undefined && config.upscale !== null) {
    args.push("--upscale", String(config.upscale));
  }

  const child = spawn(process.execPath, [FLOW_JS, ...args], {
    cwd: DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  run = {
    child,
    startedAt: new Date().toISOString(),
    log: [],
    currentCard: null,
    counts: { ok: 0, failed: 0, total: 0 },
    exitCode: null,
  };

  const push = (line) => {
    line = line.replace(/\s+$/, "");
    if (!line) return;
    run.log.push(line);
    if (run.log.length > 3000) run.log.splice(0, run.log.length - 3000);
    if (line.startsWith("▶ ")) run.currentCard = line.slice(2).trim();
    const total = line.match(/^Batch: (\d+) card/);
    if (total) run.counts.total = Number(total[1]);
    if (line.includes("imported to Renderly")) run.counts.ok++;
    if (/^\s*✕ /m.test(line)) run.counts.failed++;
  };
  readline.createInterface({ input: child.stdout }).on("line", push);
  readline.createInterface({ input: child.stderr }).on("line", push);
  child.on("exit", (code) => {
    run.exitCode = code;
  });
}

function stopRun() {
  if (!isRunning()) return false;
  if (process.platform === "win32") {
    // Kill the whole tree — flow.js spawns Chrome which spawns children.
    spawn("taskkill", ["/PID", String(run.child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    run.child.kill("SIGTERM");
  }
  return true;
}

// Show a real Windows dialog (local machine — this is why the service can
// get true filesystem paths, which a web page never can). Resolves with
// the picked path(s) when the user closes the dialog.
function pickDialog(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(DIALOGS, script)],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const out = [];
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim()) out.push(line.trim());
    });
    child.on("exit", () => resolve(out));
    child.on("error", reject);
  });
}

async function fetchChannels() {
  const res = await fetch(`${BACKEND}/api/channels`).catch(() => null);
  if (!res || !res.ok) {
    throw new Error("Renderly backend not reachable on 8022 — run start.bat first");
  }
  const channels = await res.json();
  return channels.map((c) => ({ id: c.id, name: c.name }));
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && req.url === "/api/status") {
      return sendJson(res, 200, {
        running: isRunning(),
        startedAt: run ? run.startedAt : null,
        currentCard: run ? run.currentCard : null,
        counts: run ? run.counts : { ok: 0, failed: 0, total: 0 },
        exitCode: run ? run.exitCode : null,
        log: run ? run.log.slice(-300) : [],
      });
    }
    if (req.method === "GET" && req.url === "/api/config") {
      return sendJson(res, 200, loadConfig());
    }
    if (req.method === "GET" && req.url === "/api/channels") {
      return sendJson(res, 200, await fetchChannels());
    }
    if (req.method === "POST" && req.url === "/api/pick/shotlist") {
      return sendJson(res, 200, {
        paths: await pickDialog("pick-file.ps1"),
      });
    }
    if (req.method === "POST" && req.url === "/api/pick/refs") {
      return sendJson(res, 200, { paths: await pickDialog("pick-refs.ps1") });
    }
    if (req.method === "POST" && req.url === "/api/pick/output") {
      return sendJson(res, 200, { paths: await pickDialog("pick-folder.ps1") });
    }
    if (req.method === "POST" && req.url === "/api/config") {
      const body = await readBody(req);
      const config = loadConfig();
      for (const key of ["shotlistPath", "outPath", "channel", "refs", "master"]) {
        if (typeof body[key] === "string") config[key] = body[key];
      }
      if (body.upscale !== undefined) config.upscale = Number(body.upscale) || 0;
      saveConfig(config);
      return sendJson(res, 200, config);
    }
    if (req.method === "POST" && req.url === "/api/start") {
      await readBody(req);
      startRun(loadConfig());
      return sendJson(res, 200, { started: true });
    }
    if (req.method === "POST" && req.url === "/api/stop") {
      await readBody(req);
      const stopped = stopRun();
      return sendJson(res, 200, { stopped });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[driver] Flow driver service on http://127.0.0.1:${PORT}`);
  console.log(`[driver] config: ${CONFIG_PATH}`);
});
