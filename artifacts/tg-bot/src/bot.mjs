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

// ── Group search store: query → results (for regenerate button) ──────────────
// Key: `grp_${chatId}_${msgId}` | expires naturally when message is deleted
const _groupSearch = new Map(); // key → { query }

// ── IMDB free search (no API key) ────────────────────────────────────────────
// Uses IMDB's undocumented suggestion API — same source as the search bar on imdb.com
async function imdbSearch(query) {
  const raw = query.toLowerCase().trim();
  if (!raw || raw.length < 1) return [];
  const letter = raw[0]; // extract BEFORE encoding — encoding turns é→%C3%A9, so letter would be '%'
  const q = encodeURIComponent(raw);
  const url = `https://v2.sg.media-imdb.com/suggests/${letter}/${q}.json`;
  const key = `imdb_suggest:${q}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    // Response is JSONP: imdb$inception({d:[...], q:'...', v:1})
    const match = text.match(/\((\{.+\})\)$/s);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const results = (data.d || []).filter(r => r.id?.startsWith('tt'));
    cacheSet(key, results);
    return results;
  } catch (err) {
    console.warn('[imdbSearch]', err?.message);
    return [];
  }
}

// Build keyboard from IMDB suggestion results
// Each row: [{ text: '🎬 Title (year)', callback_data: 'imdb_movie_tt...' }]
// filterType: 'all' | 'movie' | 'series'
function buildImdbKeyboard(results, filterType = 'all') {
  const rows = [];
  for (const r of results) {
    if (!r.id || !r.l) continue;
    const qt = (r.q || '').toLowerCase();
    const isTV = qt.includes('series') || qt.includes('mini');
    // 'feature' = movie, 'tv series' = series, 'tv mini-series' = series
    if (filterType === 'movie' && isTV) continue;
    if (filterType === 'series' && !isTV) continue;
    const mediaType = isTV ? 'tv' : 'movie';
    const icon = isTV ? '📺' : '🎬';
    const year = r.y ? ` (${r.y})` : '';
    const cbData = `imdb_${mediaType}_${r.id}`;
    if (cbData.length > 64) continue; // Telegram callback data limit
    rows.push([{ text: `${icon} ${r.l}${year}`.substring(0, 60), callback_data: cbData }]);
    if (rows.length >= 8) break;
  }
  return rows.length ? rows : null;
}

// ── TMDB helpers ─────────────────────────────────────────────────────────────
async function tmdb(path, params = {}) {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY is not set');
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

// ── Watch button builder (no paid providers — free watch only) ────────────────
// infoUrl: IMDB or TMDB page link for the bottom row
function buildWatchButtons(mediaType, title, trailerUrl, infoUrl, { imdbId = '', poster = '', year = '', overview = '' } = {}) {
  const buttons = [];
  const appParams = new URLSearchParams({
    type: mediaType, title,
    ...(year     && { year }),
    ...(poster   && { poster }),
    ...(imdbId   && { imdb: imdbId }),
    ...(overview && { overview: overview.slice(0, 150) }),
  });
  const appUrl = `${MINI_APP_BASE}?${appParams.toString()}`;
  buttons.push([{ text: '▶️  Watch Free — No Ads', url: appUrl }]);

  const bottomRow = [];
  if (trailerUrl) bottomRow.push({ text: '🎞 Trailer', url: trailerUrl });
  if (infoUrl) {
    const label = infoUrl.includes('imdb.com') ? 'ℹ️ IMDB' : 'ℹ️ TMDB';
    bottomRow.push({ text: label, url: infoUrl });
  }
  if (bottomRow.length) buttons.push(bottomRow);
  return buttons;
}

// ── Shared detail senders (called from DM callbacks AND group→private deeplinks) ──
async function sendMovieDetail(chatId, imdbId) {
  const waitMsg = await safeSend(chatId, '⏳ Fetching movie details...');
  try {
    const cineMeta = await cinemeta('movie', imdbId);
    if (!cineMeta) throw new Error('No Cinemeta data');
    const title = cineMeta.name || 'Unknown';
    const year  = String(cineMeta.releaseInfo || '').slice(0, 4);
    const trailerUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + year + ' official trailer')}`;
    const imdbUrl = `https://www.imdb.com/title/${imdbId}`;
    const text = buildMovieMessage(null, cineMeta);
    const keyboard = buildWatchButtons('movie', title, trailerUrl, imdbUrl, {
      imdbId, poster: cineMeta.poster || '', year, overview: cineMeta.description || '',
    });
    try { await bot.api.deleteMessage(chatId, waitMsg?.message_id); } catch (_) {}
    if (cineMeta.poster) await safePhoto(chatId, cineMeta.poster, text, { reply_markup: { inline_keyboard: keyboard } });
    else await safeSend(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    console.error('sendMovieDetail error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load movie details. Please try again.');
  }
}

