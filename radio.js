import { spawn } from 'node:child_process';
import { ActivityType } from 'discord.js';
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';

// AzuraCast-Radio: Stream-URL und "Now Playing" kommen aus der öffentlichen API
//   GET <base>/api/nowplaying/<station>
//
// Grundregel wie im Sitter: Bricht der Stream ab, wird NUR der Player neu
// gestartet. Die Voice-Verbindung bleibt unangetastet -> der Bot bleibt im Channel.

const NOWPLAYING_MS = 15_000;
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;

// Ehrlicher User-Agent, damit Radio-Betreiber den Bot erkennen/freigeben können
const USER_AGENT = 'discord-voice-sitter-radio/1.0 (+https://github.com/Gurkenwasser156/discord-voice-sitter)';

const log = (...a) => console.log(new Date().toISOString(), '[radio]', ...a);

/**
 * Akzeptiert die Public-Page-URL (https://host/public/<station>) oder
 * RADIO_BASE_URL + RADIO_STATION getrennt.
 */
export function parseRadioConfig(env) {
  let base = env.RADIO_BASE_URL;
  let station = env.RADIO_STATION;

  if (env.RADIO_URL) {
    const u = new URL(env.RADIO_URL);
    const m = u.pathname.match(/\/(?:public|listen|api\/nowplaying)\/([^/]+)/);
    base ??= u.origin;
    station ??= m?.[1];
  }

  if (!base || !station) {
    throw new Error('RADIO_URL (z.B. https://radio.j-indies.net/public/j-indies) oder RADIO_BASE_URL + RADIO_STATION setzen.');
  }

  return {
    apiUrl: `${base.replace(/\/+$/, '')}/api/nowplaying/${encodeURIComponent(station)}`,
    streamOverride: env.STREAM_URL || null,
    volume: env.VOLUME ? Number(env.VOLUME) : null,
    ffmpegPath: env.FFMPEG_PATH || null,
  };
}

async function resolveFfmpeg(explicit) {
  if (explicit) return explicit;
  try {
    const mod = await import('ffmpeg-static');
    if (mod.default) return mod.default;
  } catch { /* nicht installiert -> System-ffmpeg */ }
  return 'ffmpeg';
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

export async function createRadio(client, env) {
  const cfg = parseRadioConfig(env);
  const ffmpegPath = await resolveFfmpeg(cfg.ffmpegPath);
  log(`API: ${cfg.apiUrl}`);
  log(`ffmpeg: ${ffmpegPath}`);

  // Play statt Pause: auch ohne Zuhörer weiterlaufen, sonst hinkt der Live-Stream hinterher
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  let streamUrl = cfg.streamOverride;
  let ffmpeg = null;
  let restartTimer = null;
  let failures = 0;
  let startedAt = 0;
  let lastActivity = null;

  async function refreshStreamUrl() {
    if (cfg.streamOverride) return;
    try {
      const url = pickStreamUrl(await fetchNowPlaying(cfg.apiUrl));
      if (url && url !== streamUrl) {
        log(`Stream-URL: ${url}`);
        streamUrl = url;
      }
    } catch (err) {
      log('Stream-URL konnte nicht geholt werden:', err.message);
    }
  }

  function killFfmpeg() {
    if (!ffmpeg) return;
    ffmpeg.removeAllListeners();
    ffmpeg.stdout?.removeAllListeners();
    ffmpeg.kill('SIGKILL');
    ffmpeg = null;
  }

  function scheduleRestart(reason) {
    if (restartTimer) return;
    // Lief der Stream länger als eine Minute stabil, wieder bei 2s anfangen
    if (startedAt && Date.now() - startedAt > 60_000) failures = 0;
    startedAt = 0;
    const delay = Math.min(RESTART_MIN_MS * 2 ** failures, RESTART_MAX_MS);
    failures++;
    log(`${reason} -> Neustart in ${delay / 1000}s`);
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
  }

  async function start() {
    killFfmpeg();
    await refreshStreamUrl();
    if (!streamUrl) return scheduleRestart('Keine Stream-URL');

    const args = [
      '-hide_banner', '-loglevel', 'error',
      // HTTP-Abbrüche selbst abfangen, bevor der Player überhaupt Idle wird
      '-user_agent', USER_AGENT,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      // Hängt der Server ohne Abbruch (keine Daten), nach 15s aufgeben
      '-rw_timeout', '15000000',
      '-i', streamUrl,
      '-vn',
      ...(cfg.volume != null && cfg.volume !== 1 ? ['-af', `volume=${cfg.volume}`] : []),
      // Direkt Ogg/Opus erzeugen -> kein Opus-Encoder in Node nötig
      '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-f', 'ogg', 'pipe:1',
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpeg = proc;
    startedAt = Date.now();

    proc.stderr.on('data', (d) => log('ffmpeg:', d.toString().trim()));
    proc.on('error', (err) => {
      if (proc !== ffmpeg) return;
      log('ffmpeg konnte nicht gestartet werden:', err.message);
      ffmpeg = null;
      scheduleRestart('ffmpeg-Fehler');
    });
    proc.on('close', (code) => {
      if (proc === ffmpeg) log(`ffmpeg beendet (Code ${code})`);
    });

    player.play(createAudioResource(proc.stdout, { inputType: StreamType.OggOpus }));
    log('Stream gestartet');
  }

  player.on(AudioPlayerStatus.Idle, () => scheduleRestart('Stream zu Ende'));
  player.on('error', (err) => scheduleRestart(`Player-Fehler: ${err.message}`));
  player.on('stateChange', (o, n) => {
    if (o.status !== n.status && n.status === AudioPlayerStatus.Playing) failures = 0;
  });

  async function updatePresence() {
    try {
      const np = await fetchNowPlaying(cfg.apiUrl);
      const live = np?.live?.is_live ? `🔴 ${np.live.streamer_name || 'LIVE'}: ` : '';
      const text = songText(np);
      const name = (live + (text ?? np?.station?.name ?? 'Radio')).slice(0, 128);
      if (name !== lastActivity) {
        lastActivity = name;
        client.user?.setActivity({ name, type: ActivityType.Listening });
        log(`Now Playing: ${name}`);
      }
    } catch (err) {
      log('Now Playing fehlgeschlagen:', err.message);
    }
  }

  return {
    player,
    start() {
      start();
      updatePresence();
      setInterval(updatePresence, NOWPLAYING_MS);
    },
  };
}
