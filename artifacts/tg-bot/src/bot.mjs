import { Bot } from 'grammy';
import { run } from '@grammyjs/runner';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TMDB_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/w500';
const PLAYER_URL = process.env.PLAYER_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (() => {
    const d = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(',')[0] || '';
    return d ? `https://${d}/cinebot-app/` : '';
  })();
const MINI_APP_BASE = PLAYER_URL;

if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
if (!TMDB_KEY) console.warn('[CineBot] TMDB_API_KEY not set — search/providers disabled');

// Cache bot username so we don't call getMe() on every group message
let _botUsername = '';
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  try { const me = await bot.api.getMe(); _botUsername = me.username || ''; } catch (_) {}
  return _botUsername;
}

// ── Keep-alive ping (for Render free tier) ───────────────────────────────────
// The API server handles /health — bot does not start its own HTTP server.
const SELF_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/health`
  : null;

if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL, { signal: AbortSignal.timeout(10000) })
      .then(() => console.log('[KeepAlive] Ping sent'))
      .catch((err) => console.warn('[KeepAlive] Ping failed:', err.message));
  }, 14 * 60 * 1000);
  console.log(`[KeepAlive] Self-ping enabled → ${SELF_URL}`);
}

// ── Global error guards ──────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => console.error('[UnhandledRejection]', err?.message || err));
process.on('uncaughtException',  (err) => console.error('[UncaughtException]',  err?.message || err));

// ── In-memory cache (5 min TTL) ─────────────────────────────────────────────
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (e && Date.now() - e.ts < 5 * 60 * 1000) return e.val;
  _cache.delete(key);
  return null;
}
function cacheSet(key, val) { _cache.set(key, { val, ts: Date.now() }); }

// ── Streaming platform URLs ──────────────────────────────────────────────────
const PROVIDER_URLS = {
  'Netflix':              (t) => `https://www.netflix.com/search?q=${encodeURIComponent(t)}`,
  'Amazon Prime Video':   (t) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(t)}`,
  'Prime Video':          (t) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(t)}`,
  'Disney Plus':          (t) => `https://www.disneyplus.com/search?q=${encodeURIComponent(t)}`,
  'Disney+':              (t) => `https://www.disneyplus.com/search?q=${encodeURIComponent(t)}`,
  'Hotstar':              (t) => `https://www.hotstar.com/in/search?q=${encodeURIComponent(t)}`,
  'Disney+ Hotstar':      (t) => `https://www.hotstar.com/in/search?q=${encodeURIComponent(t)}`,
  'JioCinema':            (t) => `https://www.jiocinema.com/search?query=${encodeURIComponent(t)}`,
  'Apple TV Plus':        (t) => `https://tv.apple.com/search?term=${encodeURIComponent(t)}`,
  'Apple TV+':            (t) => `https://tv.apple.com/search?term=${encodeURIComponent(t)}`,
  'Hulu':                 (t) => `https://www.hulu.com/search?q=${encodeURIComponent(t)}`,
  'Max':                  (t) => `https://www.max.com/search?q=${encodeURIComponent(t)}`,
  'HBO Max':              (t) => `https://www.max.com/search?q=${encodeURIComponent(t)}`,
  'Peacock':              (t) => `https://www.peacocktv.com/search?q=${encodeURIComponent(t)}`,
  'Paramount Plus':       (t) => `https://www.paramountplus.com/search?q=${encodeURIComponent(t)}`,
  'Paramount+':           (t) => `https://www.paramountplus.com/search?q=${encodeURIComponent(t)}`,
  'SonyLIV':              (t) => `https://www.sonyliv.com/search?keyword=${encodeURIComponent(t)}`,
  'ZEE5':                 (t) => `https://www.zee5.com/search?q=${encodeURIComponent(t)}`,
  'Mubi':                 (_) => `https://mubi.com/en/films`,
  'Tubi TV':              (t) => `https://tubitv.com/search/${encodeURIComponent(t)}`,
  'Tubi':                 (t) => `https://tubitv.com/search/${encodeURIComponent(t)}`,
  'Crunchyroll':          (t) => `https://www.crunchyroll.com/search?q=${encodeURIComponent(t)}`,
  'Funimation':           (t) => `https://www.funimation.com/search/?q=${encodeURIComponent(t)}`,
  'YouTube':              (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(t + ' full movie')}`,
  'YouTube Premium':      (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(t)}`,
  'Aha':                  (t) => `https://www.aha.video/search?q=${encodeURIComponent(t)}`,
  'MX Player':            (t) => `https://www.mxplayer.in/search?q=${encodeURIComponent(t)}`,
  'Voot':                 (t) => `https://www.voot.com/search/${encodeURIComponent(t)}`,
};

