import { Router } from "express";

const router = Router();

const AD_HOSTS = [
  'googlesyndication', 'doubleclick', 'googletag', 'adnxs', 'adsrvr',
  'outbrain', 'taboola', 'juicyads', 'exoclick', 'trafficjunky',
  'hilltopads', 'plugrush', 'trafficforce', 'popads', 'propellerads',
  'adsterra', 'adcash', 'adroll', 'adform', 'bidvertiser', 'clickadu',
  'revcontent', 'mgid', 'zedo', 'rubiconproject', 'openx', 'pubmatic',
  'smartadserver', 'criteo', 'adskeeper', 'richpush', 'adspyglass',
  'popunder', 'clickunder', 'trafficstars', 'adspeed', 'ad-maven',
  'admaven', 'popcash', 'adx1', 'adtelligent', 'appnexus', 'conversant',
  'valueclick', 'undertone', 'yieldmo', 'sharethrough', 'spotxchange',
  'adscore', 'prebid', 'amazon-adsystem', 'moatads', 'imasdk',
  'cortexads', 'cortex', 'exco', 'teads', 'inmobi', 'inneractive',
  'smartclip', 'spotx', 'springserve', 'freewheel', 'yume',
];

const AD_PATTERNS = new RegExp(
  `<script[^>]*src=["'][^"']*(?:${AD_HOSTS.join('|')})[^"']*["'][^>]*>.*?</script>`,
  'gis'
);
const AD_SELF_CLOSE = new RegExp(
  `<script[^>]*src=["'][^"']*(?:${AD_HOSTS.join('|')})[^"']*["'][^>]*/?>`,
  'gis'
);

/**
 * SHIELD v4 — comprehensive redirect & click-trap blocking.
 *
 * Key improvements over v3:
 *  1.  Fetch/XHR relative calls are now re-routed through OUR proxy server
 *      (instead of directly to the target) so that CORS headers are added
 *      and players like VidLink that make API calls can load properly.
 *  2.  Sub-iframes created inside the proxied page are sandboxed WITHOUT
 *      allow-top-navigation, so nested ad iframes cannot redirect the
 *      Telegram/parent window. The main player iframe is not sandboxed.
 *  3.  Invisible overlay detection is more aggressive — checks background,
 *      opacity, pointer-events, and elements covering the full player area.
 *  4.  window.top / window.parent navigation is also blocked.
 */
