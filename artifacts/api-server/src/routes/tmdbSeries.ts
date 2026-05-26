import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();
const TMDB_BASE = "https://api.themoviedb.org/3";

router.get("/series-info", async (req, res) => {
  const { tmdbId } = req.query as Record<string, string>;
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "TMDB_API_KEY not configured" }); return; }
  if (!tmdbId)  { res.status(400).json({ error: "Missing tmdbId" }); return; }

  try {
    const r = await fetch(
      `${TMDB_BASE}/tv/${tmdbId}?api_key=${apiKey}&language=en-US`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) { res.status(r.status).json({ error: `TMDB ${r.status}` }); return; }
    const data = await r.json() as any;
    res.json({
      number_of_seasons: data.number_of_seasons ?? 0,
      seasons: (data.seasons ?? [])
        .filter((s: any) => s.season_number > 0)
        .map((s: any) => ({
          season_number:  s.season_number,
          name:           s.name,
          episode_count:  s.episode_count,
          poster_path:    s.poster_path ?? null,
          air_date:       s.air_date ?? null,
        })),
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, "series-info error");
    res.status(502).json({ error: err.message });
  }
});

router.get("/season-episodes", async (req, res) => {
  const { tmdbId, season } = req.query as Record<string, string>;
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "TMDB_API_KEY not configured" }); return; }
  if (!tmdbId || !season) { res.status(400).json({ error: "Missing tmdbId or season" }); return; }

  try {
    const r = await fetch(
      `${TMDB_BASE}/tv/${tmdbId}/season/${season}?api_key=${apiKey}&language=en-US`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) { res.status(r.status).json({ error: `TMDB ${r.status}` }); return; }
    const data = await r.json() as any;
    res.json({
      episodes: (data.episodes ?? []).map((e: any) => ({
        episode_number: e.episode_number,
        name:           e.name,
        overview:       e.overview ?? "",
        still_path:     e.still_path ?? null,
        runtime:        e.runtime ?? null,
        air_date:       e.air_date ?? null,
      })),
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, "season-episodes error");
    res.status(502).json({ error: err.message });
  }
});

export default router;