const PROVIDER_ICONS = {
  'Netflix': '🔴', 'Amazon Prime Video': '🟡', 'Prime Video': '🟡',
  'Disney Plus': '🔵', 'Disney+': '🔵', 'Disney+ Hotstar': '🔵', 'Hotstar': '🔵',
  'Apple TV Plus': '⬛', 'Apple TV+': '⬛', 'Hulu': '🟢',
  'Max': '🟣', 'HBO Max': '🟣', 'JioCinema': '🟠',
  'SonyLIV': '🔵', 'ZEE5': '🟣', 'Crunchyroll': '🟠', 'YouTube': '🔴',
};

// ── TMDB helpers ─────────────────────────────────────────────────────────────
async function tmdb(path, params = {}) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set('api_key', TMDB_KEY);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`);
  const data = await res.json();
  cacheSet(cacheKey, data);

  return data;
}

// ── Cinemeta helper (free, no API key) ───────────────────────────────────────
// Enriches movie/series data with cast, ratings, and overview from Stremio's
// free metadata catalogue. Used to reduce TMDB API calls.
async function cinemeta(type, imdbId) {
  if (!imdbId) return null;
  const cineType = type === 'movie' ? 'movie' : 'series';
  const key = `cinemeta:${cineType}:${imdbId}`;
  const cached = cacheGet(key);
  if (cached !== null && cached !== undefined) return cached;
  try {
    const res = await fetch(
      `https://v3-cinemeta.strem.io/meta/${cineType}/${imdbId}.json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) { cacheSet(key, null); return null; }
    const data = await res.json();
    const meta = data?.meta || null;
    cacheSet(key, meta);
    return meta;
  } catch {
    cacheSet(key, null);
    return null;
  }
}

