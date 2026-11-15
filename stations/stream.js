import { spawn } from 'node:child_process';
import { opusOutputArgs } from '../audio.js';

// Internet-Radio-Sender: AzuraCast (Stream-URL + Now Playing aus der öffentlichen API)
// oder ein beliebiger Stream (nur URL, ohne Now Playing).
//
//   AzuraCast-API: GET <base>/api/nowplaying/<station>

// Ehrlicher User-Agent, damit Radio-Betreiber den Bot erkennen/freigeben können
const USER_AGENT = 'discord-voice-sitter-radio/1.0 (+https://github.com/Gurkenwasser156/discord-voice-sitter)';
const NOWPLAYING_CACHE_MS = 10_000;

/** Public-Page-URL (https://host/public/<station>) -> API-URL */
export function azuracastApiUrl(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/(?:public|listen|api\/nowplaying)\/([^/]+)/);
  if (!m) throw new Error(`Keine AzuraCast-URL: ${url} (erwartet https://host/public/<station>)`);
  return { apiUrl: `${u.origin}/api/nowplaying/${encodeURIComponent(m[1])}`, shortcode: m[1] };
}

async function fetchNowPlaying(apiUrl) {
  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/** Default-Mount bevorzugen, sonst listen_url der Station. */
function pickStreamUrl(np) {
  const st = np?.station ?? {};
  const mounts = st.mounts ?? [];
  const mount = mounts.find((m) => m.is_default) ?? mounts[0];
  return mount?.url || st.listen_url || null;
}

function songText(np) {
  const song = np?.now_playing?.song;
  if (!song) return null;
  const text = song.artist && song.title ? `${song.artist} – ${song.title}` : song.text;
  return text?.trim() || null;
}

/** Aktueller Song als schlankes Objekt (für /fav). */
function songInfo(np) {
  const song = np?.now_playing?.song;
  const text = songText(np);
  if (!song || !text) return null;
  return {
    id: song.id || text,
    artist: song.artist?.trim() || null,
    title: song.title?.trim() || null,
    album: song.album?.trim() || null,
    text,
    art: song.art || null,
  };
}

/**
 * def: { id, name, description?, emoji?, azuracast?: url, url?: stream-url }
 */
export function createStreamStation(def, { ffmpegPath, volume, log }) {
  const api = def.azuracast ? azuracastApiUrl(def.azuracast) : null;
  let streamUrl = def.url || null;
  let npCache = null; // { at, np }
  let current = null;
  let live = null;

  async function nowPlayingRaw() {
    if (!api) return null;
    if (npCache && Date.now() - npCache.at < NOWPLAYING_CACHE_MS) return npCache.np;
    const np = await fetchNowPlaying(api.apiUrl);
    npCache = { at: Date.now(), np };
    // Ohne festen Namen (RADIO_NAME) den Sendernamen aus der API übernehmen
    if (!def.fixedName && np?.station?.name) station.name = np.station.name;
    current = songInfo(np) ?? current;
    live = np?.live?.is_live ? (np.live.streamer_name || 'LIVE') : null;
    return np;
  }

  async function refreshStreamUrl() {
    if (def.url || !api) return;
    try {
      const url = pickStreamUrl(await nowPlayingRaw());
      if (url && url !== streamUrl) {
        log(`Stream-URL: ${url}`);
        streamUrl = url;
      }
    } catch (err) {
      log('Stream-URL konnte nicht geholt werden:', err.message);
    }
  }

  const station = {
    id: def.id,
    name: def.name,
    description: def.description || (api ? 'Internet-Radio (AzuraCast)' : 'Internet-Radio'),
    emoji: def.emoji || '📡',
    type: 'stream',

    /** Startet den Stream. Gibt { stream, stop() } zurück. */
    async open() {
      await refreshStreamUrl();
      if (!streamUrl) throw new Error('Keine Stream-URL');

      const proc = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        // HTTP-Abbrüche selbst abfangen, bevor der Player überhaupt Idle wird
        '-user_agent', USER_AGENT,
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
        '-reconnect_delay_max', '5',
        // Hängt der Server ohne Abbruch (keine Daten), nach 15s aufgeben
        '-rw_timeout', '15000000',
        '-i', streamUrl,
        '-vn',
        ...opusOutputArgs(volume),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stopped = false;
      proc.stderr.on('data', (d) => log('ffmpeg:', d.toString().trim()));
      proc.on('error', (err) => log('ffmpeg konnte nicht gestartet werden:', err.message));
      proc.on('close', (code) => { if (!stopped) log(`ffmpeg beendet (Code ${code})`); });

      return {
        stream: proc.stdout,
        stop() {
          stopped = true;
          proc.removeAllListeners();
          proc.kill('SIGKILL');
        },
      };
    },

    /** Aktueller Song; frisch von der API, sonst letzter bekannter Stand. */
    async nowPlaying() {
      try { await nowPlayingRaw(); } catch (err) {
        log('Now Playing fehlgeschlagen, nutze letzten Stand:', err.message);
      }
      return current;
    },

    /** Text für den Bot-Status ("Hört ..."). */
    async presence() {
      try { await nowPlayingRaw(); } catch { /* letzter Stand */ }
      const prefix = live ? `🔴 ${live}: ` : '';
      return prefix + (current?.text ?? npCache?.np?.station?.name ?? def.name);
    },

    /** Beim Laden einmal die API fragen (Sendername für das /radio-Menü). */
    async init() {
      if (!api) return;
      try { await nowPlayingRaw(); } catch (err) { log('API nicht erreichbar:', err.message); }
    },
  };
  return station;
}