function makeShield(targetOrigin: string): string {
  const T = JSON.stringify(targetOrigin);
  // Sub-iframe sandbox: allow everything useful EXCEPT top-navigation & popups
  const SUB_SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock allow-downloads allow-presentation';

  return `<script>
(function() {
  'use strict';
  var T = ${T};
  var P = window.location.origin; // our proxy origin (same as API server origin)

  var PLAYER_SIG = /player|video|jw|plyr|vjs|control|hls|dash|stream|shaka|jwplayer|media|cinema|primeplayer/i;

  // Navigation safety: ONLY allow hash-only changes (e.g. #t=30).
  // ALL other navigations (even to the same origin) are blocked — they are
  // redirect hops used by ad networks. Fetch/XHR are handled separately.
  function isSafe(url) {
    if (!url || typeof url !== 'string') return true;
    var s = url.trim();
    if (!s) return true;
    if (s.charAt(0) === '#') return true;           // hash-only — safe
    if (s.indexOf('javascript:') === 0) return true; // JS void — safe
    if (s.indexOf('blob:') === 0) return true;       // blob URL — safe
    if (s.indexOf('data:') === 0) return true;       // data URL — safe
    return false; // block EVERYTHING else (including same-origin navigations)
  }

  // History safety: allow same-origin pushState for SPA routing inside the player
  function isHistorySafe(url) {
    if (!url) return true;
    var s = String(url).trim();
    if (!s || s.charAt(0) === '#' || s.charAt(0) === '/') return true;
    if (s.indexOf('javascript:') === 0) return true;
    try {
      var u = new URL(s, window.location.href);
      return u.origin === window.location.origin;
    } catch(e) { return true; }
  }

  var AD_KEYWORDS = [${AD_HOSTS.map(h => JSON.stringify(h)).join(',')}];
  function isAdHost(src) {
    if (!src) return false;
    for (var i = 0; i < AD_KEYWORDS.length; i++) {
      if (src.indexOf(AD_KEYWORDS[i]) !== -1) return true;
    }
    return false;
  }

  // ── 1. Route relative fetch / XHR through OUR proxy (fixes CORS + player APIs) ──
  // Instead of redirecting to target directly (CORS block), we route through
  // our own /api/stream-proxy which adds correct headers.
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      var s = input.trim();
      if (s.charAt(0) === '/' && s.charAt(1) !== '/') {
        // Relative path → proxy through our server
        input = P + '/api/stream-proxy?url=' + encodeURIComponent(T + s);
      } else if (s.indexOf('//') === 0) {
        // Protocol-relative
        input = 'https:' + s;
      }
    }
    return _fetch.call(this, input, init);
  };

  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    var url = String(arguments[1] || '');
    if (url.charAt(0) === '/' && url.charAt(1) !== '/') {
      arguments[1] = P + '/api/stream-proxy?url=' + encodeURIComponent(T + url);
    } else if (url.indexOf('//') === 0) {
      arguments[1] = 'https:' + url;
    }
    return _xhrOpen.apply(this, arguments);
  };

  // ── 2. Block ALL navigation (location / history) ─────────────────────────
  try {
    var locDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (locDesc && locDesc.set) {
      Object.defineProperty(Location.prototype, 'href', {
        get: locDesc.get,
        set: function(v) { if (isSafe(v)) locDesc.set.call(this, v); },
        configurable: true,
      });
    }
  } catch(e) {}

  var _assign  = Location.prototype.assign;
  var _replace = Location.prototype.replace;
  Location.prototype.assign  = function(url) { if (isSafe(url)) _assign.call(this, url);  };
  Location.prototype.replace = function(url) { if (isSafe(url)) _replace.call(this, url); };

  // Block window.top / window.parent navigation attempts
  // (cross-origin iframes CAN set top.location in many browsers)
  try {
    ['top','parent'].forEach(function(prop) {
      var orig = window[prop];
      if (!orig || orig === window) return;
      try {
        var d = Object.getOwnPropertyDescriptor(orig, 'location');
        if (d && d.set) {
          Object.defineProperty(orig, 'location', {
            get: d.get,
            set: function(v) {
              if (typeof v === 'string' && !isSafe(v)) return;
              d.set.call(this, v);
            },
            configurable: true,
          });
        }
      } catch(e2) {}
    });
  } catch(e) {}

  var _hPush = history.pushState.bind(history);
  var _hRep  = history.replaceState.bind(history);
  history.pushState    = function(s, t, u) { if (!u || isHistorySafe(String(u))) _hPush(s, t, u);  };
  history.replaceState = function(s, t, u) { if (!u || isHistorySafe(String(u))) _hRep(s, t, u);   };

  // Block document.location assignments (alias for window.location)
  try {
    var docLocDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'location') ||
                     Object.getOwnPropertyDescriptor(document, 'location');
    if (docLocDesc && docLocDesc.set) {
      Object.defineProperty(document, 'location', {
        get: docLocDesc.get,
        set: function(v) { if (isSafe(String(v || ''))) docLocDesc.set.call(this, v); },
        configurable: true,
      });
    }
  } catch(e) {}

  // Block meta refresh tags (dynamically added)
  function killMetaRefresh() {
    var metas = document.querySelectorAll('meta[http-equiv]');
    for (var m = 0; m < metas.length; m++) {
      var he = (metas[m].getAttribute('http-equiv') || '').toLowerCase();
      if (he === 'refresh') { try { metas[m].remove(); } catch(e) {} }
    }
  }
  setTimeout(killMetaRefresh, 50);
  setTimeout(killMetaRefresh, 500);

  // ── 3. Block popups / prompts / service workers ───────────────────────────
  window.open    = function() { return null; };
  window.alert   = function() {};
  window.confirm = function() { return false; };
  window.prompt  = function() { return null; };
  try { window.Notification = function() {}; window.Notification.requestPermission = function() { return Promise.resolve('denied'); }; } catch(e) {}
  try { navigator.serviceWorker.register = function() { return Promise.reject(); }; } catch(e) {}

  // ── 4. Intercept createElement — sandbox sub-iframes, neuter ext anchors ─
  var SUB_SANDBOX = '${SUB_SANDBOX}';
  var _createElement = document.createElement.bind(document);

  document.createElement = function(tag) {
    var el = _createElement.apply(document, arguments);
    if (typeof tag !== 'string') return el;
    var t = tag.toLowerCase();

    if (t === 'iframe') {
      // Pre-apply sandbox to any dynamically created sub-iframe.
      // This runs BEFORE src is set, so it applies to the loaded page.
      var _setAttr = el.setAttribute.bind(el);
      var sandboxApplied = false;
      function applySandbox() {
        if (!sandboxApplied && !el.getAttribute('sandbox')) {
          sandboxApplied = true;
          _setAttr('sandbox', SUB_SANDBOX);
        }
      }
      el.setAttribute = function(name, value) {
        if (name.toLowerCase() === 'src') applySandbox();
        _setAttr(name, value);
      };
      // Also catch direct .src = '...' property assignment
      try {
        var srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
        if (srcDesc && srcDesc.set) {
          Object.defineProperty(el, 'src', {
            get: srcDesc.get,
            set: function(v) { applySandbox(); srcDesc.set.call(el, v); },
            configurable: true,
          });
        }
      } catch(e) {}
    }

    if (t === 'a') {
      var _setAttrA = el.setAttribute.bind(el);
      el.setAttribute = function(name, value) {
        if (name.toLowerCase() === 'href' && !isSafe(value)) {
          _setAttrA('href', 'javascript:void(0)');
          return;
        }
        _setAttrA(name, value);
      };
    }

    return el;
  };

  // ── 5. MutationObserver — watch dynamically added nodes ───────────────────
  function processNode(node) {
    if (!node || node.nodeType !== 1) return;
    var tag = node.tagName;

    if (tag === 'IFRAME') {
      var src = node.src || node.getAttribute('src') || '';
      // Remove pure ad iframes
      if (src && !isSafe(src) && !PLAYER_SIG.test(node.className + ' ' + (node.id || ''))) {
        try { node.remove(); } catch(e) {}
        return;
      }
      // Sandbox any sub-iframe that doesn't already have sandbox
      if (!node.getAttribute('sandbox')) {
        node.setAttribute('sandbox', SUB_SANDBOX);
      }
    }

    if (tag === 'A') {
      var href = node.getAttribute('href') || '';
      if (href && !isSafe(href)) {
        node.setAttribute('href', 'javascript:void(0)');
        if (!node.__shielded) {
          node.__shielded = true;
          node.addEventListener('click', function(e) { e.preventDefault(); e.stopImmediatePropagation(); }, true);
        }
      }
    }

    if (tag === 'SCRIPT') {
      var scriptSrc = node.src || node.getAttribute('src') || '';
      if (isAdHost(scriptSrc)) { try { node.remove(); } catch(e) {} return; }
    }
  }

  // Debounced sweep — fires sweepOverlays shortly after any DOM change so
  // re-injected ad divs (not caught by processNode) are cleaned up quickly.
  var _sweepTimer = 0;
  function debouncedSweep() {
    clearTimeout(_sweepTimer);
    _sweepTimer = _sT(sweepOverlays, 120);
  }

  var observer = new MutationObserver(function(mutations) {
    var hasNew = false;
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        processNode(added[j]);
        if (added[j].querySelectorAll) {
          var ch = added[j].querySelectorAll('a[href], iframe, script[src]');
          for (var k = 0; k < ch.length; k++) processNode(ch[k]);
        }
        if (added[j].nodeType === 1) hasNew = true;
      }
    }
    // If any element node was added, schedule a quick overlay sweep
    if (hasNew) debouncedSweep();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ── 6. Capture-phase click handler — block overlays & external anchors ────
  function isInvisibleOverlay(el) {
    try {
      var st = window.getComputedStyle(el);
      if (parseFloat(st.opacity) < 0.05) return true;
      if (st.pointerEvents === 'none') return false;
      var bg = st.backgroundColor || '';
      var hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
      if (!hasBg) {
        // No visible background — if no content, it's a click trap
        var text = (el.textContent || '').trim();
        if (!text && !el.querySelector('img, video, canvas, svg, button, input, span')) {
          return true;
        }
      }
    } catch(e) {}
    return false;
  }

  function blockIfBad(e) {
    var el = e.target;
    if (!el || el === document || el === document.body || el === document.documentElement) return;
    var tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'CANVAS') return;

    var r;
    try { r = el.getBoundingClientRect(); } catch(err) { return; }

    // Zero-size invisible trap
    if (r.width === 0 && r.height === 0) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }

    // Invisible / transparent overlay (click-jacking layer)
    if (isInvisibleOverlay(el)) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }

    // Large viewport overlay with high z-index that isn't the player
    if (r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.8) {
      try {
        var st2 = window.getComputedStyle(el);
        var zi = parseInt(st2.zIndex) || 0;
        if (zi > 5 && tag !== 'IFRAME' && tag !== 'VIDEO') {
          var sig2 = (el.id || '') + ' ' + (el.className || '');
          if (!PLAYER_SIG.test(sig2)) {
            e.preventDefault(); e.stopImmediatePropagation(); return;
          }
        }
      } catch(e3) {}
    }

    // External anchor
    var a = el.closest ? el.closest('a[href]') : null;
    if (a) {
      var h = a.getAttribute('href') || '';
      if (h && !isSafe(h)) {
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
    }
  }

  // touchend (not touchstart) is used for taps on Android — block bad targets there too
  function blockIfBadTouch(e) {
    // Run the same full check as click/mousedown
    blockIfBad(e);
    // Extra: block any touch on an anchor pointing outside
    var el = e.target;
    if (!el) return;
    var a = el.closest ? el.closest('a[href]') : null;
    if (a) {
      var h = a.getAttribute('href') || '';
      if (h && !isSafe(h)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }
  }

  document.addEventListener('click',      blockIfBad,       { capture: true });
  document.addEventListener('mousedown',  blockIfBad,       { capture: true });
  document.addEventListener('touchstart', blockIfBadTouch,  { capture: true, passive: false });
  document.addEventListener('touchend',   blockIfBadTouch,  { capture: true, passive: false });

  // ── 7. Periodic DOM sweep — kill ad overlays & click traps ───────────────
  // Keywords found in ad popups: webcam/chat/dating/adult content
  var AD_TEXT_RE = /webcam|chatting|dating|girls\s*are|boys\s*are|waiting\s*for\s*you|i.m\s*online|chat\s*with\s*me|casino|free\s*spin|you\s*won|congratulations|click\s*here\s*to|subscribe\s*now|notification|install\s*app|download\s*now|sex|porn|escort|onlyfans|adult/i;

  function isAdElement(el) {
    try {
      var txt = (el.innerText || el.textContent || '').trim();
      if (txt && AD_TEXT_RE.test(txt)) return true;
      var sig = (el.id || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute('data-type') || '');
      if (/ad|popup|overlay|banner|modal|interstitial|promo|sponsor/i.test(sig) && !PLAYER_SIG.test(sig)) return true;
    } catch(e) {}
    return false;
  }

  function sweepOverlays() {
    // Neuter anchors pointing to external domains (not target origin)
    var anchors = document.querySelectorAll('a[href]');
    for (var j = 0; j < anchors.length; j++) {
      var anchor = anchors[j];
      if (!anchor.__shielded) {
        anchor.__shielded = true;
        var href = anchor.getAttribute('href') || '';
        // Only neuter anchors pointing to a different origin from the target
        var isExternal = false;
        try {
          if (href && href.charAt(0) !== '#' && href.indexOf('javascript:') !== 0) {
            var u = new URL(href, window.location.href);
            isExternal = (u.origin !== T && u.origin !== P);
          }
        } catch(e) {}
        if (isExternal) {
          anchor.setAttribute('href', 'javascript:void(0)');
          anchor.addEventListener('click', function(ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }, true);
        }
      }
    }

    // Sandbox existing un-sandboxed iframes
    var iframes = document.querySelectorAll('iframe:not([sandbox])');
    for (var fi = 0; fi < iframes.length; fi++) {
      iframes[fi].setAttribute('sandbox', SUB_SANDBOX);
    }

    // Neuter ALL forms — block form-based redirects
    var forms = document.querySelectorAll('form:not([data-shielded])');
    for (var ff = 0; ff < forms.length; ff++) {
      forms[ff].setAttribute('data-shielded', '1');
      forms[ff].addEventListener('submit', function(ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }, true);
    }

    // Remove/neuter overlaid ad elements
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var tag = el.tagName;
      if (tag === 'IFRAME' || tag === 'VIDEO' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'CANVAS' || tag === 'HTML' || tag === 'BODY') continue;
      if (el.__adRemoved) continue;

      var st;
      try { st = window.getComputedStyle(el); } catch(err) { continue; }

      // Kill elements with ad text content anywhere on page (chat/adult popups)
      if (isAdElement(el)) {
        el.__adRemoved = true;
        el.style.display = 'none';
        try { el.remove(); } catch(e) {}
        continue;
      }

      if (st.position !== 'fixed' && st.position !== 'absolute') continue;
      var zi = parseInt(st.zIndex) || 0;
      if (zi < 5) continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch(err2) { continue; }

      var sig = (el.id || '') + ' ' + (el.className || '');
      if (PLAYER_SIG.test(sig)) continue;

      // Any overlay with opacity < 0.05 → disable pointer events
      var op = parseFloat(st.opacity);
      if (op < 0.05) { el.style.pointerEvents = 'none'; continue; }

      // Large high-z overlay → remove (lowered threshold from zi>=400 to zi>=50)
      if (zi >= 50 && r.width >= window.innerWidth * 0.4 && r.height >= window.innerHeight * 0.25) {
        el.__adRemoved = true;
        el.style.display = 'none';
        try { el.remove(); } catch(e) {}
        continue;
      }

      // Transparent background, no meaningful content → disable pointer events
      var bg = st.backgroundColor || '';
      if ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && zi > 10) {
        var text = (el.textContent || '').trim();
        if (!text && !el.querySelector('img,video,canvas,svg,button,input')) {
          el.style.pointerEvents = 'none';
        }
      }
    }
  }

  setTimeout(sweepOverlays, 200);
  setTimeout(sweepOverlays, 800);
  setTimeout(sweepOverlays, 2000);
  setTimeout(sweepOverlays, 4000);
  window.addEventListener('load', function() {
    sweepOverlays();
    setInterval(sweepOverlays, 2500);
  });

  // ── 8. Block setTimeout/setInterval string-based redirect calls ───────────
  var _sT = window.setTimeout;
  var _sI = window.setInterval;
  var REDIR_RE = /location\s*[=.]/;
  window.setTimeout  = function(fn, d) { if (typeof fn === 'string' && REDIR_RE.test(fn)) return 0; return _sT.apply(window, arguments); };
  window.setInterval = function(fn, d) { if (typeof fn === 'string' && REDIR_RE.test(fn)) return 0; return _sI.apply(window, arguments); };

  // ── 9. Neuter document.write — filter ad scripts ──────────────────────────
  // NOTE: '<' + '/script>' split prevents HTML parser from closing this block.
  var _dWrite = document.write.bind(document);
  var SCRIPT_CLOSE_RE = new RegExp('<' + '/script', 'gi');
  document.write = function(html) {
    if (!html) return;
    var s = String(html).replace(SCRIPT_CLOSE_RE, '<\u200B/script');
    var cleaned = s.replace(/<script[^>]+src=["'][^"']*["'][^>]*>[^]*?<\u200B[/]script[^>]*>/gi, function(m) {
      return isAdHost(m) ? '' : m;
    }).replace(/<\u200B[/]script/gi, '<' + '/script');
    _dWrite(cleaned);
  };
  document.writeln = function(html) { document.write((html || '') + '\n'); };

  // ── 10. Strip beforeunload / unload navigation hooks ─────────────────────
  var _addEvt = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (type === 'beforeunload' || type === 'unload') return;
    return _addEvt.call(this, type, fn, opts);
  };
  window.onbeforeunload = null;
  window.onunload = null;
  try { Object.defineProperty(window, 'onbeforeunload', { get: function() { return null; }, set: function() {}, configurable: true }); } catch(e) {}
  try { Object.defineProperty(window, 'onunload',       { get: function() { return null; }, set: function() {}, configurable: true }); } catch(e) {}

})();
</script>`;
}