function stars(vote) {
  const rounded = Math.round(vote / 2);
  return '⭐'.repeat(Math.min(Math.max(rounded, 0), 5)) || '—';
}
function formatDate(d) {
  if (!d) return 'Unknown';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function genreNames(genres) {
  return genres?.length ? genres.map(g => g.name).join(', ') : 'N/A';
}
function h(text) {
  if (text == null) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function truncate(text, max = 700) {
  if (!text) return '';
  return text.length > max ? text.substring(0, max) + '…' : text;
}

// ── Fuzzy / spell-check helpers ──────────────────────────────────────────────
function fuzzyMatch(query, title) {
  if (!query || !title) return false;
  const q = query.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const t = title.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  if (!q || !t) return true;
  if (t.includes(q) || q.includes(t)) return true;
  const qWords = q.split(/\s+/).filter(w => w.length > 2);
  if (qWords.length === 0) return true;
  const tWords = t.split(/\s+/);
  const matchCount = qWords.filter(w => tWords.some(tw => tw.includes(w) || w.includes(tw))).length;
  return matchCount >= Math.ceil(qWords.length * 0.5);
}

function maybeInjectDidYouMean(query, items, keyboard) {
  if (!keyboard || keyboard.length === 0 || !items || items.length === 0) return keyboard;
  const top = items[0];
  const topTitle = top.media_type === 'movie' ? (top.title || top.original_title) : (top.name || top.original_name);
  if (fuzzyMatch(query, topTitle)) return keyboard;
  const date = top.media_type === 'movie' ? top.release_date : top.first_air_date;
  const year = date ? ` (${date.substring(0, 4)})` : '';
  const cb = `${top.media_type}_${top.id}`;
  const suggestionRow = [{ text: `🤔 Did you mean: ${topTitle}${year}?`, callback_data: cb }];
  return [suggestionRow, ...keyboard];
}

// ── Watch link helpers ────────────────────────────────────────────────────────
function getBestRegion(providers) {
  const results = providers?.results || {};
  return results.US || results.IN || Object.values(results)[0] || null;
}

function buildWatchButtons(mediaType, id, title, providers, trailerKey, tmdbUrl, { imdbId = '', poster = '', year = '', overview = '' } = {}) {
  const buttons = [];

  const appParams = new URLSearchParams({
    type: mediaType, id: String(id), title,
    ...(year && { year }), ...(poster && { poster }), ...(imdbId && { imdb: imdbId }),
    ...(overview && { overview: overview.slice(0, 150) }),
  });
  const appUrl = `${MINI_APP_BASE}?${appParams.toString()}`;
  buttons.push([{ text: '▶️  Watch Free — No Ads', url: appUrl }]);

  const region = getBestRegion(providers);
  const streamProviders = [...(region?.flatrate || []), ...(region?.free || []), ...(region?.ads || [])];
  const seen = new Set();
  const paidButtons = [];

  for (const p of streamProviders) {
    if (seen.has(p.provider_name)) continue;
    seen.add(p.provider_name);
    const urlFn = PROVIDER_URLS[p.provider_name];
    if (urlFn) {
      const icon = PROVIDER_ICONS[p.provider_name] || '▶️';
      paidButtons.push({ text: `${icon} ${p.provider_name}`, url: urlFn(title) });
    }
    if (paidButtons.length >= 4) break;
  }

  if (paidButtons.length) {
    for (let i = 0; i < paidButtons.length; i += 2) {
      buttons.push(paidButtons.slice(i, i + 2));
    }
  }

  const bottomRow = [];
  // trailerKey is now a full URL (YouTube search link — no API call needed)
  if (trailerKey) bottomRow.push({ text: '🎞 Trailer', url: trailerKey });
  bottomRow.push({ text: 'ℹ️ TMDB', url: tmdbUrl });
  buttons.push(bottomRow);

  return buttons;
}

function buildStreamingText(providers, title) {
  const region = getBestRegion(providers);
  if (!region) return `<a href="https://www.google.com/search?q=${encodeURIComponent(title + ' where to watch')}">Search where to watch</a>`;

  const stream = region.flatrate?.map(p => {
    const urlFn = PROVIDER_URLS[p.provider_name];
    return urlFn ? `<a href="${urlFn(title)}">${h(p.provider_name)}</a>` : h(p.provider_name);
  }) || [];
  const rent = region.rent?.slice(0, 2).map(p => {
    const urlFn = PROVIDER_URLS[p.provider_name];
    return urlFn ? `<a href="${urlFn(title)}">${h(p.provider_name)}</a>` : h(p.provider_name);
  }) || [];

  const parts = [];
  if (stream.length) parts.push(`Stream: ${stream.join(', ')}`);
  if (rent.length && !stream.length) parts.push(`Rent/Buy: ${rent.join(', ')}`);
  return parts.length
    ? parts.join(' | ')
    : `<a href="${region.link || `https://www.google.com/search?q=${encodeURIComponent(title + ' where to watch')}`}">Check streaming options</a>`;
}

// ── Message builders ──────────────────────────────────────────────────────────
// cineMeta is optional data from Cinemeta (free) used to enrich cast/ratings.
function buildMovieMessage(m, providers, cineMeta) {
  const title    = m.title || m.original_title;
  const year     = m.release_date ? m.release_date.substring(0, 4) : '';
  const runtime  = m.runtime ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m`
                 : (cineMeta?.runtime || 'N/A');
  // Prefer IMDB rating from Cinemeta, fall back to TMDB vote
  const ratingNum = cineMeta?.imdbRating
    ? parseFloat(cineMeta.imdbRating)
    : (m.vote_average || 0);
  const ratingStr = ratingNum
    ? `${ratingNum.toFixed(1)}/10 ${stars(ratingNum)}`
    : 'N/A';
  const director  = cineMeta?.director?.slice(0, 2).join(', ') || '';
  const cast      = cineMeta?.cast?.slice(0, 3).join(', ') || '';
  const overview  = truncate(cineMeta?.description || m.overview || 'No overview available.', 200);
  const streamText = buildStreamingText(providers, title);

  let msg = `🎬 <b>${h(title)}</b>`;
  if (m.title !== m.original_title) msg += ` <i>(${h(m.original_title)})</i>`;
  if (year) msg += ` <i>(${year})</i>`;
  msg += '\n';
  if (m.tagline) msg += `<i>${h(m.tagline)}</i>\n`;
  msg += '\n';
  msg += `⭐ <b>${h(ratingStr)}</b>  ⏱ ${h(runtime)}  🎭 ${h(genreNames(m.genres))}\n`;
  if (director) msg += `🎬 ${h(director)}`;
  if (cast)     msg += `  ·  👥 ${h(cast)}`;
  if (director || cast) msg += '\n';
  msg += `\n📝 <i>${h(overview)}</i>\n`;
  msg += `\n📺 <b>Watch on:</b> ${streamText}`;
  return msg;
}

function buildSeriesMessage(s, providers, cineMeta) {
  const title   = s.name || s.original_name;
  const year    = s.first_air_date ? s.first_air_date.substring(0, 4) : '';
  const seasons = s.number_of_seasons ? `${s.number_of_seasons}S` : '';
  const eps     = s.number_of_episodes ? `${s.number_of_episodes} eps` : '';
  const ratingNum = cineMeta?.imdbRating
    ? parseFloat(cineMeta.imdbRating)
    : (s.vote_average || 0);
  const ratingStr = ratingNum ? `${ratingNum.toFixed(1)}/10 ${stars(ratingNum)}` : 'N/A';
  const creator = cineMeta?.director?.slice(0, 2).join(', ')
                || s.created_by?.slice(0, 2).map(c => c.name).join(', ') || '';
  const cast    = cineMeta?.cast?.slice(0, 3).join(', ') || '';
  const overview = truncate(cineMeta?.description || s.overview || 'No overview available.', 200);
  const streamText = buildStreamingText(providers, title);

  let msg = `📺 <b>${h(title)}</b>`;
  if (s.name !== s.original_name) msg += ` <i>(${h(s.original_name)})</i>`;
  if (year) msg += ` <i>(${year})</i>`;
  msg += '\n';
  if (s.tagline) msg += `<i>${h(s.tagline)}</i>\n`;
  msg += '\n';
  const meta = [seasons, eps, s.status].filter(Boolean).join('  ·  ');
  msg += `⭐ <b>${h(ratingStr)}</b>  📦 ${h(meta)}  🎭 ${h(genreNames(s.genres))}\n`;
  if (creator) msg += `✍️ ${h(creator)}`;
  if (cast)    msg += `  ·  👥 ${h(cast)}`;
  if (creator || cast) msg += '\n';
  msg += `\n📝 <i>${h(overview)}</i>\n`;
  msg += `\n📺 <b>Watch on:</b> ${streamText}`;
  return msg;
}

// ── Keyboard builders ─────────────────────────────────────────────────────────
function buildResultKeyboard(results, type) {
  if (!results || results.length === 0) return null;
  return results.slice(0, 8).map(item => {
    const title = type === 'movie' ? (item.title || item.original_title) : (item.name || item.title);
    const date = type === 'movie' ? item.release_date : item.first_air_date;
    const year = date ? `(${date.substring(0, 4)})` : '';
    const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}` : '';
    return [{ text: `${title} ${year} ${rating}`.trim().substring(0, 60), callback_data: `${type}_${item.id}` }];
  });
}

