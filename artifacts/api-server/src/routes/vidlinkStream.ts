import { Router } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger";

// Resolve the assets directory whether running via tsx (src/routes/) or
// the esbuild bundle (dist/), or directly from the repo root on Replit.
function findAssetsDir(): string {
  // Option 1: sibling "assets" folder next to this file (production bundle at dist/)
  const localDir = path.dirname(fileURLToPath(import.meta.url));
  const next = path.join(localDir, "assets");
  if (existsSync(path.join(next, "fu.wasm"))) return next;
  // Option 2: one level up (development: src/routes/ → src/assets/)
  const up = path.join(localDir, "../assets");
  if (existsSync(path.join(up, "fu.wasm"))) return up;
  // Option 3: absolute repo path on Replit
  const repo = path.join(process.cwd(), "artifacts/api-server/src/assets");
  return repo;
}

const ASSETS_DIR = findAssetsDir();

const router = Router();

const REFERER = "https://vidlink.pro/";
const ORIGIN = "https://vidlink.pro";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124";

// ── WASM singleton ────────────────────────────────────────────────────────────
let wasmReady = false;
let bootPromise: Promise<void> | null = null;

function bootWasm(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    // Set up fake browser globals required by the Go WASM runtime
    (globalThis as any).window = globalThis;
    (globalThis as any).self = globalThis;
    (globalThis as any).document = {
      createElement: () => ({}),
      body: { appendChild: () => {} },
    };

    // libsodium must be initialised before the WASM boots
    const _require = createRequire(import.meta.url);
    const sodium = _require("libsodium-wrappers");
    await sodium.ready;
    (globalThis as any).sodium = sodium;

    // Evaluate the Go WASM runtime (defines globalThis.Dm)
    const scriptSrc = readFileSync(path.join(ASSETS_DIR, "script.js"), "utf8");
    // eslint-disable-next-line no-eval
    eval(scriptSrc);

    const go = new (globalThis as any).Dm();
    const wasmBuf = readFileSync(path.join(ASSETS_DIR, "fu.wasm"));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    // Give the WASM a moment to initialise
    await new Promise<void>((r) => setTimeout(r, 500));

    if (typeof (globalThis as any).getAdv !== "function") {
      throw new Error("getAdv not found after WASM boot");
    }
    wasmReady = true;
    logger.info("VidLink WASM booted successfully");
  })();
  return bootPromise;
}

async function getVidLinkStream(
  tmdbId: string,
  season?: number,
  episode?: number
): Promise<string> {
  await bootWasm();

  const token = (globalThis as any).getAdv(String(tmdbId));
  if (!token) throw new Error("getAdv returned null");

  const apiUrl =
    season != null
      ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode ?? 1}?multiLang=1`
      : `https://vidlink.pro/api/b/movie/${token}?multiLang=1`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`VidLink API returned ${res.status}`);

  type VidLinkResponse = { stream?: { playlist?: string } };
  const data = await res.json() as VidLinkResponse;
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error("No playlist URL in VidLink response");
  return playlist;
}

// Rewrite all relative/absolute segment and stream URLs in an m3u8
// so they route back through our /api/hls-proxy endpoint.
// Also rewrites URI= attributes inside #EXT-X-MEDIA tags (audio/subtitle tracks).
function rewriteM3u8(body: string, sourceUrl: string): string {
  const base = sourceUrl.split("?")[0];
  const baseDir = base.substring(0, base.lastIndexOf("/") + 1);
  const origin = new URL(sourceUrl).origin;

  function toAbsolute(uri: string): string {
    if (uri.startsWith("http")) return uri;
    if (uri.startsWith("/")) return origin + uri;
    return baseDir + uri;
  }

  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;

      // Rewrite URI="..." attributes inside HLS tag lines (e.g. #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF)
      if (t.startsWith("#") && t.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
          const abs = toAbsolute(uri);
          return `URI="/api/hls-proxy?url=${encodeURIComponent(abs)}"`;
        });
      }

      // Plain (non-comment) lines are segment or sub-playlist URLs
      if (!t.startsWith("#")) {
        return `/api/hls-proxy?url=${encodeURIComponent(toAbsolute(t))}`;
      }

      return line;
    })
    .join("\n");
}