router.get("/stream-proxy", async (req, res) => {
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

  const targetOrigin = `${targetUrl.protocol}//${targetUrl.hostname}`;

  try {
    const upstream = await fetch(targetUrl.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `${targetOrigin}/`,
        "Origin": targetOrigin,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      // For non-HTML (JSON, JS, images, etc.) — just proxy through with CORS headers
      const body = await upstream.arrayBuffer();
      res.setHeader("Content-Type", contentType);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.send(Buffer.from(body));
      return;
    }

    let html = await upstream.text();

    // Base tag so relative HTML src/href resolve to the original host
    const base = `<base href="${targetOrigin}${targetUrl.pathname.replace(/\/[^/]*$/, '/')}">`;

    // Strip ad scripts (src-based)
    html = html.replace(AD_PATTERNS, "");
    html = html.replace(AD_SELF_CLOSE, "");

    // Strip inline ad scripts by well-known ad globals
    html = html.replace(
      /<script(?![^>]*src)[^>]*>[\s\S]*?(googletag|adsbygoogle|exoClick|juicyads|popads|popcash|clickunder|popunder|trafficstars|admaven|adscore|cortexads)[\s\S]*?<\/script>/gi,
      ""
    );

    // Strip <link> preloads for ad networks
    for (const host of AD_HOSTS) {
      html = html.replace(
        new RegExp(`<link[^>]*href=["'][^"']*${host}[^"']*["'][^>]*>`, 'gi'),
        ""
      );
    }

    // Remove target="_blank" / target="_top" from all static anchors
    html = html.replace(/(<a\b[^>]*)\s+target\s*=\s*["']?(_blank|_top|_parent)["']?/gi, '$1');

    // Strip meta-refresh tags (redirect-by-server-trick)
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');

    // Strip form actions pointing to external domains (ad gates)
    html = html.replace(/(<form\b[^>]*)\s+action\s*=\s*["'][^"']*["']/gi, '$1');

    // Inject base + shield at the very top of <head>
    const shield = makeShield(targetOrigin);
    if (/<head[\s>]/i.test(html)) {
      html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${base}${shield}`);
    } else if (/<html[\s>]/i.test(html)) {
      html = html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}${base}${shield}`);
    } else {
      html = base + shield + html;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Content-Security-Policy",
      "default-src * data: blob: 'unsafe-inline' 'unsafe-eval';"
    );
    res.removeHeader("X-Content-Type-Options");
    res.send(html);
  } catch (err: any) {
    res.status(502).send(`Proxy error: ${err.message}`);
  }
});

export default router;