async function sendTvDetail(chatId, imdbId) {
  const waitMsg = await safeSend(chatId, '⏳ Fetching series details...');
  try {
    const cineMeta = await cinemeta('series', imdbId);
    if (!cineMeta) throw new Error('No Cinemeta data');
    const title = cineMeta.name || 'Unknown';
    const year  = String(cineMeta.releaseInfo || '').slice(0, 4);
    const trailerUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + year + ' official trailer')}`;
    const imdbUrl = `https://www.imdb.com/title/${imdbId}`;
    const text = buildSeriesMessage(null, cineMeta);
    const keyboard = buildWatchButtons('tv', title, trailerUrl, imdbUrl, {
      imdbId, poster: cineMeta.poster || '', year, overview: cineMeta.description || '',
    });
    try { await bot.api.deleteMessage(chatId, waitMsg?.message_id); } catch (_) {}
    if (cineMeta.poster) await safePhoto(chatId, cineMeta.poster, text, { reply_markup: { inline_keyboard: keyboard } });
    else await safeSend(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    console.error('sendTvDetail error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load series details. Please try again.');
  }
}

async function sendTmdbMovieDetail(chatId, tmdbId) {
  const waitMsg = await safeSend(chatId, '⏳ Fetching movie details...');
  try {
    const movie = await tmdb(`/movie/${tmdbId}`);
    const imdbId = movie.imdb_id || '';
    const cineMeta = await cinemeta('movie', imdbId);
    const title = movie.title || movie.original_title;
    const year  = movie.release_date?.slice(0, 4) || '';
    const trailerUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + year + ' official trailer')}`;
    const infoUrl = imdbId ? `https://www.imdb.com/title/${imdbId}` : `https://www.themoviedb.org/movie/${tmdbId}`;
    const text = buildMovieMessage(movie, cineMeta);
    const keyboard = buildWatchButtons('movie', title, trailerUrl, infoUrl, {
      imdbId, poster: movie.poster_path || '', year, overview: cineMeta?.description || movie.overview || '',
    });
    try { await bot.api.deleteMessage(chatId, waitMsg?.message_id); } catch (_) {}
    const imgUrl = movie.poster_path ? `${IMG_BASE}${movie.poster_path}` : null;
    if (imgUrl) await safePhoto(chatId, imgUrl, text, { reply_markup: { inline_keyboard: keyboard } });
    else await safeSend(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    console.error('sendTmdbMovieDetail error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load movie details. Please try again.');
  }
}

async function sendTmdbTvDetail(chatId, tmdbId) {
  const waitMsg = await safeSend(chatId, '⏳ Fetching series details...');
  try {
    const [series, externalIds] = await Promise.all([tmdb(`/tv/${tmdbId}`), tmdb(`/tv/${tmdbId}/external_ids`)]);
    const imdbId = externalIds?.imdb_id || '';
    const cineMeta = await cinemeta('series', imdbId);
    const title = series.name || series.original_name;
    const year  = series.first_air_date?.slice(0, 4) || '';
    const trailerUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + year + ' official trailer')}`;
    const infoUrl = imdbId ? `https://www.imdb.com/title/${imdbId}` : `https://www.themoviedb.org/tv/${tmdbId}`;
    const text = buildSeriesMessage(series, cineMeta);
    const keyboard = buildWatchButtons('tv', title, trailerUrl, infoUrl, {
      imdbId, poster: series.poster_path || '', year, overview: cineMeta?.description || series.overview || '',
    });
    try { await bot.api.deleteMessage(chatId, waitMsg?.message_id); } catch (_) {}
    const imgUrl = series.poster_path ? `${IMG_BASE}${series.poster_path}` : null;
    if (imgUrl) await safePhoto(chatId, imgUrl, text, { reply_markup: { inline_keyboard: keyboard } });
    else await safeSend(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    console.error('sendTmdbTvDetail error:', err?.message);
    await safeEdit(chatId, waitMsg?.message_id, '⚠️ Could not load series details. Please try again.');
  }
}