function buildMultiResultKeyboard(results) {
  if (!results || results.length === 0) return null;
  return results.slice(0, 10).map(item => {
    const title = item.media_type === 'movie' ? (item.title || item.original_title) : (item.name || item.original_name);
    const date = item.media_type === 'movie' ? item.release_date : item.first_air_date;
    const year = date ? `(${date.substring(0, 4)})` : '';
    const icon = item.media_type === 'movie' ? '🎬' : '📺';
    const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}` : '';
    return [{ text: `${icon} ${title} ${year} ${rating}`.trim().substring(0, 60), callback_data: `${item.media_type}_${item.id}` }];
  });
}

// ── Bot init ─────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN);

// ── Safe send helpers (use bot.api for fire-and-forget from shared handlers) ──
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
  } catch (err) {
    console.error('[safeSend HTML error]', err?.message);
    try {
      return await bot.api.sendMessage(chatId, text.replace(/<[^>]+>/g, ''), { ...opts, parse_mode: undefined });
    } catch (err2) {
      console.error('[safeSend plain error]', err2?.message);
    }
  }
}

async function safeEdit(chatId, messageId, text, opts = {}) {
  if (!messageId) return safeSend(chatId, text, opts);
  try {
    return await bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', ...opts });
  } catch (err) {
    if (err?.message?.includes('message is not modified')) return;
    console.error('[safeEdit]', err?.message);
    try { return safeSend(chatId, text, opts); } catch (_) {}
  }
}

async function safePhoto(chatId, url, caption, opts = {}) {
  try {
    return await bot.api.sendPhoto(chatId, url, { caption, parse_mode: 'HTML', ...opts });
  } catch (err) {
    console.error('[safePhoto]', err?.message);
    return safeSend(chatId, caption, opts);
  }
}

// ── Shared handlers ────────────────────────────────────────────────────────────
async function handleTrending(chatId) {
  const waitMsg = await safeSend(chatId, '🔥 Loading trending today...');
  try {
    const data = await tmdb('/trending/all/day');
    const items = (data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
    const keyboard = buildMultiResultKeyboard(items);
    if (!keyboard) return safeEdit(chatId, waitMsg?.message_id, '❌ No trending data available.');
    await safeEdit(chatId, waitMsg?.message_id, `🔥 <b>Trending Today:</b>\n🎬 = Movie  📺 = Series\n\nTap for details &amp; watch links:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    console.error('/trending error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load trending. Try again later.');
  }
}

