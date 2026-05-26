import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

const RD_BASE = "https://api.real-debrid.com/rest/1.0";
const TORRENTIO_BASE = "https://torrentio.strem.fun";

type TorrentioStream = {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: { bingeGroup?: string; filename?: string };
};

type RDInstantFile = { filename: string; filesize: number };
type RDInstantVariant = { [fileId: string]: RDInstantFile };
type RDInstantResult = RDInstantVariant[];
type RDInstantAvailability = {
  [hash: string]: { rd?: RDInstantResult } | RDInstantResult;
};

type RDTorrentAdded = { id: string; uri: string };
type RDTorrentInfo = {
  id: string;
  status: string;
  links: string[];
  files?: { id: number; path: string; bytes: number; selected: number }[];
};
type RDUnrestricted = {
  download: string;
  filename: string;
  mimeType?: string;
};

function rdHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

async function rdFetch<T>(
  apiKey: string,
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${RD_BASE}${path}`, {
    ...opts,
    headers: { ...rdHeaders(apiKey), ...(opts.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`RD ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function torrentioStreams(
  type: "movie" | "series",
  imdbId: string,
  season?: number,
  episode?: number
): Promise<TorrentioStream[]> {
  const slug =
    type === "movie"
      ? `movie/${imdbId}`
      : `series/${imdbId}:${season ?? 1}:${episode ?? 1}`;
  const url = `${TORRENTIO_BASE}/stream/${slug}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Torrentio ${res.status}`);
  const data = (await res.json()) as { streams?: TorrentioStream[] };
  return data.streams ?? [];
}

const QUALITY_ORDER = ["2160p", "1080p", "720p", "480p"];

function rankQuality(stream: TorrentioStream): number {
  const text = (stream.name ?? stream.title ?? "").toUpperCase();
  for (let i = 0; i < QUALITY_ORDER.length; i++) {
    if (text.includes(QUALITY_ORDER[i].toUpperCase())) return i;
  }
  return QUALITY_ORDER.length;
}

function getQualityLabel(stream: TorrentioStream): string {
  return (
    QUALITY_ORDER.find((q) =>
      (stream.name ?? "").toUpperCase().includes(q.toUpperCase())
    ) ?? "HD"
  );
}

async function checkInstantAvailability(
  apiKey: string,
  hashes: string[]
): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const joined = hashes.join("/");
  try {
    const data = await rdFetch<RDInstantAvailability>(
      apiKey,
      `/torrents/instantAvailability/${joined}`
    );
    const cached = new Set<string>();
    for (const [hash, val] of Object.entries(data)) {
      // val is { rd: [...] } and rd array must be non-empty
      const rd = (val as any).rd;
      if (Array.isArray(rd) && rd.length > 0) {
        cached.add(hash.toLowerCase());
      }
    }
    return cached;
  } catch (err: any) {
    logger.warn({ err: err.message }, "instant availability check failed");
    return new Set();
  }
}

async function unrestrict(
  apiKey: string,
  infoHash: string,
  fileIdx: number | undefined
): Promise<string | null> {
  const magnet = `magnet:?xt=urn:btih:${infoHash}`;

  const added = await rdFetch<RDTorrentAdded>(apiKey, "/torrents/addMagnet", {
    method: "POST",
    body: new URLSearchParams({ magnet }),
  });
  const torrentId = added.id;

  await rdFetch(apiKey, `/torrents/selectFiles/${torrentId}`, {
    method: "POST",
    body: new URLSearchParams({ files: "all" }),
  });

  const info = await rdFetch<RDTorrentInfo>(
    apiKey,
    `/torrents/info/${torrentId}`
  );

  if (info.status !== "downloaded") {
    await rdFetch(apiKey, `/torrents/delete/${torrentId}`, {
      method: "DELETE",
    });
    return null;
  }

  const links = info.links ?? [];
  const link =
    fileIdx !== undefined && fileIdx < links.length
      ? links[fileIdx]
      : links[0];
  if (!link) return null;

  const unrestricted = await rdFetch<RDUnrestricted>(
    apiKey,
    "/unrestrict/link",
    { method: "POST", body: new URLSearchParams({ link }) }
  );

  return unrestricted.download ?? null;
}

router.get("/resolve-stream", async (req, res) => {
  const { imdbId, tmdbId, type, season, episode } = req.query as Record<
    string,
    string
  >;

  const apiKey = process.env.REAL_DEBRID_API_KEY ?? "";
  if (!apiKey) {
    res.status(503).json({ error: "REAL_DEBRID_API_KEY not configured" });
    return;
  }

  const lookupId = imdbId || tmdbId;
  if (!lookupId) {
    res.status(400).json({ error: "imdbId or tmdbId required" });
    return;
  }

  const mediaType = type === "tv" || type === "anime" ? "series" : "movie";
  const s = season ? parseInt(season, 10) : 1;
  const e = episode ? parseInt(episode, 10) : 1;

  try {
    const streams = await torrentioStreams(
      mediaType,
      lookupId,
      mediaType === "series" ? s : undefined,
      mediaType === "series" ? e : undefined
    );

    if (!streams.length) {
      res.json({ url: null, reason: "no_torrents" });
      return;
    }

    const withHash = streams.filter((s) => s.infoHash);
    const sorted = [...withHash].sort((a, b) => rankQuality(a) - rankQuality(b));

    // Check which hashes are instantly available in RD (cached)
    const hashes = sorted.map((s) => s.infoHash!.toLowerCase());
    const cached = await checkInstantAvailability(apiKey, hashes);

    // Prioritize cached streams, then fall back to uncached
    const cachedStreams = sorted.filter((s) =>
      cached.has(s.infoHash!.toLowerCase())
    );
    const uncachedStreams = sorted.filter(
      (s) => !cached.has(s.infoHash!.toLowerCase())
    );

    logger.info(
      { total: sorted.length, cached: cachedStreams.length },
      "RD availability check"
    );

    // Try cached first (fast), then a couple uncached as fallback
    const candidates = [...cachedStreams.slice(0, 5), ...uncachedStreams.slice(0, 2)];

    for (const stream of candidates) {
      try {
        const url = await unrestrict(apiKey, stream.infoHash!, stream.fileIdx);
        if (url) {
          const quality = getQualityLabel(stream);
          logger.info(
            { lookupId, quality, cached: cached.has(stream.infoHash!.toLowerCase()) },
            "Resolved stream via Real-Debrid"
          );
          res.json({ url, quality, source: "realdebrid" });
          return;
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, "RD unrestrict failed");
      }
    }

    res.json({ url: null, reason: "not_cached" });
  } catch (err: any) {
    logger.error({ err: err.message }, "resolve-stream error");
    res.json({ url: null, reason: "error", detail: err.message });
  }
});

export default router;
