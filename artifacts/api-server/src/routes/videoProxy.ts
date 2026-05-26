import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

router.get("/video-proxy", async (req, res) => {
  const raw = req.query.url;
  if (!raw || typeof raw !== "string") {
    res.status(400).json({ error: "Missing ?url= parameter" });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(raw);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  const rangeHeader = req.headers["range"];

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
      return;
    }

    const contentType =
      upstream.headers.get("content-type") || "video/mp4";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);
    if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
    else res.setHeader("Accept-Ranges", "bytes");

    res.status(upstream.status);

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise<void>((r) => res.once("drain", r));
        }
      }
      res.end();
    };

    req.on("close", () => reader.cancel().catch(() => {}));
    pump().catch((err) => {
      logger.warn({ err: err.message }, "video-proxy stream error");
      res.end();
    });
  } catch (err: any) {
    logger.error({ err: err.message }, "video-proxy error");
    res.status(502).send(`Proxy error: ${err.message}`);
  }
});

export default router;