// ── Message builders ──────────────────────────────────────────────────────────
// m = TMDB movie data (may be null for IMDB-sourced results)
// cineMeta = Cinemeta metadata (free, no API key)
function buildMovieMessage(m, cineMeta) {
  const title    = m?.title || m?.original_title || cineMeta?.name || 'Unknown';
  const year     = m?.release_date?.slice(0, 4) || String(cineMeta?.releaseInfo || '').slice(0, 4);
  const runtime  = m?.runtime
    ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m`
    : (cineMeta?.runtime || 'N/A');
  const ratingNum = cineMeta?.imdbRating
    ? parseFloat(cineMeta.imdbRating)
    : (m?.vote_average || 0);
  const ratingStr = ratingNum ? `${ratingNum.toFixed(1)}/10 ${stars(ratingNum)}` : 'N/A';
  const director  = cineMeta?.director?.slice(0, 2).join(', ') || '';
  const cast      = cineMeta?.cast?.slice(0, 3).join(', ') || '';
  const overview  = truncate(cineMeta?.description || m?.overview || 'No overview available.', 200);
  const genres    = cineMeta?.genres?.length
    ? cineMeta.genres.slice(0, 3).join(', ')
    : genreNames(m?.genres);

  let msg = `🎬 <b>${h(title)}</b>`;
  if (m?.original_title && m.original_title !== m.title) msg += ` <i>(${h(m.original_title)})</i>`;
  if (year) msg += ` <i>(${year})</i>`;
  msg += '\n';
  if (m?.tagline) msg += `<i>${h(m.tagline)}</i>\n`;
  msg += '\n';
  msg += `⭐ <b>${h(ratingStr)}</b>  ⏱ ${h(runtime)}  🎭 ${h(genres)}\n`;
  if (director) msg += `🎬 ${h(director)}`;
  if (cast)     msg += `  ·  👥 ${h(cast)}`;
  if (director || cast) msg += '\n';
  msg += `\n📝 <i>${h(overview)}</i>`;
  return msg;
}

// s = TMDB series data (may be null for IMDB-sourced results)
function buildSeriesMessage(s, cineMeta) {
  const title   = s?.name || s?.original_name || cineMeta?.name || 'Unknown';
  const year    = s?.first_air_date?.slice(0, 4) || String(cineMeta?.releaseInfo || '').slice(0, 4);
  const seasons = s?.number_of_seasons ? `${s.number_of_seasons}S` : '';
  const eps     = s?.number_of_episodes ? `${s.number_of_episodes} eps` : '';
  const ratingNum = cineMeta?.imdbRating
    ? parseFloat(cineMeta.imdbRating)
    : (s?.vote_average || 0);
  const ratingStr = ratingNum ? `${ratingNum.toFixed(1)}/10 ${stars(ratingNum)}` : 'N/A';
  const creator = cineMeta?.director?.slice(0, 2).join(', ')
                || s?.created_by?.slice(0, 2).map(c => c?.name).filter(Boolean).join(', ') || '';
  const cast    = cineMeta?.cast?.slice(0, 3).join(', ') || '';
  const overview = truncate(cineMeta?.description || s?.overview || 'No overview available.', 200);
  const genres   = cineMeta?.genres?.length
    ? cineMeta.genres.slice(0, 3).join(', ')
    : genreNames(s?.genres);

  let msg = `📺 <b>${h(title)}</b>`;
  if (s?.original_name && s.original_name !== s.name) msg += ` <i>(${h(s.original_name)})</i>`;
  if (year) msg += ` <i>(${year})</i>`;
  msg += '\n';
  if (s?.tagline) msg += `<i>${h(s.tagline)}</i>\n`;
  msg += '\n';
  const meta = [seasons, eps, s?.status].filter(Boolean).join('  ·  ');
  msg += `⭐ <b>${h(ratingStr)}</b>`;
  if (meta) msg += `  📦 ${h(meta)}`;
  msg += `  🎭 ${h(genres)}\n`;
  if (creator) msg += `✍️ ${h(creator)}`;
  if (cast)    msg += `  ·  👥 ${h(cast)}`;
  if (creator || cast) msg += '\n';
  msg += `\n📝 <i>${h(overview)}</i>`;
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
  const param = ctx.match?.trim();
  const userId = ctx.from?.id;
  const name   = h(ctx.from?.first_name || 'there');

  // ── Group→Private deep link: gsp_imdb_movie_tt... / gsp_imdb_tv_tt... / gsp_movie_123 / gsp_tv_123 ──
  if (param?.startsWith('gsp_')) {
    const inner = param.slice(4); // strip 'gsp_'
    if (inner.startsWith('imdb_movie_')) {
      await sendMovieDetail(userId, inner.slice('imdb_movie_'.length));
    } else if (inner.startsWith('imdb_tv_')) {
      await sendTvDetail(userId, inner.slice('imdb_tv_'.length));
    } else if (inner.startsWith('movie_')) {
      await sendTmdbMovieDetail(userId, inner.slice('movie_'.length));
    } else if (inner.startsWith('tv_')) {
      await sendTmdbTvDetail(userId, inner.slice('tv_'.length));
    }
    return;
  }

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
    `• IMDB rating &amp; runtime\n` +
    `• Full plot overview &amp; cast\n` +
    `• Trailer on YouTube\n` +
    `• Free watch link — no ads\n\n` +
    `<i>In groups: just type a movie name — I search automatically!</i>`,
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
    const results = await imdbSearch(query);
    const keyboard = buildImdbKeyboard(results, 'movie');
    if (!keyboard) {
      return safeEdit(chatId, waitMsg?.message_id, `❌ No movies found for "<b>${h(query)}</b>". Try a different spelling.`);
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
    const results = await imdbSearch(query);
    const keyboard = buildImdbKeyboard(results, 'series');
    if (!keyboard) {
      return safeEdit(chatId, waitMsg?.message_id, `❌ No series found for "<b>${h(query)}</b>". Try a different spelling.`);
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
    const results = await imdbSearch(query);
    const keyboard = buildImdbKeyboard(results, 'all');
    if (!keyboard) {
      return safeEdit(chatId, waitMsg?.message_id, `❌ Nothing found for "<b>${h(query)}</b>".`);
    }
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
  const chatId   = ctx.chat?.id;
  const userId   = ctx.from?.id;
  if (!chatId) return;
  const data     = ctx.callbackQuery.data || '';
  const isGroup  = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  // ── Regenerate group search results ───────────────────────────────────────
  if (data.startsWith('regen_')) {
    const key    = data.slice(6);
    const stored = _groupSearch.get(key);
    if (!stored) {
      await ctx.answerCallbackQuery({ text: '⏰ Search expired. Type your query again.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '🔄 Refreshing results...' });
    try {
      const results  = await imdbSearch(stored.query);
      const keyboard = buildImdbKeyboard(results, 'all');
      if (!keyboard) {
        await ctx.editMessageText(`❌ No results for "<b>${h(stored.query)}</b>".`, { parse_mode: 'HTML' });
        return;
      }
      keyboard.push([{ text: '🔄 Regenerate', callback_data: data }]);
      await ctx.editMessageText(
        `🔎 <b>Results for "${h(stored.query)}":</b>\n🎬 = Movie  📺 = Series\n\n<i>Tap a title — details sent to your DM 📩</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      );
    } catch (err) {
      console.error('regen error:', err?.message);
    }
    return;
  }

  // Acknowledge immediately so Telegram stops showing the loading spinner
  // For group callbacks on movie/series — we answer with a DM deep-link URL instead
  const isMovieOrTv = data.startsWith('imdb_movie_') || data.startsWith('imdb_tv_') ||
                      data.startsWith('movie_')      || data.startsWith('tv_');

  if (isGroup && isMovieOrTv) {
    const botUsername = await getBotUsername();
    if (!botUsername) {
      try { await ctx.answerCallbackQuery({ text: '⚠️ Bot not ready yet. Try again in a moment.' }); } catch (_) {}
      return;
    }
    const startParam = `gsp_${data}`; // max 64 chars — all our keys are well within limit
    try {
      await ctx.answerCallbackQuery({ url: `https://t.me/${botUsername}?start=${startParam}` });
    } catch (_) {}
    return;
  }

  // Acknowledge for non-group / non-movie callbacks
  try { await ctx.answerCallbackQuery(); } catch (_) {}

  if (data === 'quick_trending') { handleTrending(chatId); return; }
  if (data === 'quick_popular')  { handlePopularMovies(chatId); return; }
  if (data === 'quick_series')   { handlePopularSeries(chatId); return; }
  if (data === 'quick_genres')   { handleGenres(chatId); return; }

  // ── IMDB-sourced movie detail ──────────────────────────────────────────────
  if (data.startsWith('imdb_movie_')) {
    await sendMovieDetail(chatId, data.slice('imdb_movie_'.length));
    return;
  }

  // ── IMDB-sourced TV detail ─────────────────────────────────────────────────
  if (data.startsWith('imdb_tv_')) {
    await sendTvDetail(chatId, data.slice('imdb_tv_'.length));
    return;
  }

  // ── TMDB-sourced movie detail (trending/popular/genre) ────────────────────
  if (data.startsWith('movie_')) {
    await sendTmdbMovieDetail(chatId, data.slice('movie_'.length));
    return;
  }

  // ── TMDB-sourced TV detail ─────────────────────────────────────────────────
  if (data.startsWith('tv_')) {
    await sendTmdbTvDetail(chatId, data.slice('tv_'.length));
    return;
  }

  // Genre browse
  if (data.startsWith('genre_')) {
    const parts = data.split('_');
    const mediaType = parts[1];
    const genreId = parts[2];
    const genreName = (() => { try { return decodeURIComponent(parts.slice(3).join('_')); } catch (_) { return parts.slice(3).join(' '); } })();
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

// ── Plain text auto-search ────────────────────────────────────────────────────
// Private: search and show results directly.
// Group:   search every message, show results with Regenerate button,
//          auto-delete after 10 min. Tapping a result opens bot DM.
bot.on('message:text', async (ctx) => {
  const rawText = ctx.message.text || '';
  if (rawText.startsWith('/') || rawText.length < 2) return;

  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  const chatId  = ctx.chat.id;
  let query     = rawText.trim();

  if (isGroup) {
    // Strip @mention if present, otherwise treat whole message as query
    const botUsername = await getBotUsername();
    query = rawText.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
    if (!query || query.length < 2) return; // ignore empty / single-char messages
  }

  const waitMsg = await safeSend(chatId, `🔎 Searching for <b>${h(query)}</b>...`);
  try {
    const results  = await imdbSearch(query);
    const keyboard = buildImdbKeyboard(results, 'all');

    if (!keyboard) {
      await safeEdit(chatId, waitMsg?.message_id,
        `❌ Nothing found for "<b>${h(query)}</b>".\nTry a different spelling or use /movie / /series.`);
      return;
    }

    if (isGroup) {
      // Store query for Regenerate, keyed by chat+waitMsg id
      const regenKey = `${chatId}_${waitMsg?.message_id}`;
      _groupSearch.set(regenKey, { query });
      keyboard.push([{ text: '🔄 Regenerate', callback_data: `regen_${regenKey}` }]);

      const sentMsg = await safeEdit(chatId, waitMsg?.message_id,
        `🔎 <b>Results for "${h(query)}":</b>\n🎬 = Movie  📺 = Series\n\n` +
        `<i>Tap a title — details will be sent to your DM 📩</i>`,
        { reply_markup: { inline_keyboard: keyboard } }
      );

      // Auto-delete both the user's search message and the results after 10 min
      const resultMsgId = sentMsg?.message_id ?? waitMsg?.message_id;
      setTimeout(() => {
        bot.api.deleteMessage(chatId, resultMsgId).catch(() => {});
        bot.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
        _groupSearch.delete(regenKey);
      }, 10 * 60 * 1000);

    } else {
      // Private chat — show results directly, no DM redirect needed
      await safeEdit(chatId, waitMsg?.message_id,
        `🔎 <b>Results for "${h(query)}":</b>\n🎬 = Movie  📺 = Series\n\nTap for details &amp; watch links:`,
        { reply_markup: { inline_keyboard: keyboard } }
      );
    }
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
