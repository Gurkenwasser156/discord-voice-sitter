import fs from 'node:fs';
import path from 'node:path';
import { ActivityType } from 'discord.js';
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import { resolveFfmpeg, parseVolume } from './audio.js';
import { loadStations } from './stations/index.js';

// Radio mit mehreren Sendern (Internet-Radio, GTA-V-Sender, …), umschaltbar per /radio.
//
// Grundregel wie im Sitter: Bricht ein Stream ab, wird NUR der Player neu
// gestartet. Die Voice-Verbindung bleibt unangetastet -> der Bot bleibt im Channel.

const PRESENCE_MS = 5_000;
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;

const log = (...a) => console.log(new Date().toISOString(), '[radio]', ...a);

export async function createRadio(client, env) {
  const ffmpegPath = await resolveFfmpeg(env.FFMPEG_PATH || null);
  const volume = parseVolume(env.VOLUME);
  const dataDir = env.DATA_DIR || './data';
  const audioDir = env.AUDIO_DIR || './audio';
  log(`ffmpeg: ${ffmpegPath}`);
  log(`Lautstärke: ${Math.round(volume * 100)}%`);
  log(`Audio-Ordner (GTA-Sender): ${path.resolve(audioDir)}`);

  const stations = await loadStations(env, { ffmpegPath, volume, audioDir, dataDir, log });
  if (!stations.size) {
    throw new Error('Kein Sender verfügbar: RADIO_URL setzen und/oder GTA-Audio nach AUDIO_DIR legen (siehe README).');
  }
  log(`Sender: ${[...stations.values()].map((s) => `${s.name} (${s.id})`).join(', ')}`);

  // Zuletzt gewählter Sender überlebt Neustarts
  const stateFile = path.join(dataDir, 'radio-state.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')).station; } catch { /* erster Start */ }
  const wanted = [saved, env.DEFAULT_STATION].find((id) => id && stations.has(id));
  let station = stations.get(wanted) ?? stations.values().next().value;

  function saveState() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ station: station.id }));
    } catch (err) {
      log('Sender-Auswahl konnte nicht gespeichert werden:', err.message);
    }
  }

  // Play statt Pause: auch ohne Zuhörer weiterlaufen, sonst hinkt der Live-Stream hinterher
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  let handle = null;     // { stream, stop(), attach?() } des laufenden Senders
  let resource = null;
  let restartTimer = null;
  let failures = 0;
  let startedAt = 0;
  let lastActivity = null;
  let generation = 0;    // verhindert, dass alte Streams nach einem Wechsel noch Neustarts auslösen

  function stopCurrent() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const h = handle;
    handle = null;
    resource = null;
    try { h?.stop(); } catch (err) { log('Stoppen fehlgeschlagen:', err.message); }
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
    stopCurrent();
    const gen = ++generation;
    const st = station;
    let h;
    try {
      h = await st.open();
    } catch (err) {
      if (gen === generation) scheduleRestart(`${st.name}: ${err.message}`);
      return;
    }
    if (gen !== generation) { h.stop(); return; } // inzwischen umgeschaltet

    handle = h;
    startedAt = Date.now();
    h.stream.on('error', () => {});
    resource = createAudioResource(h.stream, { inputType: StreamType.OggOpus, metadata: { gen } });
    h.attach?.(resource);
    player.play(resource);
    log(`${st.name} gestartet`);
    updatePresence();
  }

  player.on('stateChange', (o, n) => {
    if (o.status === n.status) return;
    if (n.status === AudioPlayerStatus.Playing) failures = 0;
    // Nur reagieren, wenn der aktuelle Stream zu Ende ist (nicht der alte nach einem Wechsel)
    if (n.status === AudioPlayerStatus.Idle && o.resource?.metadata?.gen === generation) {
      scheduleRestart('Stream zu Ende');
    }
  });
  player.on('error', (err) => {
    if (err.resource?.metadata?.gen === generation) scheduleRestart(`Player-Fehler: ${err.message}`);
  });

  async function updatePresence() {
    try {
      const name = String(await station.presence() || station.name).slice(0, 128);
      if (name !== lastActivity) {
        lastActivity = name;
        client.user?.setActivity({ name, type: ActivityType.Listening });
        log(`Now Playing: ${name}`);
      }
    } catch (err) {
      log('Now Playing fehlgeschlagen:', err.message);
    }
  }

  const info = (s) => ({ id: s.id, name: s.name, description: s.description, emoji: s.emoji, type: s.type, dj: s.dj ?? null });

  return {
    player,
    /** Alle Sender (für /radio). */
    stations: () => [...stations.values()].map(info),
    current: () => info(station),
    /** Aktueller Song des laufenden Senders (für /fav). */
    async nowPlaying() {
      return station.nowPlaying();
    },
    /** Auf einen anderen Sender umschalten. */
    async switchTo(id) {
      const next = stations.get(id);
      if (!next) throw new Error(`Unbekannter Sender: ${id}`);
      if (next === station) return info(station);
      log(`Umschalten: ${station.name} -> ${next.name}`);
      stopCurrent();
      station = next;
      failures = 0;
      saveState();
      await start();
      return info(station);
    },
    start() {
      start();
      setInterval(updatePresence, PRESENCE_MS);
    },
  };
}
