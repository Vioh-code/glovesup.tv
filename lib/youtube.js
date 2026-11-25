// F-C3 YouTube checks (03-state-flows, section 8). No API key.
// 1. parseYouTubeUrl: server-side format check for watch, youtu.be and shorts
//    links. Returns the 11-character id and the canonical watch url, or null.
// 2. checkVideo: asks YouTube's public oEmbed endpoint whether the video exists
//    and is viewable, and returns the title and thumbnail to save as snapshots.
//    Private, deleted and embedding-disabled videos all answer 401/403/404, so
//    they count as dead. No answer, a timeout or a bad reply is "unreachable":
//    the caller refuses and saves nothing.
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
const MAX_URL = 200;
const MAX_TITLE = 200;
const TIMEOUT_MS = 5000;
const THUMB_HOST = 'i.ytimg.com'; // the only image host the CSP allows

const canonical = (id) => `https://www.youtube.com/watch?v=${id}`;

function parseYouTubeUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_URL) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    const m = /^\/([^/]+)$/.exec(u.pathname);
    id = m && m[1];
  } else if (WATCH_HOSTS.has(host)) {
    if (u.pathname === '/watch') {
      const v = u.searchParams.getAll('v');
      if (v.length === 1) [id] = v;
    } else {
      const m = /^\/shorts\/([^/]+)$/.exec(u.pathname);
      id = m && m[1];
    }
  }
  if (!id || !ID_RE.test(id)) return null;
  return { videoId: id, url: canonical(id) };
}

const DEAD = Object.freeze({ ok: false, reason: 'dead' });
const UNREACHABLE = Object.freeze({ ok: false, reason: 'unreachable' });

function thumbnailFrom(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === THUMB_HOST && !u.port && !u.username ? u.href : null;
  } catch {
    return null;
  }
}

async function checkVideo(videoId, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof videoId !== 'string' || !ID_RE.test(videoId)) throw new Error('checkVideo needs a valid video id');
  const q = new URL('https://www.youtube.com/oembed');
  q.searchParams.set('url', canonical(videoId));
  q.searchParams.set('format', 'json');
  let res;
  try {
    res = await fetch(q.href, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' },
    });
  } catch {
    return { ...UNREACHABLE };
  }
  if ([400, 401, 403, 404].includes(res.status)) return { ...DEAD };
  if (res.status !== 200) return { ...UNREACHABLE };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ...UNREACHABLE };
  }
  if (!body || typeof body.title !== 'string' || !body.title.trim()) return { ...UNREACHABLE };
  return { ok: true, title: body.title.trim().slice(0, MAX_TITLE), thumbnail: thumbnailFrom(body.thumbnail_url) };
}

module.exports = { parseYouTubeUrl, checkVideo, VIDEO_ID_RE: ID_RE };
