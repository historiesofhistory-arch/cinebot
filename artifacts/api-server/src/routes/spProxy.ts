import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

const ALLOWED_HOST = "gemma416okl.com";

const DETECT_SCRIPT = `<script>
(function() {
  var sent = false;
  function check() {
    if (sent) return;
    var text = (document.body && (document.body.innerText || document.body.textContent)) || '';
    if (text && text.toLowerCase().includes('video not found')) {
      sent = true;
      window.parent.postMessage({ type: 'cinebot_video_not_found' }, '*');
    }
  }
  setInterval(check, 1500);
  document.addEventListener('DOMContentLoaded', function() {
    try { new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch(e) {}
    check();
  });
})();
</script>`;

// GET /api/sp-check?url=<encoded_sp_url>
// Lightweight availability check — HEAD request to SP, returns {available:bool}.
// A 404 from SP means the title is not in its library (true from any IP).
// A 200 means the page exists (the video may or may not stream from that IP).
router.get("/sp-check", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).json({ error: "url required" });

  let target: string;
  try {
    target = decodeURIComponent(raw);
    const u = new URL(target);
    if (u.hostname !== ALLOWED_HOST) return res.status(403).json({ error: "forbidden" });
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }

  try {
    const upstream = await fetch(target, {
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
        "Referer": "https://allmovielandapp.app/",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    logger.info({ target, status: upstream.status }, "sp-check");
    return res.json({ available: upstream.ok });
  } catch (err: any) {
    logger.warn({ err: err.message }, "sp-check fetch failed — treating as unavailable");
    return res.json({ available: false });
  }
});

// GET /api/sp-proxy?url=<encoded_sp_url>
// Fetches the SP player page, injects error-detection script, serves it.
// This makes it same-origin so we can postMessage errors back to our app.
router.get("/sp-proxy", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).send("url required");

  let target: string;
  try {
    target = decodeURIComponent(raw);
    const u = new URL(target);
    if (u.hostname !== ALLOWED_HOST) {
      return res.status(403).send("forbidden");
    }
  } catch {
    return res.status(400).send("invalid url");
  }

  logger.info({ target }, "sp-proxy fetch");

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://allmovielandapp.app/",
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!upstream.ok) {
      logger.warn({ status: upstream.status }, "sp-proxy upstream non-ok");
      return res.status(502).send("upstream error");
    }

    let html = await upstream.text();

    // Inject base tag so relative URLs resolve against the origin player
    const baseTag = `<base href="https://${ALLOWED_HOST}/">`;
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>${baseTag}`);
    } else if (html.includes("<HEAD>")) {
      html = html.replace("<HEAD>", `<HEAD>${baseTag}`);
    } else {
      html = baseTag + html;
    }

    // Inject detection script before </body>
    if (html.includes("</body>")) {
      html = html.replace("</body>", `${DETECT_SCRIPT}</body>`);
    } else if (html.includes("</BODY>")) {
      html = html.replace("</BODY>", `${DETECT_SCRIPT}</BODY>`);
    } else {
      html += DETECT_SCRIPT;
    }

    // Strip headers that would block embedding our proxied page
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.removeHeader("x-frame-options");
    res.removeHeader("content-security-policy");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    return res.send(html);
  } catch (err: any) {
    logger.error({ err: err.message }, "sp-proxy fetch failed");
    return res.status(502).send("proxy fetch failed");
  }
});

export default router;
