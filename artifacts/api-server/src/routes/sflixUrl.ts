import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

const SFLIX_SEARCH = "https://sflix.film/wefeed-h5api-bff/subject/search";
const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
  "Referer": "https://sflix.film/",
  "Origin": "https://sflix.film",
  "Accept": "application/json",
};

function similarity(a: string, b: string): number {
  a = a.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  b = b.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const aWords = new Set(a.split(" "));
  const bWords = b.split(" ");
  const overlap = bWords.filter(w => aWords.has(w)).length;
  return overlap / Math.max(aWords.size, bWords.length);
}

// GET /api/sflix-url?title=&type=movie|tv&season=&episode=
router.get("/sflix-url", async (req, res) => {
  const { title, type, season, episode } = req.query as Record<string, string>;
  if (!title) return res.status(400).json({ error: "title required" });

  logger.info({ title, type, season, episode }, "sflix-url lookup");

  try {
    // Search without subjectType filter so we catch both movies and TV
    const searchBody = JSON.stringify({
      keyword: title,
      page: 1,
      perPage: 15,
    });

    const searchRes = await fetch(SFLIX_SEARCH, {
      method: "POST",
      headers: HEADERS,
      body: searchBody,
      signal: AbortSignal.timeout(12000),
    });

    if (!searchRes.ok) {
      logger.warn({ status: searchRes.status }, "sflix search non-ok");
      return res.status(502).json({ error: "sflix search failed" });
    }

    const data = await searchRes.json();
    const items: any[] = data?.data?.items ?? [];
    if (!items.length) {
      return res.status(404).json({ error: "not found on sflix" });
    }

    // Pick best match by title similarity
    const scored = items.map((item: any) => ({
      item,
      score: similarity(title, item.title ?? ""),
    })).sort((a, b) => b.score - a.score);

    const best = scored[0].item;
    const { subjectId, detailPath, subjectType } = best;

    // subjectType 1 = movie, 2 = TV/series
    const pathSegment = subjectType === 2 ? "tv-series" : "movies";
    const typeParam   = subjectType === 2 ? "/tv/detail"  : "/movie/detail";

    let url = `https://sflix.film/spa/videoPlayPage/${pathSegment}/${detailPath}?id=${subjectId}&type=${typeParam}&lang=en`;

    if (subjectType === 2 && season && episode) {
      url += `&ep=${episode}&season=${season}`;
    }

    logger.info({ url, score: scored[0].score }, "sflix-url resolved");
    return res.json({ url });

  } catch (err: any) {
    logger.error({ err: err.message }, "sflix-url error");
    return res.status(502).json({ error: "sflix fetch failed" });
  }
});

export default router;