async function handlePopularMovies(chatId) {
  const waitMsg = await safeSend(chatId, '🌟 Loading popular movies...');
  try {
    const data = await tmdb('/movie/popular');
    const keyboard = buildResultKeyboard(data.results, 'movie');
    if (!keyboard) return safeEdit(chatId, waitMsg?.message_id, '❌ Could not load popular movies.');
    await safeEdit(chatId, waitMsg?.message_id, '🌟 <b>Popular Movies Right Now:</b>\n\nTap for details &amp; watch links:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    console.error('/popular error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load popular movies. Try again later.');
  }
}

async function handlePopularSeries(chatId) {
  const waitMsg = await safeSend(chatId, '📡 Loading popular series...');
  try {
    const data = await tmdb('/tv/popular');
    const keyboard = buildResultKeyboard(data.results, 'tv');
    if (!keyboard) return safeEdit(chatId, waitMsg?.message_id, '❌ Could not load popular series.');
    await safeEdit(chatId, waitMsg?.message_id, '📡 <b>Popular Web Series Right Now:</b>\n\nTap for details &amp; watch links:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    console.error('/popular_series error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load popular series. Try again later.');
  }
}

async function handleGenres(chatId) {
  const waitMsg = await safeSend(chatId, '🎭 Loading genres...');
  try {
    const [movieGenres, tvGenres] = await Promise.all([
      tmdb('/genre/movie/list'),
      tmdb('/genre/tv/list'),
    ]);
    const movieKeys = (movieGenres.genres || []).slice(0, 8).map(g => ([{
      text: `🎬 ${g.name}`, callback_data: `genre_movie_${g.id}_${encodeURIComponent(g.name)}`,
    }]));
    const tvKeys = (tvGenres.genres || []).slice(0, 8).map(g => ([{
      text: `📺 ${g.name}`, callback_data: `genre_tv_${g.id}_${encodeURIComponent(g.name)}`,
    }]));
    await safeEdit(chatId, waitMsg?.message_id,
      '🎭 <b>Browse by Genre:</b>\n🎬 = Movie genre  📺 = Series genre\n\nTap to see top picks:', {
      reply_markup: { inline_keyboard: [...movieKeys, ...tvKeys] }
    });
  } catch (err) {
    console.error('/genres error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load genres. Try again later.');
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const name = h(ctx.from?.first_name || 'there');
  await ctx.reply(
    `🎬 <b>Hey ${name}, welcome to CineBot!</b>\n\n` +
    `Stream any movie or series — <b>free, no ads, no redirects</b> — right inside Telegram.\n\n` +
    `<b>Just type a movie or series name</b> to search instantly.\n\n` +
    `Or use the buttons below to explore 👇`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔥 Trending', callback_data: 'quick_trending' }, { text: '🌟 Popular Movies', callback_data: 'quick_popular' }],
          [{ text: '📺 Popular Series', callback_data: 'quick_series' }, { text: '🎭 Browse Genres', callback_data: 'quick_genres' }],
        ],
      },
    }
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `🎬 <b>CineBot — Help</b>\n\n` +
    `/movie &lt;title&gt; — Search movies\n` +
    `/series &lt;title&gt; — Search web series\n` +
    `/search &lt;title&gt; — Search both\n` +
    `/trending — What's trending today\n` +
    `/popular — Top movies\n` +
    `/popular_series — Top web series\n` +
    `/genres — Browse by genre\n\n` +
    `<b>Each result shows:</b>\n` +
    `• Direct links to Netflix, Prime, Hotstar &amp; more\n` +
    `• Full plot overview &amp; cast\n` +
    `• Rating &amp; runtime\n` +
    `• Trailer on YouTube\n\n` +
    `<i>No downloads — stream directly!</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('movie', async (ctx) => {
  const chatId = ctx.chat.id;
  const query = ctx.match?.trim();
  if (!query) {
    return ctx.reply('Usage: /movie &lt;title&gt;\nExample: /movie Inception', { parse_mode: 'HTML' });
  }
  const waitMsg = await safeSend(chatId, `🔍 Searching for movie: <b>${h(query)}</b>...`);
  try {
    const data = await tmdb('/search/movie', { query });
    const results = data.results || [];
    let keyboard = buildResultKeyboard(results, 'movie');
    if (!keyboard) {
      return safeEdit(chatId, waitMsg?.message_id, `❌ No movies found for "<b>${h(query)}</b>". Try a different spelling.`);
    }
    const topTitle = results[0]?.title || results[0]?.original_title || '';
    if (!fuzzyMatch(query, topTitle)) {
      const year = results[0]?.release_date ? ` (${results[0].release_date.substring(0, 4)})` : '';
      const suggRow = [{ text: `🤔 Did you mean: ${topTitle}${year}?`, callback_data: `movie_${results[0].id}` }];
      keyboard = [suggRow, ...keyboard];
    }
    await safeEdit(chatId, waitMsg?.message_id, `🎬 <b>Movie results for "${h(query)}":</b>\n\nTap a title for details &amp; watch links:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    console.error('/movie error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Search failed. Please try again later.');
  }
});