// ── Secondary (fallback) stream resolver ────────────────────────────────────────
// Completely independent of VidLink — only called when VidLink fails.
// Uses moviesapi.club, a TMDB-based HLS aggregator, as a silent fallback.
async function getSecondaryStream(
  tmdbId: string,
  season?: number,
  episode?: number
): Promise<string> {
  const endpoint =
    season != null
      ? `https://moviesapi.club/tv/${tmdbId}-${season}-${episode ?? 1}`
      : `https://moviesapi.club/movie/${tmdbId}`;

  const res = await fetch(endpoint, {
    headers: {
      Referer: "https://moviesapi.club/",
      "User-Agent": UA,
      Accept: "application/json, */*",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Secondary source HTTP ${res.status}`);

  // API response shape: { streams: [{ url: "...m3u8...", label: "..." }], ... }
  type StreamEntry = { url?: string; label?: string };
  type SecondaryResponse = { streams?: StreamEntry[] };
  const data = await res.json() as SecondaryResponse;

  const streams: StreamEntry[] = Array.isArray(data?.streams) ? data.streams : [];
  // Prefer highest-quality stream (last entry is typically the highest resolution)
  const stream = streams[streams.length - 1]?.url ?? streams[0]?.url ?? null;
  if (!stream) {
    throw new Error("Secondary source returned no stream URL");
  }
  return stream;
}

// ── Route: resolve VidLink stream ──────────────────────────────────────────────
// GET /api/vidlink-stream?tmdbId=550&type=movie
// GET /api/vidlink-stream?tmdbId=1396&type=tv&season=1&episode=1
router.get("/vidlink-stream", async (req, res) => {
  const { tmdbId, type, season, episode } = req.query as Record<string, string>;

  if (!tmdbId) {
    res.status(400).json({ error: "Missing tmdbId" });
    return;
  }

  const s = season ? parseInt(season, 10) : undefined;
  const e = episode ? parseInt(episode, 10) : undefined;
  const isTV = type === "tv";

  // ── Primary: VidLink ──────────────────────────────────────────────────────────
  try {
    const playlist = await getVidLinkStream(tmdbId, isTV ? s : undefined, isTV ? e : undefined);
    // Return the proxied m3u8 URL so the client fetches it via our server (avoids CORS).
    // No-store prevents the browser from serving a 304 cached response for different episodes.
    const proxied = `/api/hls-proxy?url=${encodeURIComponent(playlist)}`;
    res.setHeader("Cache-Control", "no-store");
    res.json({ url: proxied });
    return;
  } catch (primaryErr: any) {
    logger.warn({ err: primaryErr.message }, "vidlink-stream primary failed — trying secondary");
  }

  // ── Fallback: secondary source (silent — client sees the same response shape) ─
  try {
    const playlist = await getSecondaryStream(tmdbId, isTV ? s : undefined, isTV ? e : undefined);
    const proxied = `/api/hls-proxy?url=${encodeURIComponent(playlist)}`;
    res.setHeader("Cache-Control", "no-store");
    res.json({ url: proxied });
  } catch (secondaryErr: any) {
    logger.warn({ err: secondaryErr.message }, "secondary source also failed");
    res.status(502).json({ error: "Stream unavailable from all sources" });
  }
});

// ── Route: HLS proxy — rewrites m3u8 playlists, passes segments through ───────
// GET /api/hls-proxy?url=https://cdn.example.com/master.m3u8
router.get("/hls-proxy", async (req, res) => {
  const raw = req.query.url;
  if (!raw || typeof raw !== "string") {
    res.status(400).json({ error: "Missing ?url=" });
    return;
  }

  let targetUrl: string;
  try {
    targetUrl = new URL(raw).toString();
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Referer: REFERER,
        Origin: ORIGIN,
        "User-Agent": UA,
        Accept: "*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream ${upstream.status}`);
      return;
    }

    const ct = (upstream.headers.get("content-type") || "").toLowerCase();
    const isM3u8 =
      ct.includes("mpegurl") ||
      ct.includes("m3u8") ||
      /\.m3u8?(\?|$)/i.test(targetUrl.split("?")[0]);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (isM3u8) {
      const text = await upstream.text();
      const rewritten = rewriteM3u8(text, targetUrl);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
    } else {
      // Segments / keys / other binary data — stream through
      res.setHeader("Content-Type", ct || "application/octet-stream");
      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);

      if (!upstream.body) { res.end(); return; }
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const ok = res.write(Buffer.from(value));
          if (!ok) await new Promise<void>((r) => res.once("drain", r));
        }
        res.end();
      };
      req.on("close", () => reader.cancel().catch(() => {}));
      pump().catch(() => res.end());
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "hls-proxy error");
    res.status(502).send(err.message);
  }
});

// Pre-warm on server startup so the first real request is fast
bootWasm().catch((err) => logger.warn({ err: err.message }, "WASM pre-warm failed (non-fatal)"));

export default router;
