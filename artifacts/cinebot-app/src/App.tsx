import { useEffect, useRef, useState, useCallback } from 'react';
import { MediaPlayer, MediaProvider, useMediaStore, isVideoProvider, type MediaPlayerInstance } from '@vidstack/react';
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';

const API_BASE = '/api';

// Resolve poster to a full URL — poster can be a TMDB path (/abc.jpg) or a
// full URL already (Cinemeta). Never prepend TMDB base to a full URL.
function posterUrl(poster: string, size: string): string {
  if (!poster) return '';
  return poster.startsWith('http')
    ? poster
    : `https://image.tmdb.org/t/p/${size}${poster}`;
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function resolveVidLink(p: {
  tmdbId: string; type: string; season?: number; episode?: number;
}): Promise<string | null> {
  const qs = new URLSearchParams({ tmdbId: p.tmdbId, type: p.type });
  if (p.season  != null) qs.set('season',  String(p.season));
  if (p.episode != null) qs.set('episode', String(p.episode));
  try {
    const res = await fetch(`${API_BASE}/vidlink-stream?${qs}`, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const d = await res.json();
    return d.url ?? null;
  } catch { return null; }
}

// Fallback: call an external scraper (same VidLink source, separate infra → no ads)
// Set VITE_SCRAPER_URL to your deployed scraper base URL (e.g. https://your-app.vercel.app)
const SCRAPER_BASE = import.meta.env.VITE_SCRAPER_URL as string | undefined;

async function resolveScraperStream(p: {
  tmdbId: string; type: string; season?: number; episode?: number;
}): Promise<string | null> {
  if (!SCRAPER_BASE) return null;
  const qs = new URLSearchParams({ id: p.tmdbId });
  if (p.season  != null) qs.set('s', String(p.season));
  if (p.episode != null) qs.set('e', String(p.episode));
  try {
    const res = await fetch(`${SCRAPER_BASE}/api?${qs}`, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.url) return null;
    // Proxy the raw vidlink M3U8 URL through our HLS proxy (avoids CORS, no ads)
    return `${API_BASE}/hls-proxy?url=${encodeURIComponent(d.url)}`;
  } catch { return null; }
}

async function resolveSflixUrl(p: {
  title: string; type: string; season?: number; episode?: number;
}): Promise<string | null> {
  const qs = new URLSearchParams({ title: p.title, type: p.type });
  if (p.season  != null) qs.set('season',  String(p.season));
  if (p.episode != null) qs.set('episode', String(p.episode));
  try {
    const res = await fetch(`${API_BASE}/sflix-url?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const d = await res.json();
    return d.url ?? null;
  } catch { return null; }
}

async function resolveRD(p: {
  imdbId?: string; tmdbId?: string; type: string; season?: number; episode?: number;
}): Promise<{ url: string; quality: string } | null> {
  const qs = new URLSearchParams({ type: p.type });
  if (p.imdbId) qs.set('imdbId', p.imdbId);
  if (p.tmdbId) qs.set('tmdbId', p.tmdbId);
  if (p.season  != null) qs.set('season',  String(p.season));
  if (p.episode != null) qs.set('episode', String(p.episode));
  try {
    const res = await fetch(`${API_BASE}/resolve-stream?${qs}`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const d = await res.json();
    return d.url ? { url: d.url, quality: d.quality ?? 'HD' } : null;
  } catch { return null; }
}

function videoProxyUrl(url: string) {
  return `${API_BASE}/video-proxy?url=${encodeURIComponent(url)}`;
}

async function fetchYTSTorrents(imdbId: string) {
  const base = `https://yts.mx/api/v2/movie_details.json?imdb_id=${imdbId}`;
  const urls = [
    base,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}`,
    `https://corsproxy.io/?${encodeURIComponent(base)}`,
  ];
  const tryOne = async (u: string) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('bad');
    const d = await r.json();
    if (d.status !== 'ok' || !d.data?.movie?.torrents?.length) throw new Error('empty');
    return d.data.movie;
  };
  return Promise.any(urls.map(tryOne)).catch(() => { throw new Error('NOT_FOUND'); });
}

function buildMagnet(hash: string, name: string) {
  const tr = [
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:80',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://p4p.arenabg.com:1337',
    'udp://tracker.leechers-paradise.org:6969',
  ].map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`;
}

interface Torrent { quality: string; hash: string; size_bytes: number; }

// ── TMDB series types ──────────────────────────────────────────────────────────

interface SeasonInfo {
  season_number: number;
  name: string;
  episode_count: number;
  poster_path: string | null;
}

interface EpisodeInfo {
  episode_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  runtime: number | null;
}

async function fetchSeriesInfo(tmdbId: string): Promise<SeasonInfo[]> {
  try {
    const r = await fetch(`${API_BASE}/series-info?tmdbId=${tmdbId}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const d = await r.json();
    return d.seasons ?? [];
  } catch { return []; }
}

async function fetchSeasonEpisodes(tmdbId: string, season: number): Promise<EpisodeInfo[]> {
  try {
    const r = await fetch(`${API_BASE}/season-episodes?tmdbId=${tmdbId}&season=${season}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const d = await r.json();
    return d.episodes ?? [];
  } catch { return []; }
}

// ── Spinner & screens ──────────────────────────────────────────────────────────

function Spinner({ size = 40, color = '#e50914' }: { size?: number; color?: string }) {
  return (
    <div style={{
      width: size, height: size,
      border: '3px solid rgba(255,255,255,0.08)',
      borderTopColor: color, borderRadius: '50%',
      animation: 'spin 0.75s linear infinite', flexShrink: 0,
    }} />
  );
}

function FullBg({ poster }: { poster: string }) {
  return poster ? (
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: `url(${posterUrl(poster, 'w780')})`,
      backgroundSize: 'cover', backgroundPosition: 'center',
      filter: 'blur(28px) brightness(0.1)',
    }} />
  ) : null;
}

function LoadingScreen({ poster, title }: { poster: string; title: string }) {
  return (
    <div className="cine-fullscreen">
      <FullBg poster={poster} />
      <div className="cine-vignette" />
      <div className="cine-loading-content" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28, padding: '0 24px' }}>
        {poster ? (
          <div className="cine-loading-poster">
            <img src={posterUrl(poster, 'w185')} alt="" />
          </div>
        ) : (
          <div className="cine-loading-poster cine-skeleton" />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <div className="cine-spinner" />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#fff', letterSpacing: 0.2 }}>Loading stream</div>
            {title && (
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {title}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorScreen({ poster, title, onRetry }: { poster: string; title: string; onRetry: () => void }) {
  return (
    <div className="cine-fullscreen">
      <FullBg poster={poster} />
      <div className="cine-vignette" />
      <div className="cine-loading-content" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '0 36px', textAlign: 'center', maxWidth: 340 }}>
        <div className="cine-error-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#e50914" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#fff', marginBottom: 6 }}>Stream unavailable</div>
          {title && (
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {title}
            </div>
          )}
        </div>
        <button onClick={onRetry} style={{ marginTop: 4, padding: '11px 32px', background: '#e50914', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 700, cursor: 'pointer', letterSpacing: 0.3, boxShadow: '0 4px 20px rgba(229,9,20,0.4)' }}>
          Try Again
        </button>
      </div>
    </div>
  );
}

// ── Iframe Player ─────────────────────────────────────────────────────────────

interface IframePlayerProps {
  src: string;
  title: string;
  poster: string;
  overview: string;
  year: string;
  isTV: boolean;
  currentSeason: number;
  currentEpisode: number;
  hasNextEpisode: boolean;
  onNextEpisode?: () => void;
  onOpenEpisodes?: () => void;
  showEpisodePanel: boolean;
  tmdbId: string;
  onSelectEpisode: (s: number, e: number) => void;
  onCloseEpisodePanel: () => void;
  onSwitchPlayer: () => void;
  playerLabel: string;
}

type SpCheckState = 'checking' | 'available' | 'unavailable';

function IframePlayer({
  src, title, poster, overview, year, isTV, currentSeason, currentEpisode,
  hasNextEpisode, onNextEpisode, onOpenEpisodes,
  showEpisodePanel, tmdbId, onSelectEpisode, onCloseEpisodePanel,
  onSwitchPlayer, playerLabel,
}: IframePlayerProps) {
  const [ready, setReady] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // checkState: server pre-checks if SP has this title before showing Watch button
  // 'checking'   = HEAD request in flight
  // 'available'  = SP returned 200 → show Watch Fullscreen
  // 'unavailable'= SP returned 404 → show Not Available
  const [checkState, setCheckState] = useState<SpCheckState>('checking');

  const goFullscreenLandscape = useCallback(async () => {
    const tg = (window as any).Telegram?.WebApp;
    try { tg?.requestFullscreen?.(); } catch (_) {}
    try { tg?.lockOrientation?.(); } catch (_) {}
    try {
      const el = document.documentElement;
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
    } catch (_) {}
    try { await (screen.orientation as any).lock?.('landscape'); } catch (_) {}
    setReady(true);
  }, []);

  // Reset splash & check state when src changes (new title or episode switch)
  // NOTE: sp-check server endpoint was tried but SP returns 404 for ALL requests
  // from non-Indian IPs (Replit's servers), so it can't distinguish "not in library"
  // from "IP blocked". We default to 'available' and let the user try watching.
  useEffect(() => { setReady(false); setCheckState('available'); }, [src]);

  // Re-show splash if user exits fullscreen or rotates to portrait
  useEffect(() => {
    if (!ready) return;
    const onFsChange = () => {
      if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
        setReady(false);
      }
    };
    const onOrient = () => {
      const angle = screen.orientation?.angle ?? (window.orientation as number) ?? 0;
      if (angle === 0 || angle === 180) setReady(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    window.addEventListener('orientationchange', onOrient);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      window.removeEventListener('orientationchange', onOrient);
    };
  }, [ready]);

  // Hide the loading overlay after a fixed delay — only once iframe is loading
  useEffect(() => {
    if (!ready) return;
    setOverlayVisible(true);
    overlayTimer.current = setTimeout(() => setOverlayVisible(false), 2500);
    return () => { if (overlayTimer.current) clearTimeout(overlayTimer.current); };
  }, [src, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Splash screen — shown before user taps Watch, or when unavailable ───────
  if (!ready) {
    const posterSrc = posterUrl(poster, 'w342') || null;
    const bgSrc     = posterUrl(poster, 'w780') || null;

    return (
      <div className="cine-portrait-overlay">
        {bgSrc && (
          <div
            className="cine-portrait-bg"
            style={{ backgroundImage: `url(${bgSrc})` }}
          />
        )}
        <div className="cine-splash-content">
          {posterSrc && (
            <img
              className="cine-splash-poster"
              src={posterSrc}
              alt={title}
            />
          )}
          <div className="cine-splash-info">
            {title ? <div className="cine-splash-title">{title}</div> : null}
            <div className="cine-splash-meta">
              {year && <span>{year}</span>}
              {isTV && <span className="cine-splash-dot">·</span>}
              {isTV && <span>S{currentSeason} · E{currentEpisode}</span>}
            </div>
            {overview ? <p className="cine-splash-overview">{overview}</p> : null}

            {checkState === 'checking' && (
              <div className="cine-splash-checking">
                <span className="cine-splash-check-dot" />
                <span className="cine-splash-check-dot" />
                <span className="cine-splash-check-dot" />
              </div>
            )}

            {checkState === 'unavailable' && (
              <>
                <div className="cine-coming-soon-badge">🎬 Not Available Yet</div>
                <p className="cine-splash-hint">This title isn't on this source right now.</p>
                <button className="cine-splash-btn cine-splash-btn--alt" onClick={onSwitchPlayer}>
                  Try Another Source
                </button>
              </>
            )}

            {checkState === 'available' && (
              <>
                <button className="cine-splash-btn" onClick={goFullscreenLandscape}>
                  <span className="cine-splash-play-wrap">
                    <span className="cine-splash-play-ring" />
                    <svg className="cine-splash-play-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5,3 19,12 5,21"/>
                    </svg>
                  </span>
                  Watch Fullscreen
                </button>
                <p className="cine-splash-hint">Rotates to landscape · Works best fullscreen</p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <iframe
        src={src}
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
        referrerPolicy="no-referrer"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', display: 'block' }}
      />

      {/* Brief loading overlay while iframe initialises */}
      {overlayVisible && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20, background: '#000',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20,
        }}>
          <FullBg poster={poster} />
          <div className="cine-vignette" />
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            {poster && (
              <div className="cine-loading-poster">
                <img src={posterUrl(poster, 'w185')} alt="" />
              </div>
            )}
            <div className="cine-spinner" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Episode Panel ─────────────────────────────────────────────────────────────

interface EpisodePanelProps {
  tmdbId: string;
  currentSeason: number;
  currentEpisode: number;
  onSelect: (season: number, episode: number) => void;
  onClose: () => void;
}

function EpisodePanel({ tmdbId, currentSeason, currentEpisode, onSelect, onClose }: EpisodePanelProps) {
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [viewSeason, setViewSeason] = useState<number | null>(null); // null = seasons list
  const [loadingSeasons, setLoadingSeasons] = useState(true);
  const [loadingEps, setLoadingEps] = useState(false);

  useEffect(() => {
    setLoadingSeasons(true);
    fetchSeriesInfo(tmdbId).then(s => {
      setSeasons(s);
      setLoadingSeasons(false);
    });
  }, [tmdbId]);

  const openSeason = useCallback((sn: number) => {
    setViewSeason(sn);
    setLoadingEps(true);
    fetchSeasonEpisodes(tmdbId, sn).then(eps => {
      setEpisodes(eps);
      setLoadingEps(false);
    });
  }, [tmdbId]);

  // Panel backdrop + slide-in container
  return (
    <div
      onClick={onClose}
      className="cine-ep-overlay"
      style={{
        position: 'absolute', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="cine-ep-panel"
        style={{
          width: 'min(360px, 94vw)',
          background: 'rgba(8,8,10,0.98)',
          display: 'flex', flexDirection: 'column',
          overflowY: 'hidden',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '-12px 0 48px rgba(0,0,0,0.7)',
        }}
      >
        {/* Header */}
        <div className="cine-ep-header">
          {viewSeason !== null && (
            <button onClick={() => setViewSeason(null)} className="cine-ep-header-btn cine-top-btn">‹</button>
          )}
          <span className="cine-ep-header-title">
            {viewSeason !== null
              ? (seasons.find(s => s.season_number === viewSeason)?.name ?? `Season ${viewSeason}`)
              : 'Seasons'}
          </span>
          <button onClick={onClose} className="cine-ep-header-btn cine-top-btn" style={{ color: 'rgba(255,255,255,0.6)' }}>×</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {viewSeason === null ? (
            // Seasons list
            loadingSeasons ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 36 }}>
                <div className="cine-spinner-sm" />
              </div>
            ) : seasons.length === 0 ? (
              <div style={{ color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '36px 24px', fontSize: 13 }}>
                No season data available
              </div>
            ) : (
              seasons.map(s => (
                <button
                  key={s.season_number}
                  onClick={() => openSeason(s.season_number)}
                  className="cine-season-item"
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                    padding: '12px 16px',
                    background: s.season_number === currentSeason ? 'rgba(229,9,20,0.1)' : 'transparent',
                    border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)',
                    cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  {/* Season poster */}
                  <div style={{
                    width: 40, height: 58, borderRadius: 5, overflow: 'hidden', flexShrink: 0,
                    border: s.season_number === currentSeason
                      ? '1.5px solid rgba(229,9,20,0.6)' : '1px solid rgba(255,255,255,0.08)',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                  }}>
                    {s.poster_path ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w92${s.poster_path}`}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                    ) : (
                      <div className="cine-skeleton" style={{ width: '100%', height: '100%' }} />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontWeight: 700, fontSize: 14,
                      color: s.season_number === currentSeason ? '#e50914' : '#f0f0f0',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginTop: 3 }}>
                      {s.episode_count} {s.episode_count === 1 ? 'episode' : 'episodes'}
                    </div>
                  </div>
                  {s.season_number === currentSeason && (
                    <div style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: 0.8,
                      color: '#e50914', flexShrink: 0, textTransform: 'uppercase',
                    }}>Now</div>
                  )}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </button>
              ))
            )
          ) : (
            // Episodes list
            loadingEps ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 36 }}>
                <div className="cine-spinner-sm" />
              </div>
            ) : episodes.length === 0 ? (
              <div style={{ color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '36px 24px', fontSize: 13 }}>
                No episode data available
              </div>
            ) : (
              episodes.map(ep => {
                const isActive = viewSeason === currentSeason && ep.episode_number === currentEpisode;
                return (
                  <button
                    key={ep.episode_number}
                    onClick={() => { onSelect(viewSeason!, ep.episode_number); onClose(); }}
                    className="cine-ep-item"
                    style={{
                      width: '100%', display: 'flex', alignItems: 'flex-start', gap: 12,
                      padding: '12px 16px',
                      background: isActive ? 'rgba(229,9,20,0.12)' : 'transparent',
                      border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)',
                      cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    {/* Episode number */}
                    <div style={{
                      width: 32, flexShrink: 0, paddingTop: ep.still_path ? 0 : 2,
                      fontWeight: 800, fontSize: 13, fontVariantNumeric: 'tabular-nums',
                      color: isActive ? '#e50914' : 'rgba(255,255,255,0.25)',
                    }}>
                      {String(ep.episode_number).padStart(2, '0')}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Thumbnail */}
                      {ep.still_path ? (
                        <div style={{
                          position: 'relative', width: '100%', aspectRatio: '16/9',
                          borderRadius: 6, overflow: 'hidden', marginBottom: 8,
                          border: isActive ? '1.5px solid rgba(229,9,20,0.5)' : '1px solid rgba(255,255,255,0.06)',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                        }}>
                          <img
                            src={`https://image.tmdb.org/t/p/w300${ep.still_path}`}
                            alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                          {isActive && (
                            <div style={{
                              position: 'absolute', inset: 0,
                              background: 'rgba(229,9,20,0.15)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              <div style={{
                                width: 28, height: 28, borderRadius: '50%',
                                background: 'rgba(229,9,20,0.85)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                              }}>
                                <svg width="10" height="12" viewBox="0 0 10 12" fill="#fff">
                                  <polygon points="0,0 10,6 0,12"/>
                                </svg>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="cine-skeleton" style={{
                          width: '100%', aspectRatio: '16/9', borderRadius: 6, marginBottom: 8,
                        }} />
                      )}
                      <div style={{
                        fontWeight: isActive ? 700 : 500, fontSize: 13,
                        color: isActive ? '#fff' : 'rgba(255,255,255,0.75)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        lineHeight: 1.3,
                      }}>{ep.name}</div>
                      {ep.runtime && (
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 3 }}>
                          {ep.runtime} min
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ── Vidstack player ────────────────────────────────────────────────────────────

interface PlayerProps {
  hlsSrc?: string;
  directSrc?: string;
  p2pVideoRef: React.RefObject<HTMLVideoElement | null>;
  poster: string;
  title: string;
  // P2P
  canP2P: boolean;
  p2pActive: boolean;
  p2pProgress: number;
  p2pSpeed: number;
  onP2P?: () => void;
  qualities: Torrent[];
  activeQ: string;
  onQuality: (q: string) => void;
  // Series
  isTV: boolean;
  currentSeason: number;
  currentEpisode: number;
  hasNextEpisode: boolean;
  onNextEpisode?: () => void;
  onOpenEpisodes?: () => void;
  // Episode panel
  showEpisodePanel: boolean;
  tmdbId: string;
  onSelectEpisode: (s: number, e: number) => void;
  onCloseEpisodePanel: () => void;
  // Re-enter fullscreen automatically after episode switch
  autoFullscreen?: boolean;
  onAutoFsDone?: () => void;
}

function CinePlayer(props: PlayerProps) {
  const {
    hlsSrc, directSrc, p2pVideoRef, poster, title,
    canP2P, p2pActive, p2pProgress, p2pSpeed, onP2P, qualities, activeQ, onQuality,
    isTV, currentSeason, currentEpisode, hasNextEpisode, onNextEpisode, onOpenEpisodes,
    showEpisodePanel, tmdbId, onSelectEpisode, onCloseEpisodePanel,
    autoFullscreen, onAutoFsDone,
  } = props;

  const playerRef = useRef<MediaPlayerInstance>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Update the autoFullscreen ref on every render so the one-shot effect below
  // always reads the latest value without being a dependency.
  const autoFsRef = useRef(autoFullscreen ?? false);
  autoFsRef.current = autoFullscreen ?? false;

  // Vidstack reactive store — controlsVisible re-renders this component when it changes
  const { controlsVisible } = useMediaStore(playerRef);

  // Sync top bar opacity/pointer-events with Vidstack's native controls show/hide
  useEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    el.style.opacity     = controlsVisible ? '1' : '0';
    el.style.pointerEvents = controlsVisible ? 'auto' : 'none';
  }, [controlsVisible]);

  // Expose the raw <video> element so WebTorrent (P2P) can stream to it
  const onProviderChange = useCallback((provider: MediaPlayerInstance['provider']) => {
    if (isVideoProvider(provider)) {
      (p2pVideoRef as { current: HTMLVideoElement | null }).current = provider.video;
    }
  }, [p2pVideoRef]);

  // Re-enter fullscreen after episode switch (fires when hlsSrc/directSrc changes
  // and the autoFullscreen flag was set by the parent)
  useEffect(() => {
    if (!autoFsRef.current) return;
    autoFsRef.current = false;
    onAutoFsDone?.();
    setTimeout(() => {
      try { playerRef.current?.el?.requestFullscreen(); } catch (_) {}
    }, 300);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsSrc, directSrc]);

  // Tracks whether we've already attempted an unmute for the current source so
  // we don't spam it on every play event.
  const unmutedRef = useRef(false);

  // Reset unmute attempt flag whenever the source changes.
  useEffect(() => { unmutedRef.current = false; }, [hlsSrc, directSrc]);

  // Mobile autoplay: Chrome Android silently starts muted autoplay WITHOUT
  // firing onAutoPlayFail. We hook into the first play event and, if the video
  // is muted, try to unmute. In Telegram WebApp (prior user-gesture from the
  // Telegram tap) this succeeds. In a plain browser without a gesture it fails
  // silently and the user can tap the mute button themselves.
  const onPlay = useCallback(() => {
    if (unmutedRef.current) return;
    unmutedRef.current = true;
    const p = playerRef.current;
    const video = p && isVideoProvider(p.provider) ? p.provider.video : null;
    if (!video || !video.muted) return;
    try { video.muted = false; } catch (_) {}
    try { if (p?.muted) p.muted = false; } catch (_) {}
  }, []);

  // onAutoPlayFail fires when BOTH unmuted AND muted autoplay are blocked.
  // Rare on Android, but covers some strict browser/WebView policies.
  const onAutoPlayFail = useCallback(() => {
    unmutedRef.current = true;   // Skip the onPlay attempt
    const p = playerRef.current;
    const video = p && isVideoProvider(p.provider) ? p.provider.video : null;
    if (!video) return;
    video.muted = true;
    video.play()
      .then(() => { try { video.muted = false; } catch (_) {} })
      .catch(() => {});
  }, []);

  const src = hlsSrc
    ? { src: hlsSrc,    type: 'application/x-mpegurl' as const }
    : directSrc
    ? { src: directSrc, type: 'video/mp4' as const }
    : null;

  if (!src) return null;

  return (
    // MediaPlayer becomes the fullscreen root, so all our overlays stay visible
    // in fullscreen without any extra configuration.
    <MediaPlayer
      ref={playerRef}
      className="cine-media-player"
      src={src}
      autoPlay
      playsInline
      title={title}
      onProviderChange={onProviderChange}
      onPlay={onPlay}
      onAutoPlayFail={onAutoPlayFail}
    >
      {/* Blurred poster backdrop */}
      {poster && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          backgroundImage: `url(${posterUrl(poster, 'w780')})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(24px) brightness(0.15)',
        }} />
      )}

      {/* Video + Vidstack's DefaultVideoLayout (controls, center play, progress, settings) */}
      <MediaProvider />
      <DefaultVideoLayout icons={defaultLayoutIcons} />

      {/* ── Top bar overlay ─────────────────────────────────────────── */}
      {/* Starts hidden; opacity/pointer-events synced to Vidstack controlsVisible */}
      <div ref={topBarRef} className="cine-top-bar" style={{ opacity: 0, pointerEvents: 'none', zIndex: 50 }}>
        {poster && (
          <div className="cine-mini-poster">
            <img src={posterUrl(poster, 'w92')} alt="" />
          </div>
        )}
        <div className="cine-title-block">
          <div className="cine-title-main">{title}</div>
          {isTV && (
            <div className="cine-title-sub">
              {`S${String(currentSeason).padStart(2,'0')} · E${String(currentEpisode).padStart(2,'0')}`}
            </div>
          )}
        </div>

        {/* Next Episode button */}
        {isTV && hasNextEpisode && onNextEpisode && (
          <button
            onClick={onNextEpisode}
            title="Next Episode"
            className="cine-top-btn-red"
            style={{
              flexShrink: 0,
              height: 32, padding: '0 12px', borderRadius: 6, fontSize: 12, fontWeight: 700,
              background: 'rgba(229,9,20,0.88)', color: '#fff',
              border: '1px solid rgba(229,9,20,0.5)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#fff">
              <polygon points="5,3 19,12 5,21"/>
              <line x1="19" y1="3" x2="19" y2="21" stroke="#fff" strokeWidth="3" strokeLinecap="round"/>
            </svg>
            Next
          </button>
        )}

        {/* Episodes list button */}
        {isTV && onOpenEpisodes && (
          <button
            onClick={onOpenEpisodes}
            title="Episodes"
            className="cine-top-btn"
            style={{
              flexShrink: 0,
              height: 32, padding: '0 11px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: 'rgba(255,255,255,0.1)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.14)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            <svg width="13" height="11" viewBox="0 0 16 12" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
              <line x1="0" y1="1" x2="16" y2="1"/><line x1="0" y1="6" x2="16" y2="6"/><line x1="0" y1="11" x2="16" y2="11"/>
            </svg>
            Episodes
          </button>
        )}

        {/* P2P boost button */}
        {canP2P && onP2P && (
          <button onClick={onP2P} title="P2P boost"
            className="cine-top-btn"
            style={{
              flexShrink: 0,
              width: 34, height: 32, borderRadius: 6, fontSize: 14,
              background: p2pActive ? 'rgba(34,197,94,0.18)' : 'rgba(255,255,255,0.08)',
              color:      p2pActive ? '#22c55e'              : 'rgba(255,255,255,0.7)',
              border: `1px solid ${p2pActive ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.12)'}`,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>⚡</button>
        )}
      </div>

      {/* ── P2P quality buttons ──────────────────────────────────────── */}
      {p2pActive && qualities.length > 1 && (
        <div style={{ position: 'absolute', top: 64, right: 14, zIndex: 50, display: 'flex', gap: 5 }}>
          {qualities.map(q => (
            <button key={q.quality} onClick={() => onQuality(q.quality)} style={{
              height: 28, padding: '0 11px', borderRadius: 5, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 700, letterSpacing: 0.2,
              background: activeQ === q.quality ? '#e50914' : 'rgba(255,255,255,0.12)',
              color: '#fff',
              boxShadow: activeQ === q.quality ? '0 2px 10px rgba(229,9,20,0.4)' : 'none',
            }}>{q.quality}</button>
          ))}
        </div>
      )}

      {/* ── P2P buffering overlay ────────────────────────────────────── */}
      {p2pActive && p2pProgress < 5 && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
          background: 'rgba(0,0,0,0.6)',
        }}>
          <Spinner size={52} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Connecting to peers…</div>
            <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{p2pProgress}% · {p2pSpeed} KB/s</div>
          </div>
        </div>
      )}

      {/* ── Episode panel ────────────────────────────────────────────── */}
      {showEpisodePanel && (
        <EpisodePanel
          tmdbId={tmdbId}
          currentSeason={currentSeason}
          currentEpisode={currentEpisode}
          onSelect={onSelectEpisode}
          onClose={onCloseEpisodePanel}
        />
      )}
    </MediaPlayer>
  );
}

// ── Portrait detection ──────────────────────────────────────────────────────────

function useIsPortrait() {
  const [portrait, setPortrait] = useState(
    () => window.matchMedia('(orientation: portrait)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)');
    const handler = (e: MediaQueryListEvent) => setPortrait(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return portrait;
}

// ── Portrait overlay ────────────────────────────────────────────────────────────

function PortraitOverlay({
  poster, title, onLandscape,
}: { poster: string; title: string; onLandscape: () => void }) {
  return (
    <div className="cine-portrait-overlay">
      {poster && (
        <div
          className="cine-portrait-bg"
          style={{ backgroundImage: `url(${posterUrl(poster, 'w780')})` }}
        />
      )}
      <div className="cine-portrait-content">
        {poster && (
          <img
            className="cine-portrait-poster"
            src={posterUrl(poster, 'w342')}
            alt={title}
          />
        )}
        <div className="cine-portrait-phone">📱</div>
        {title ? <p className="cine-portrait-title">{title}</p> : null}
        <p className="cine-portrait-hint">Rotate your phone to watch</p>
        <button className="cine-portrait-btn" onClick={onLandscape}>
          Go Fullscreen
        </button>
      </div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────

type AppMode = 'loading' | 'playing' | 'error';
type PlayerMode = 'iframe' | 'vidstack';

export default function App() {
  const p       = new URLSearchParams(window.location.search);
  const type    = p.get('type')    || 'movie';
  const tmdbId  = p.get('id')      || '';
  const title    = p.get('title')    || '';
  const poster   = p.get('poster')   || '';
  const overview = p.get('overview') || '';
  const year     = p.get('year')     || '';
  const imdbId   = p.get('imdb')     || '';
  const initSeason  = parseInt(p.get('season')  || '1', 10);
  const initEpisode = parseInt(p.get('episode') || '1', 10);

  const isTV = type === 'tv' || type === 'anime';

  const isPortrait = useIsPortrait();

  // Try every available API to go fullscreen + lock to landscape.
  // We try all of them regardless — don't early-return on the first one because
  // e.g. Telegram.WebApp.lockOrientation exists even on v6 but is a no-op.
  const tryLandscape = useCallback(async () => {
    const tg = (window as any).Telegram?.WebApp;

    // 1. Telegram WebApp: requestFullscreen (v7.7+) — also auto-locks landscape
    try { tg?.requestFullscreen?.(); } catch (_) {}

    // 2. Telegram WebApp: explicit orientation lock (v8.0+)
    try { tg?.lockOrientation?.(); } catch (_) {}

    // 3. Standard Web Fullscreen API (requires user-gesture — this IS inside a click handler)
    try {
      const el = document.documentElement;
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      } else if ((el as any).webkitRequestFullscreen) {
        (el as any).webkitRequestFullscreen();
      }
    } catch (_) {}

    // 4. Screen Orientation lock — only works once in fullscreen
    try { await (screen.orientation as any).lock?.('landscape'); } catch (_) {}
  }, []);

  // Attempt orientation lock on mount (Telegram WebApp will honor it immediately)
  useEffect(() => { tryLandscape(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const videoRef = useRef<HTMLVideoElement>(null);
  const wtRef    = useRef<any>(null);

  const [appMode,         setAppMode]        = useState<AppMode>('loading');
  const [playerMode,      setPlayerMode]     = useState<PlayerMode>('iframe');
  const [iframeSrc,       setIframeSrc]      = useState('');
  const [iframePlayerIdx, setIframePlayerIdx] = useState(0); // 0=SP, 1=sflix
  const [hlsSrc,          setHlsSrc]         = useState('');
  const [directSrc,       setDirectSrc]      = useState('');
  const [autoFs,          setAutoFs]         = useState(false);
  const vidlinkUrlRef = useRef<string>('');

  const [canP2P,    setCanP2P]    = useState(false);
  const [p2pActive, setP2pActive] = useState(false);
  const [p2pProg,   setP2pProg]   = useState(0);
  const [p2pSpeed,  setP2pSpeed]  = useState(0);
  const [qualities, setQualities] = useState<Torrent[]>([]);
  const [activeQ,   setActiveQ]   = useState('');

  // Series state
  const [currentSeason,  setCurrentSeason]  = useState(initSeason);
  const [currentEpisode, setCurrentEpisode] = useState(initEpisode);
  const [totalEpisodes,  setTotalEpisodes]  = useState<number>(0); // episodes in current season
  const [totalSeasons,   setTotalSeasons]   = useState<number>(0);
  const [showEpisodePanel, setShowEpisodePanel] = useState(false);

  // Fetch series info to know total seasons/episodes
  useEffect(() => {
    if (!isTV || !tmdbId) return;
    fetchSeriesInfo(tmdbId).then(seasons => {
      if (!seasons.length) return;
      setTotalSeasons(seasons.length);
      const cur = seasons.find(s => s.season_number === currentSeason);
      if (cur) setTotalEpisodes(cur.episode_count);
    });
  }, [isTV, tmdbId, currentSeason]);

  // ── Build iframe URL (SP player — loaded directly from user's browser) ───────
  // NOTE: The sp-proxy approach was attempted for "Video Not Found" detection but
  // the proxy fetch runs on Replit's IP (not the user's Indian IP), causing the SP
  // site to refuse the page or return a false "Video Not Found" for every title.
  // Loading directly preserves the user's IP so the player works correctly.

  const buildIframeSrc = useCallback((season: number, episode: number): string | null => {
    if (!imdbId) return null;
    const prefix = isTV ? 's' : 'f';
    let spUrl = `https://gemma416okl.com/play/${prefix}${imdbId}?d=allmovielandapp.app`;
    if (isTV) spUrl += `&s=${season}&e=${episode}`;
    return spUrl;
  }, [imdbId, isTV]);

  // ── Switch to sflix (2nd fallback iframe) ────────────────────────────────

  const switchToSflix = useCallback(async (season: number, episode: number) => {
    setAppMode('loading');
    const url = await resolveSflixUrl({
      title, type,
      season:  isTV ? season  : undefined,
      episode: isTV ? episode : undefined,
    });
    if (url) {
      setIframePlayerIdx(1);
      setIframeSrc(url);
      setPlayerMode('iframe');
      setAppMode('playing');
    } else {
      // sflix failed — go straight to VidLink
      switchToVidstack(season, episode);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, type, isTV]);

  // ── Switch to VidStack player (3rd fallback) ──────────────────────────────

  const switchToVidstack = useCallback(async (season: number, episode: number) => {
    setPlayerMode('vidstack');
    setIframeSrc('');
    setHlsSrc(''); setDirectSrc('');
    setP2pActive(false);

    // Use pre-fetched URL if available
    if (vidlinkUrlRef.current) {
      setHlsSrc(vidlinkUrlRef.current);
      return;
    }

    // Otherwise try scraper then VidLink
    const scraperUrl = await resolveScraperStream({
      tmdbId, type,
      season:  isTV ? season  : undefined,
      episode: isTV ? episode : undefined,
    });
    if (scraperUrl) {
      setHlsSrc(scraperUrl);
      return;
    }

    const url = await resolveVidLink({
      tmdbId, type,
      season:  isTV ? season  : undefined,
      episode: isTV ? episode : undefined,
    });
    if (url) {
      setHlsSrc(url);
    } else {
      setAppMode('error');
    }
  }, [tmdbId, type, isTV]);

  // ── Cycle through all players ─────────────────────────────────────────────
  // 0 = SP (kayel415jek.com)  →  VidLink (vidstack mode)

  const switchPlayer = useCallback((season: number, episode: number) => {
    switchToVidstack(season, episode);
  }, [switchToVidstack]);

  // ── Load stream ──────────────────────────────────────────────────────────

  const load = useCallback(async (season: number, episode: number) => {
    setAppMode('loading');
    setIframeSrc(''); setHlsSrc(''); setDirectSrc('');
    setP2pActive(false);
    vidlinkUrlRef.current = '';
    setPlayerMode('iframe');
    setIframePlayerIdx(0);

    const iSrc = buildIframeSrc(season, episode);

    if (iSrc) {
      // Primary: SP iframe — show immediately
      setIframeSrc(iSrc);
      setAppMode('playing');

      // Background: pre-fetch VidLink so it's ready if user switches
      resolveVidLink({
        tmdbId, type,
        season:  isTV ? season  : undefined,
        episode: isTV ? episode : undefined,
      }).then(url => {
        if (url) vidlinkUrlRef.current = url;
      }).catch(() => {});
    } else {
      // No IMDB ID — go straight to VidLink
      const url = await resolveVidLink({
        tmdbId, type,
        season:  isTV ? season  : undefined,
        episode: isTV ? episode : undefined,
      });
      if (url) {
        setHlsSrc(url);
        setPlayerMode('vidstack');
        setAppMode('playing');
      } else {
        setAppMode('error');
      }
    }

    // Background: RD override (switches to direct MP4 if available)
    resolveRD({
      imdbId: imdbId || undefined, tmdbId: tmdbId || undefined, type,
      season:  isTV ? season  : undefined,
      episode: isTV ? episode : undefined,
    }).then(rd => {
      if (rd) {
        setDirectSrc(videoProxyUrl(rd.url));
        setHlsSrc('');
        setIframeSrc('');
        setPlayerMode('vidstack');
      }
    }).catch(() => {});

    // Background: P2P availability (movies only)
    if (type === 'movie' && imdbId) {
      fetchYTSTorrents(imdbId).then(movie => {
        const list: Torrent[] = (movie.torrents || []).sort((a: Torrent, b: Torrent) => {
          const o: Record<string, number> = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3 };
          return (o[a.quality] ?? 9) - (o[b.quality] ?? 9);
        });
        setQualities(list);
        setActiveQ(list[0]?.quality ?? '');
        setCanP2P(true);
      }).catch(() => {});
    }
  }, [tmdbId, type, imdbId, isTV, buildIframeSrc]);

  useEffect(() => { load(initSeason, initEpisode); }, []);

  // ── Episode navigation ───────────────────────────────────────────────────

  const selectEpisode = useCallback((season: number, episode: number) => {
    setCurrentSeason(season);
    setCurrentEpisode(episode);
    setShowEpisodePanel(false);
    // If in fullscreen, flag it so CinePlayer re-enters fullscreen after new episode loads.
    setAutoFs(!!document.fullscreenElement);
    // Always use keepMounted=false — shows LoadingScreen while resolving,
    // then does a clean full init. In-place swaps are broken on Android Chrome.
    load(season, episode);

    // Update series info for new season
    fetchSeriesInfo(tmdbId).then(seasons => {
      const s = seasons.find(x => x.season_number === season);
      if (s) setTotalEpisodes(s.episode_count);
      setTotalSeasons(seasons.length);
    });
  }, [load, tmdbId]);

  const goNextEpisode = useCallback(() => {
    if (currentEpisode < totalEpisodes) {
      selectEpisode(currentSeason, currentEpisode + 1);
    } else if (currentSeason < totalSeasons) {
      selectEpisode(currentSeason + 1, 1);
    }
  }, [currentEpisode, totalEpisodes, currentSeason, totalSeasons, selectEpisode]);

  const hasNextEpisode = isTV && (currentEpisode < totalEpisodes || currentSeason < totalSeasons);

  // ── P2P ─────────────────────────────────────────────────────────────────

  const startP2P = useCallback((torrent: Torrent) => {
    const WT = (window as any).WebTorrent;
    if (!WT) return;
    if (wtRef.current) { try { wtRef.current.destroy(); } catch (_) {} }
    setP2pActive(true);
    setP2pProg(0); setP2pSpeed(0);
    setHlsSrc(''); setDirectSrc('');

    const client = new WT();
    wtRef.current = client;
    client.add(buildMagnet(torrent.hash, title), (t: any) => {
      const file = t.files.find((f: any) => /\.(mp4|mkv|avi|mov|webm)$/i.test(f.name));
      if (!file) return;
      if (videoRef.current) {
        file.renderTo(videoRef.current, (err: any) => { if (err) console.error(err); });
      }
      const iv = setInterval(() => {
        if (!wtRef.current) { clearInterval(iv); return; }
        setP2pProg(Math.round(t.progress * 100));
        setP2pSpeed(Math.round(t.downloadSpeed / 1024));
      }, 1000);
    });
    client.on('error', () => {});
  }, [title]);

  const triggerP2P = useCallback(() => {
    const t = qualities.find(q => q.quality === activeQ) ?? qualities[0];
    if (t) startP2P(t);
  }, [qualities, activeQ, startP2P]);

  const switchQuality = useCallback((q: string) => {
    const t = qualities.find(x => x.quality === q);
    if (t) { setActiveQ(q); startP2P(t); }
  }, [qualities, startP2P]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (appMode === 'loading') return <LoadingScreen poster={poster} title={title} />;
  if (appMode === 'error')   return <ErrorScreen   poster={poster} title={title} onRetry={() => load(currentSeason, currentEpisode)} />;

  // Iframe player works fine in portrait — skip the rotation gate for it
  if (playerMode === 'iframe' && iframeSrc) {
    const nextPlayerLabel = 'Try VidLink';
    return (
      <IframePlayer
        src={iframeSrc}
        title={title}
        poster={poster}
        overview={overview}
        year={year}
        isTV={isTV}
        currentSeason={currentSeason}
        currentEpisode={currentEpisode}
        hasNextEpisode={false}
        onNextEpisode={undefined}
        onOpenEpisodes={undefined}
        showEpisodePanel={false}
        tmdbId={tmdbId}
        onSelectEpisode={selectEpisode}
        onCloseEpisodePanel={() => setShowEpisodePanel(false)}
        onSwitchPlayer={() => switchPlayer(currentSeason, currentEpisode)}
        playerLabel={nextPlayerLabel}
      />
    );
  }

  // Vidstack player needs landscape
  if (isPortrait) return <PortraitOverlay poster={poster} title={title} onLandscape={tryLandscape} />;

  return (
    <CinePlayer
      hlsSrc={hlsSrc || undefined}
      directSrc={directSrc || undefined}
      p2pVideoRef={videoRef}
      poster={poster}
      title={title}
      canP2P={canP2P}
      p2pActive={p2pActive}
      p2pProgress={p2pProg}
      p2pSpeed={p2pSpeed}
      onP2P={triggerP2P}
      qualities={qualities}
      activeQ={activeQ}
      onQuality={switchQuality}
      isTV={isTV}
      currentSeason={currentSeason}
      currentEpisode={currentEpisode}
      hasNextEpisode={hasNextEpisode}
      onNextEpisode={isTV ? goNextEpisode : undefined}
      onOpenEpisodes={isTV ? () => setShowEpisodePanel(true) : undefined}
      showEpisodePanel={showEpisodePanel}
      tmdbId={tmdbId}
      onSelectEpisode={selectEpisode}
      onCloseEpisodePanel={() => setShowEpisodePanel(false)}
      autoFullscreen={autoFs}
      onAutoFsDone={() => setAutoFs(false)}
    />
  );
}
