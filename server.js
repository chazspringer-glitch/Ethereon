// Minimal Ethereon leaderboard + static file server.
//
// Run:   node server.js
// Env:   PORT (default 8080), DATA_FILE (default ./leaderboard.json)
//
// Endpoints:
//   GET  /                   -> serve index.html / game.js / style.css
//   GET  /api/leaderboard    -> top 50 entries by score (desc)
//   POST /api/leaderboard    -> body = { name, score, stats?, at? }
//
// Storage is a flat JSON file on disk. Atomic writes (write temp
// then rename) so a crash mid-save can't corrupt the store.
//
// Wire the client by adding a <script> tag to index.html that
// sets window.ETHEREON_API BEFORE game.js loads, for example:
//   <script>window.ETHEREON_API = "/api/leaderboard";</script>
//   <script src="game.js"></script>

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "leaderboard.json");
const ROOT = __dirname;

// ---- Leaderboard store -----------------------------------------
// Keep the roster in memory and flush to disk after each write.
// The roster is trimmed to MAX_ENTRIES so the file size stays
// bounded even under a flood of submissions.
const MAX_ENTRIES = 500;
const MAX_NAME_LEN = 14;
let entries = [];
try {
    if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) entries = parsed;
    }
} catch (err) {
    console.error("[leaderboard] failed to load store:", err.message);
    entries = [];
}

function saveEntries() {
    const tmp = DATA_FILE + ".tmp";
    const data = JSON.stringify(entries);
    fs.writeFile(tmp, data, (err) => {
        if (err) {
            console.error("[leaderboard] write failed:", err.message);
            return;
        }
        fs.rename(tmp, DATA_FILE, (renameErr) => {
            if (renameErr) {
                console.error("[leaderboard] rename failed:", renameErr.message);
            }
        });
    });
}

function sanitizeEntry(body) {
    if (!body || typeof body !== "object") return null;
    const name = String(body.name || "").trim().slice(0, MAX_NAME_LEN) || "Anon";
    const score = Math.max(0, Math.min(9999999, Math.floor(Number(body.score) || 0)));
    if (score === 0) return null;
    const stats = (body.stats && typeof body.stats === "object")
        ? {
            enemiesKilled:   Math.max(0, Math.floor(Number(body.stats.enemiesKilled)   || 0)),
            wavesSurvived:   Math.max(0, Math.floor(Number(body.stats.wavesSurvived)   || 0)),
            bossesDefeated:  Math.max(0, Math.floor(Number(body.stats.bossesDefeated)  || 0)),
            giantsDefeated:  Math.max(0, Math.floor(Number(body.stats.giantsDefeated)  || 0)),
            survivalTime:    Math.max(0, Math.floor(Number(body.stats.survivalTime)    || 0)),
            megaTriBeamUses: Math.max(0, Math.floor(Number(body.stats.megaTriBeamUses) || 0)),
            deaths:          Math.max(0, Math.floor(Number(body.stats.deaths)          || 0)),
            multiKillBest:   Math.max(0, Math.floor(Number(body.stats.multiKillBest)   || 0)),
        }
        : null;
    return { name, score, stats, at: Date.now() };
}

function top(limit) {
    return entries
        .slice()
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, limit);
}

// ---- Static file server ----------------------------------------
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".json": "application/json",
};

function safeJoin(base, rel) {
    const resolved = path.normalize(path.join(base, rel));
    if (!resolved.startsWith(base)) return null;
    return resolved;
}

function serveStatic(req, res) {
    let url = req.url.split("?")[0];
    if (url === "/") url = "/index.html";
    const filePath = safeJoin(ROOT, url);
    if (!filePath) {
        res.writeHead(400); res.end("Bad path"); return;
    }
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404); res.end("Not found"); return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Cache-Control": "no-cache",
        });
        fs.createReadStream(filePath).pipe(res);
    });
}

// ---- API handlers ----------------------------------------------
function setCors(res) {
    // Permissive CORS so the client works even when served from
    // a different origin (e.g. CDN front + API backend).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleGetLeaderboard(_req, res) {
    setCors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(top(50)));
}

function handlePostLeaderboard(req, res) {
    setCors(res);
    let buf = "";
    let tooBig = false;
    req.on("data", (chunk) => {
        buf += chunk;
        if (buf.length > 4096) tooBig = true;
    });
    req.on("end", () => {
        if (tooBig) {
            res.writeHead(413); res.end("Payload too large"); return;
        }
        let body = null;
        try { body = JSON.parse(buf); }
        catch (_e) {
            res.writeHead(400); res.end("Invalid JSON"); return;
        }
        const entry = sanitizeEntry(body);
        if (!entry) {
            res.writeHead(400); res.end("Invalid entry"); return;
        }
        entries.push(entry);
        entries.sort((a, b) => (b.score || 0) - (a.score || 0));
        if (entries.length > MAX_ENTRIES) {
            entries.length = MAX_ENTRIES;
        }
        saveEntries();
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    req.on("error", (err) => {
        console.error("[leaderboard] request error:", err.message);
        try { res.writeHead(500); res.end("Internal error"); } catch (_e) {}
    });
}

// ---- Router ----------------------------------------------------
const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (req.method === "OPTIONS") {
        setCors(res);
        res.writeHead(204); res.end(); return;
    }

    if (url === "/api/leaderboard") {
        if (req.method === "GET")  return handleGetLeaderboard(req, res);
        if (req.method === "POST") return handlePostLeaderboard(req, res);
        res.writeHead(405); res.end("Method not allowed"); return;
    }

    if (req.method === "GET") return serveStatic(req, res);

    res.writeHead(405); res.end("Method not allowed");
});

server.listen(PORT, () => {
    console.log(`Ethereon server listening on http://localhost:${PORT}`);
    console.log(`Leaderboard store: ${DATA_FILE}`);
});