bot.command('series', async (ctx) => {
  const chatId = ctx.chat.id;
  const query = ctx.match?.trim();
  if (!query) {
    return ctx.reply('Usage: /series &lt;title&gt;\nExample: /series Breaking Bad', { parse_mode: 'HTML' });
  }
  const waitMsg = await safeSend(chatId, `🔍 Searching for series: <b>${h(query)}</b>...`);
  try {
    const data = await tmdb('/search/tv', { query });
    const results = data.results || [];
    let keyboard = buildResultKeyboard(results, 'tv');
    if (!keyboard) {
      return safeEdit(chatId, waitMsg?.message_id, `❌ No series found for "<b>${h(query)}</b>". Try a different spelling.`);
    }
    const topTitle = results[0]?.name || results[0]?.original_name || '';
    if (!fuzzyMatch(query, topTitle)) {
      const year = results[0]?.first_air_date ? ` (${results[0].first_air_date.substring(0, 4)})` : '';
      const suggRow = [{ text: `🤔 Did you mean: ${topTitle}${year}?`, callback_data: `tv_${results[0].id}` }];
      keyboard = [suggRow, ...keyboard];
    }
    await safeEdit(chatId, waitMsg?.message_id, `📺 <b>Series results for "${h(query)}":</b>\n\nTap a title for details &amp; watch links:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    console.error('/series error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Search failed. Please try again later.');
  }
});

bot.command('search', async (ctx) => {
  const chatId = ctx.chat.id;
  const query = ctx.match?.trim();
  if (!query) {
    return ctx.reply('Usage: /search &lt;title&gt;\nExample: /search Dark Knight', { parse_mode: 'HTML' });
  }
  const waitMsg = await safeSend(chatId, `🔎 Searching: <b>${h(query)}</b>...`);
  try {
    const data = await tmdb('/search/multi', { query });
    const items = (data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
    let keyboard = buildMultiResultKeyboard(items);
    if (!keyboard) {
      return safeEdit(chatId, waitMsg?.message_id, `❌ Nothing found for "<b>${h(query)}</b>".`);
    }
    keyboard = maybeInjectDidYouMean(query, items, keyboard);
    await safeEdit(chatId, waitMsg?.message_id, `🔎 <b>Results for "${h(query)}":</b>\n🎬 = Movie  📺 = Series\n\nTap for details &amp; watch links:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    console.error('/search error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Search failed. Please try again later.');
  }
});

bot.command('trending',       (ctx) => handleTrending(ctx.chat.id));
bot.command('popular',        (ctx) => handlePopularMovies(ctx.chat.id));
bot.command('popular_series', (ctx) => handlePopularSeries(ctx.chat.id));
bot.command('genres',         (ctx) => handleGenres(ctx.chat.id));

// ── Callback query handler ────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const data = ctx.callbackQuery.data || '';

  // Acknowledge immediately so Telegram stops showing the loading spinner
  try { await ctx.answerCallbackQuery(); } catch (_) {}

  if (data === 'quick_trending') { handleTrending(chatId); return; }
  if (data === 'quick_popular')  { handlePopularMovies(chatId); return; }
  if (data === 'quick_series')   { handlePopularSeries(chatId); return; }
  if (data === 'quick_genres')   { handleGenres(chatId); return; }

  // Movie detail
  if (data.startsWith('movie_')) {
    const id = data.slice('movie_'.length);
    const waitMsg = await safeSend(chatId, '⏳ Fetching movie details & watch links...');
    try {
      // 2 TMDB calls instead of 4 — Cinemeta fills cast/ratings for free
      const [movie, providers] = await Promise.all([
        tmdb(`/movie/${id}`),
        tmdb(`/movie/${id}/watch/providers`),
      ]);
      const imdbId = movie.imdb_id || '';
      const cineMeta = await cinemeta('movie', imdbId);
      const title = movie.title || movie.original_title;
      const year  = movie.release_date?.slice(0, 4) || '';
      // YouTube trailer search link (no API call)
      const trailerUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + year + ' official trailer')}`;
      const tmdbUrl = `https://www.themoviedb.org/movie/${id}`;
      const text = buildMovieMessage(movie, providers, cineMeta);
      const keyboard = buildWatchButtons('movie', id, title, providers, trailerUrl, tmdbUrl, {
        imdbId,
        poster: movie.poster_path || '',
        year,
        overview: cineMeta?.description || movie.overview || '',
      });
      try { await bot.api.deleteMessage(chatId, waitMsg?.message_id); } catch (_) {}
      const imgUrl = movie.poster_path ? `${IMG_BASE}${movie.poster_path}` : null;
      if (imgUrl) {
        await safePhoto(chatId, imgUrl, text, { reply_markup: { inline_keyboard: keyboard } });
      } else {
        await safeSend(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
      }
    } catch (err) {
      console.error('movie detail error:', err?.message);
      await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load movie details. Please try again.');
    }
    return;
  }

  // TV/Series detail
  if (data.startsWith('tv_')) {
    const id = data.slice('tv_'.length);
    const waitMsg = await safeSend(chatId, '⏳ Fetching series details & watch links...');
    try {
      // 3 TMDB calls instead of 5 — Cinemeta fills cast/ratings for free
      const [series, providers, externalIds] = await Promise.all([
        tmdb(`/tv/${id}`),
        tmdb(`/tv/${id}/watch/providers`),
        tmdb(`/tv/${id}/external_ids`),
      ]);
      const imdbId = externalIds?.imdb_id || '';
      const cineMeta = await cinemeta('series', imdbId);
      const title = series.name || series.original_name;
      const year  = series.first_air_date?.slice(0, 4) || '';
      const trailerUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + year + ' official trailer')}`;
      const tmdbUrl = `https://www.themoviedb.org/tv/${id}`;
      const text = buildSeriesMessage(series, providers, cineMeta);
      const keyboard = buildWatchButtons('tv', id, title, providers, trailerUrl, tmdbUrl, {
        imdbId,
        poster: series.poster_path || '',
        year,
        overview: cineMeta?.description || series.overview || '',
      });
      try { await bot.api.deleteMessage(chatId, waitMsg?.message_id); } catch (_) {}
      const imgUrl = series.poster_path ? `${IMG_BASE}${series.poster_path}` : null;
      if (imgUrl) {
        await safePhoto(chatId, imgUrl, text, { reply_markup: { inline_keyboard: keyboard } });
      } else {
        await safeSend(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
      }
    } catch (err) {
      console.error('tv detail error:', err?.message);
      await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load series details. Please try again.');
    }
    return;
  }

  // Genre browse
  if (data.startsWith('genre_')) {
    const parts = data.split('_');
    const mediaType = parts[1];
    const genreId = parts[2];
    const genreName = decodeURIComponent(parts.slice(3).join('_'));
    const icon = mediaType === 'movie' ? '🎬' : '📺';
    const waitMsg = await safeSend(chatId, `${icon} Loading top ${h(genreName)} ${mediaType === 'movie' ? 'movies' : 'series'}...`);
    try {
      const endpoint = mediaType === 'movie' ? '/discover/movie' : '/discover/tv';
      const res = await tmdb(endpoint, { with_genres: genreId, sort_by: 'popularity.desc' });
      const keyboard = buildResultKeyboard(res.results, mediaType);
      if (!keyboard) {
        return safeEdit(chatId, waitMsg?.message_id, '❌ No results found for this genre.');
      }
      await safeEdit(chatId, waitMsg?.message_id,
        `${icon} <b>Top ${h(genreName)} ${mediaType === 'movie' ? 'Movies' : 'Series'}:</b>\n\nTap for details &amp; watch links:`, {
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (err) {
      console.error('genre error:', err?.message);
      await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load genre results. Try again later.');
    }
    return;
  }
});

// ── Plain text auto-search (private) + @mention search (groups) ───────────────
bot.on('message:text', async (ctx) => {
  const rawText = ctx.message.text || '';
  if (rawText.startsWith('/') || rawText.length < 2) return;

  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  const chatId  = ctx.chat.id;
  let query = rawText.trim();

  if (isGroup) {
    // In groups: only respond when the bot is @mentioned
    const botUsername = await getBotUsername();
    const mention = `@${botUsername}`.toLowerCase();
    if (!rawText.toLowerCase().includes(mention)) return;
    // Strip the mention to get the actual search query
    query = rawText.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
    if (!query || query.length < 2) {
      return ctx.reply(
        `👋 Hi! Mention me with a movie or series name to search.\n` +
        `Example: <code>@${botUsername} Inception</code>`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      );
    }
  }

  const waitMsg = await safeSend(chatId, `🔎 Searching for <b>${h(query)}</b>...`);
  try {
    const data = await tmdb('/search/multi', { query });
    const items = (data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
    let keyboard = buildMultiResultKeyboard(items);
    if (!keyboard) {
      return safeEdit(chatId, waitMsg?.message_id,
        `❌ Nothing found for "<b>${h(query)}</b>".\nTry a different spelling or use /movie / /series.`);
    }
    keyboard = maybeInjectDidYouMean(query, items, keyboard);
    await safeEdit(chatId, waitMsg?.message_id,
      `🔎 <b>Results for "${h(query)}":</b>\n🎬 = Movie  📺 = Series\n\nTap for details &amp; watch links:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    console.error('auto-search error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Search failed. Please try again.');
  }
});

// ── Bot error handler ─────────────────────────────────────────────────────────
bot.catch((err) => {
  const msg = err?.message || String(err);
  if (msg.includes('404') || msg.includes('401')) {
    console.error('[Bot] Invalid token or bot not found. Check TELEGRAM_BOT_TOKEN.');
  } else if (msg.includes('409')) {
    console.error('[Bot] Conflict — another instance is running. Stop it first.');
  } else {
    console.error('[Bot Error]', msg);
  }
});

// Register command menu
bot.api.setMyCommands([
  { command: 'movie',          description: '🎬 Search a movie' },
  { command: 'series',         description: '📺 Search a web series' },
  { command: 'search',         description: '🔎 Search movies & series' },
  { command: 'trending',       description: '🔥 Trending today' },
  { command: 'popular',        description: '🌟 Popular movies' },
  { command: 'popular_series', description: '📡 Popular web series' },
  { command: 'genres',         description: '🎭 Browse by genre' },
  { command: 'help',           description: '❓ How to use CineBot' },
]).catch((err) => console.error('[setMyCommands]', err?.message));

// ── Start with concurrent runner ──────────────────────────────────────────────
// @grammyjs/runner processes multiple updates concurrently (unlike the default
// sequential long-polling), so many users are served simultaneously without blocking.
run(bot);

console.log('🎬 CineBot is running with concurrent update processing!');
