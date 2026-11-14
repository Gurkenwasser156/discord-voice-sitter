// YouTube-Anbindung pro Discord-User:
// - Login per Google "Device Flow" (Code auf google.com/device eingeben) -> kein Webserver nötig
// - legt eine PRIVATE Playlist im Account des Users an und fügt Favoriten hinzu
//
// Quota (pro Google-Cloud-Projekt, für alle User zusammen): 10.000 Einheiten/Tag.
// Ein Favorit = Suche (100) + Hinzufügen (50) = 150 -> ca. 65 Favoriten pro Tag.

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const API = 'https://www.googleapis.com/youtube/v3';
const PLAYLIST_TITLE = 'j-indies radio ❤️';

export class YoutubeError extends Error {
  constructor(message, code, reason) {
    super(message);
    this.code = code; // 'quota' | 'revoked' | 'notfound' | 'novideo' | undefined
    this.reason = reason; // YouTube-Fehlergrund, z.B. 'playlistNotFound'
  }
}

// ---------- Treffer-Auswahl ----------
// Nicht blind das erste Suchergebnis nehmen: Der Künstler muss im Videotitel
// oder Kanalnamen vorkommen, sonst lieber gar nichts hinzufügen.

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };
const decode = (s) => String(s ?? '').replace(/&(amp|quot|#39|lt|gt);/g, (m) => ENTITIES[m]);
const norm = (s) => decode(s).normalize('NFKC').toLowerCase();
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Kommt `needle` in `hay` vor? Lateinische Namen nur als ganzes Wort ("nem" ≠ "cinema"). */
function contains(hay, needle) {
  if (!needle) return false;
  if (!isAscii(needle)) return hay.includes(needle);
  return new RegExp(`(^|[^a-z0-9])${escRe(needle)}($|[^a-z0-9])`).test(hay);
}

/** "Nem feat. Hatsune Miku & X" -> ["nem feat. hatsune miku & x", "nem", "hatsune miku", "x"] */
function artistNames(artist) {
  const full = norm(artist).trim();
  if (!full) return [];
  const parts = full.split(/\s*(?:\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\s+x\s+|[&×,、\/+])\s*/i);
  return [...new Set([full, ...parts.map((p) => p.trim())])].filter((n) => n.length >= 2);
}

/** Wörter des Songtitels ohne Klammer-Zusätze wie (Remastered) oder feat. */
function titleTokens(title) {
  const t = norm(title)
    .replace(/[(\[（【][^)\]）】]*[)\]）】]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/, ' ');
  return [...new Set(t.split(/[\s\-–—_:;,.!?'"「」『』~〜・/]+/).filter((w) => w.length >= (isAscii(w) ? 2 : 1)))];
}

const JUNK = /\b(cover|covered|karaoke|instrumental|off ?vocal|nightcore|reaction|sped up|slowed|8d|tutorial|lyrics? video)\b|歌ってみた|弾いてみた|踊ってみた|カラオケ|カバー/;

/**
 * Wählt aus YouTube-Suchergebnissen das passende Video für einen Song.
 * Gibt die videoId zurück oder null, wenn nichts sicher passt.
 */
export function pickBestVideo(song, items) {
  const artists = artistNames(song.artist);
  const tokens = titleTokens(song.title ?? song.text);
  const songText = norm(`${song.title ?? ''} ${song.text ?? ''}`);
  let best = null;

  items.forEach((item, rank) => {
    const videoId = item?.id?.videoId;
    if (!videoId) return;
    const vTitle = norm(item.snippet?.title);
    const channel = norm(item.snippet?.channelTitle);
    const hay = `${vTitle} ${channel}`;

    const titleRatio = tokens.length ? tokens.filter((w) => hay.includes(w)).length / tokens.length : 0;
    const artistHit = artists.some((a) => contains(hay, a));
    const topic = channel.endsWith(' - topic') && artists.some((a) => contains(channel, a));

    // Ohne Künstler-Treffer nur bei fast komplettem Titel und wenn gar kein Künstler bekannt ist
    if (artists.length ? !artistHit : titleRatio < 0.8) return;
    if (titleRatio < 0.5) return;

    let score = titleRatio * 2 + (artistHit ? 2 : 0) + (topic ? 1.5 : 0) - rank * 0.05;
    if (JUNK.test(vTitle) && !JUNK.test(songText)) score -= 3;
    if (/\blive\b|ライブ/.test(vTitle) && !/\blive\b|ライブ/.test(songText)) score -= 0.5;
    if (score > 0 && (!best || score > best.score)) best = { videoId, score };
  });

  return best?.videoId ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createYoutube({ clientId, clientSecret }) {
  if (!clientId || !clientSecret) return null;

  const accessTokens = new Map(); // refreshToken -> { token, expires }

  async function postForm(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
  }

  async function accessToken(refreshToken) {
    const cached = accessTokens.get(refreshToken);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;

    const r = await postForm('https://oauth2.googleapis.com/token', {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!r.ok) {
      if (r.json.error === 'invalid_grant') {
        throw new YoutubeError('Google-Zugriff abgelaufen oder entzogen – bitte /youtube verbinden neu ausführen.', 'revoked');
      }
      throw new YoutubeError(`Token-Fehler: ${r.json.error || r.status}`);
    }
    accessTokens.set(refreshToken, { token: r.json.access_token, expires: Date.now() + r.json.expires_in * 1000 });
    return r.json.access_token;
  }

  async function api(refreshToken, method, endpoint, { query, body } = {}) {
    const token = await accessToken(refreshToken);
    const url = new URL(`${API}/${endpoint}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = json.error?.errors?.[0]?.reason;
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
        throw new YoutubeError('YouTube-Tageslimit erreicht.', 'quota');
      }
      if (res.status === 404 || reason === 'playlistNotFound') {
        throw new YoutubeError('Nicht gefunden.', 'notfound', reason);
      }
      if (res.status === 401) {
        accessTokens.delete(refreshToken);
        throw new YoutubeError('Google-Zugriff abgelaufen – bitte /youtube verbinden neu ausführen.', 'revoked');
      }
      throw new YoutubeError(`YouTube-Fehler ${res.status}: ${json.error?.message || reason || 'unbekannt'}`);
    }
    return json;
  }

  async function createPlaylist(refreshToken) {
    const pl = await api(refreshToken, 'POST', 'playlists', {
      query: { part: 'snippet,status' },
      body: {
        snippet: { title: PLAYLIST_TITLE, description: 'Favoriten aus dem j-indies radio (per /fav im Discord).' },
        status: { privacyStatus: 'private' },
      },
    });
    return pl.id;
  }

  /** Sucht die Bot-Playlist im Account des Users (1 Quota-Einheit pro Seite). */
  async function findPlaylist(refreshToken) {
    let pageToken;
    do {
      const page = await api(refreshToken, 'GET', 'playlists', {
        query: { part: 'snippet', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) },
      });
      const hit = page.items?.find((p) => p.snippet?.title === PLAYLIST_TITLE);
      if (hit) return hit.id;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return null;
  }

  /** Vorhandene Playlist wiederverwenden, nur wenn es keine gibt eine neue anlegen. */
  async function findOrCreatePlaylist(refreshToken) {
    return (await findPlaylist(refreshToken)) ?? createPlaylist(refreshToken);
  }

  return {
    /**
     * Startet den Login. Gibt Code + URL zurück und ein Promise, das mit dem
     * refreshToken auflöst (oder mit Fehler, wenn abgelehnt/abgelaufen).
     */
    async startLogin({ maxWaitMs = 14 * 60_000 } = {}) {
      const r = await postForm('https://oauth2.googleapis.com/device/code', { client_id: clientId, scope: SCOPE });
      if (!r.ok) throw new YoutubeError(`Google-Login konnte nicht gestartet werden: ${r.json.error || r.status}`);
      const { device_code, user_code, verification_url, expires_in } = r.json;
      let interval = (r.json.interval || 5) * 1000;
      const deadline = Date.now() + Math.min(expires_in * 1000, maxWaitMs);

      const done = (async () => {
        while (Date.now() < deadline) {
          await sleep(interval);
          const t = await postForm('https://oauth2.googleapis.com/token', {
            client_id: clientId,
            client_secret: clientSecret,
            device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          });
          if (t.ok) {
            if (!t.json.refresh_token) throw new YoutubeError('Google hat kein Refresh-Token geliefert.');
            accessTokens.set(t.json.refresh_token, {
              token: t.json.access_token,
              expires: Date.now() + t.json.expires_in * 1000,
            });
            return t.json.refresh_token;
          }
          const err = t.json.error;
          if (err === 'authorization_pending') continue;
          if (err === 'slow_down') { interval += 5000; continue; }
          if (err === 'access_denied') throw new YoutubeError('Login abgelehnt.');
          if (err === 'expired_token') break;
          throw new YoutubeError(`Login-Fehler: ${err || t.status}`);
        }
        throw new YoutubeError('Login-Code abgelaufen – einfach nochmal /youtube verbinden.');
      })();

      return { userCode: user_code, url: verification_url, expiresAt: deadline, done };
    },

    findOrCreatePlaylist,

    /**
     * Sucht den Song und fügt ihn zur Playlist hinzu. Ist die Playlist weg, wird
     * eine vorhandene gesucht bzw. neu angelegt. Gibt { videoId, itemId, playlistId } zurück.
     */
    async addSong(yt, song) {
      const q = song.artist && song.title ? `${song.artist} ${song.title}` : song.text;
      // 10 Ergebnisse kosten genauso viel Quota wie 1 -> Auswahl statt Glücksspiel
      const search = await api(yt.refreshToken, 'GET', 'search', {
        query: { part: 'snippet', type: 'video', maxResults: '10', videoCategoryId: '10', q },
      });
      let videoId = pickBestVideo(song, search.items ?? []);
      if (!videoId) {
        // Manche Uploads sind nicht als "Musik" einsortiert -> einmal ohne Kategorie
        const any = await api(yt.refreshToken, 'GET', 'search', {
          query: { part: 'snippet', type: 'video', maxResults: '10', q },
        });
        videoId = pickBestVideo(song, any.items ?? []);
      }
      if (!videoId) throw new YoutubeError('Kein sicherer Treffer auf YouTube – lieber nichts als das falsche Video.', 'novideo');

      let playlistId = yt.playlistId;
      const insert = () => api(yt.refreshToken, 'POST', 'playlistItems', {
        query: { part: 'snippet' },
        body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
      });

      let item;
      try {
        item = await insert();
      } catch (err) {
        // Nur wenn wirklich die PLAYLIST fehlt (nicht z.B. das Video)
        if (err.reason !== 'playlistNotFound') throw err;
        playlistId = await findOrCreatePlaylist(yt.refreshToken);
        item = await insert();
      }
      return { videoId, itemId: item.id, playlistId };
    },

    async removeItem(yt, itemId) {
      try {
        await api(yt.refreshToken, 'DELETE', 'playlistItems', { query: { id: itemId } });
      } catch (err) {
        if (err.code !== 'notfound') throw err; // schon weg -> egal
      }
    },

    async revoke(refreshToken) {
      accessTokens.delete(refreshToken);
      await postForm('https://oauth2.googleapis.com/revoke', { token: refreshToken }).catch(() => {});
    },

    playlistUrl: (playlistId) => `https://www.youtube.com/playlist?list=${playlistId}`,
    videoUrl: (videoId) => `https://www.youtube.com/watch?v=${videoId}`,
  };
}
