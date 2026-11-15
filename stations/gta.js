import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { opusOutputArgs, probeAudio, PCM_BYTES_PER_SEC, SAMPLE_RATE, CHANNELS } from '../audio.js';

// GTA-V-Radiosender aus einem Audio-Dump: Songs, DJ-Moderation und Jingles werden
// live zusammengemischt, so wie es das Spiel macht:
//
//   - Zwischen den Songs: Station-IDs (Jingles), DJ-Solos, optional Werbe-/Nachrichtenblöcke
//     (mit "TO_AD"/"TO_NEWS"-Überleitung, nur wenn ad/ bzw. news/ vorhanden sind)
//   - Über dem Song-Intro: song-spezifische Ansage, allgemeine Ansage oder Tageszeit-Ansage
//     (Morgen/Abend nach Ortszeit, TZ). Die Musik wird dabei per Sidechain etwas geduckt.
//   - Der Sender läuft "im Hintergrund" weiter: Schaltet man weg und später zurück,
//     ist er so weit, wie er in der Zwischenzeit gekommen wäre – wie im Spiel.
//   - Beim Start steigt man irgendwo mitten in einem Song ein.
//
// Erwartete Ordnerstruktur (so wie ihn die gängigen GTA-V-Audio-Dumps liefern):
//   <song_name>/<SONG_NAME>.wav    ein Song pro Ordner
//   intro/<SONG_NAME>_01.wav       DJ-Ansagen zu bestimmten Songs
//   general/GENERAL_01.wav         allgemeine Ansagen (über Song-Intros)
//   time/MORNING_01.wav            Tageszeit-Ansagen (MORNING, AFTERNOON, EVENING, NIGHT)
//   to/TO_AD_01.wav                Überleitungen zu Werbung/Nachrichten
//   id_01/ID_01.wav                Station-IDs / Jingles
//   mono_solo_01/MONO_SOLO_01.wav  DJ-Solos (Moderation ohne Musik)
//   ad/…, news/…                   optional: Werbung, Nachrichten nur für diesen Sender
//
// Werbung und Nachrichten teilen sich im Spiel alle Sender (RADIO_ADVERTS.rpf, RADIO_NEWS.rpf).
// Darum werden zusätzlich gemeinsame Ordner in AUDIO_DIR benutzt, auch mit Unterordnern
// (z.B. "Radio Adverts/mono_ad001_life_invader/MONO_AD001_LIFE_INVADER.wav"):
//   AUDIO_DIR/adverts  oder  AUDIO_DIR/Radio Adverts
//   AUDIO_DIR/news     oder  AUDIO_DIR/Radio News
// Pro Sender abschaltbar mit "ads": false / "news": false, oder anderer Ordner: "ads": "<ordner>".
// Erlaubte Formate: alles, was ffmpeg liest (.wav, .ogg, .opus, .mp3, .flac, .m4a).

const AUDIO_EXT = new Set(['.wav', '.ogg', '.opus', '.mp3', '.flac', '.m4a', '.aac']);

// Wann und wie oft was kommt (an GTA V angelehnt)
const BREAK = { ad: 0.12, news: 0.06, id: 0.30, solo: 0.18 }; // Rest: direkt nächster Song
const INTRO = { time: 0.15, song: 0.55, general: 0.15 };      // Rest: Song ohne Ansage
const VOICE_DELAY_MS = 800;   // DJ setzt kurz nach Songbeginn ein
const MAX_CATCHUP_SEC = 12 * 3600; // länger weg -> einfach irgendwo neu einsteigen
const MAX_DECODE_FAILURES = 5;
const MAX_AD_SEC = 180;  // längere "Werbung" sind TV-Sendungen aus dem Dump
// TV-Werbung/-Sendungen (mono_tv_…) liegen mit im Werbe-Archiv, gehören aber nicht ins Radio
const isTvAudio = (f) => f.split(/[\\/]/).some((part) => /^(mono_)?tv_/i.test(part));

const TIME_SLOTS = [
  { key: 'MORNING', from: 5, to: 12 },
  { key: 'AFTERNOON', from: 12, to: 18 },
  { key: 'EVENING', from: 18, to: 24 },
  { key: 'NIGHT', from: 0, to: 5 },
];

const keyOf = (file) => path.basename(file, path.extname(file)).toUpperCase();
const titleCase = (key) => key.toLowerCase().split('_').filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Alle Audiodateien unterhalb von dir (rekursiv). */
function listAudioDeep(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listAudioDeep(p);
    return e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase()) ? [p] : [];
  }).sort();
}

const SHARED = {
  ads: ['adverts', 'Radio Adverts', 'ads'],
  news: ['news', 'Radio News'],
};

/** Gemeinsamer Werbe-/Nachrichten-Ordner: def.ads/def.news (Ordnername oder false) oder Standardnamen. */
function sharedFiles(audioDir, setting, defaults) {
  if (setting === false) return [];
  const names = typeof setting === 'string' ? [setting] : defaults;
  for (const name of names) {
    const dir = path.resolve(audioDir, name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return listAudioDeep(dir);
  }
  return [];
}

function listAudio(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Liest den Dump-Ordner ein und sortiert alles in Kategorien. */
function scanFolder(root, aliases, log) {
  const lib = {
    songs: new Map(),   // KEY -> file
    intros: new Map(),  // SONG_KEY -> [file]
    general: [], ids: [], solos: [], ads: [], news: [],
    time: new Map(),    // MORNING -> [file]
    to: new Map(),      // AD -> [file]
  };
  const push = (map, key, file) => { if (!map.has(key)) map.set(key, []); map.get(key).push(file); };
  const unknownIntros = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const folder = entry.name.toLowerCase();
    const files = listAudio(dir);

    if (folder === 'intro') {
      for (const f of files) {
        const raw = keyOf(f).replace(/_\d+$/, '');
        if (/^0X[0-9A-F]+$/.test(raw)) { unknownIntros.push(path.basename(f)); continue; }
        push(lib.intros, aliases[raw] ?? raw, f);
      }
    } else if (folder === 'general') lib.general.push(...files);
    else if (folder === 'time') {
      for (const f of files) {
        const slot = TIME_SLOTS.find((s) => keyOf(f).startsWith(s.key));
        if (slot) push(lib.time, slot.key, f);
      }
    } else if (folder === 'to') {
      for (const f of files) {
        const m = keyOf(f).match(/^TO_([A-Z]+)/);
        if (m) push(lib.to, m[1], f);
      }
    } else if (/^id(_\d+)?$/.test(folder)) lib.ids.push(...files);
    else if (/^(mono_)?solo(_\d+)?$/.test(folder) || /^mono_solo_\d+$/.test(folder)) lib.solos.push(...files);
    else if (/^(ad|ads|advert|adverts)$/.test(folder)) lib.ads.push(...listAudioDeep(dir));
    else if (folder === 'news') lib.news.push(...listAudioDeep(dir));
    else {
      // Alles andere: ein Song pro Ordner
      for (const f of files) lib.songs.set(keyOf(f), f);
    }
  }

  if (unknownIntros.length) log(`${unknownIntros.length} Intros ohne Songnamen ignoriert: ${unknownIntros.join(', ')}`);
  for (const key of lib.intros.keys()) {
    if (!lib.songs.has(key)) log(`Intro ${key} ohne passenden Song (ignoriert)`);
  }
  for (const key of [...lib.intros.keys()]) if (!lib.songs.has(key)) lib.intros.delete(key);
  return lib;
}

/** Dauer aller Dateien bestimmen, mit Cache (Pfad + Größe + Änderungszeit). */
async function probeAll(files, { ffmpegPath, cacheFile, log }) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* leer */ }
  const durations = new Map();
  const todo = [];
  for (const file of files) {
    const st = fs.statSync(file);
    const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (cache[file]?.sig === sig && 'mono' in cache[file]) durations.set(file, cache[file]);
    else todo.push({ file, sig });
  }
  if (todo.length) {
    log(`Bestimme Länge von ${todo.length} Dateien …`);
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < todo.length) {
        const { file, sig } = todo[i++];
        try {
          const { duration, mono } = await probeAudio(ffmpegPath, file);
          cache[file] = { sig, d: duration, mono };
          durations.set(file, cache[file]);
        } catch (err) {
          log(err.message);
        }
      }
    }));
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
    } catch (err) { log('Längen-Cache nicht gespeichert:', err.message); }
  }
  return durations;
}

/** Zufallsauswahl ohne baldige Wiederholung (wie im Spiel: kürzlich Gespieltes wird übersprungen). */
function createBag(items) {
  const recent = [];
  const window = Math.floor(items.length / 2);
  return {
    size: items.length,
    pick() {
      if (!items.length) return null;
      const options = items.filter((x) => !recent.includes(x));
      const choice = pickRandom(options.length ? options : items);
      recent.push(choice);
      while (recent.length > window) recent.shift();
      return choice;
    },
  };
}

function currentTimeSlot(date = new Date()) {
  const h = date.getHours();
  return TIME_SLOTS.find((s) => h >= s.from && h < s.to)?.key;
}

/**
 * def: { id, name, folder, dj?, description?, emoji?, aliases?, songs?: { KEY: { artist, title } } }
 */
export async function createGtaStation(def, { ffmpegPath, volume, audioDir, dataDir, log, settings = {} }) {
  const root = path.resolve(audioDir, def.folder ?? def.id);
  if (!fs.existsSync(root)) {
    log(`Audio-Ordner ${root} fehlt -> Sender "${def.name}" übersprungen`);
    return null;
  }

  const lib = scanFolder(root, def.aliases ?? {}, log);
  // Eigene ad/ bzw. news/ im Sender-Ordner haben Vorrang vor den gemeinsamen
  if (!lib.ads.length) lib.ads = sharedFiles(audioDir, def.ads, SHARED.ads);
  lib.ads = lib.ads.filter((f) => !isTvAudio(f));
  if (!lib.news.length) lib.news = sharedFiles(audioDir, def.news, SHARED.news);
  if (!lib.songs.size) {
    log(`Keine Songs in ${root} -> Sender "${def.name}" übersprungen`);
    return null;
  }

  const allFiles = [
    ...lib.songs.values(), ...[...lib.intros.values()].flat(), ...lib.general, ...lib.ids,
    ...lib.solos, ...lib.ads, ...lib.news, ...[...lib.time.values()].flat(), ...[...lib.to.values()].flat(),
  ];
  const durations = await probeAll(allFiles, {
    ffmpegPath, log, cacheFile: path.join(dataDir, 'durations.json'),
  });
  const dur = (f) => durations.get(f)?.d ?? 0;
  const isMono = (f) => durations.get(f)?.mono ?? false;
  // Mono auf beide Kanäle legen (ohne die -3 dB, die ffmpegs Standard-Upmix kostet)
  const stereo = (f) => (isMono(f) ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo');

  // Dateien ohne Länge (kaputt/unlesbar) rauswerfen
  const ok = (f) => dur(f) > 0.1;
  for (const [k, f] of lib.songs) if (!ok(f)) lib.songs.delete(k);
  for (const k of ['general', 'ids', 'solos', 'ads', 'news']) lib[k] = lib[k].filter(ok);
  lib.ads = lib.ads.filter((f) => dur(f) <= MAX_AD_SEC);
  for (const map of [lib.intros, lib.time, lib.to]) {
    for (const [k, list] of map) {
      const good = list.filter(ok);
      if (good.length) map.set(k, good); else map.delete(k);
    }
  }

  const meta = def.songs ?? {};
  function songMeta(key) {
    const m = meta[key] ?? {};
    const title = m.title ?? titleCase(key);
    const artist = m.artist ?? null;
    return {
      id: `${def.id}:${key}`,
      artist,
      title,
      album: m.album ?? null,
      text: artist ? `${artist} – ${title}` : title,
      art: m.art ?? null,
    };
  }

  // --- Programm-Generator -------------------------------------------------

  const bags = {
    songs: createBag([...lib.songs.keys()]),
    general: createBag(lib.general),
    ids: createBag(lib.ids),
    solos: createBag(lib.solos),
    ads: createBag(lib.ads),
    news: createBag(lib.news),
    intros: new Map([...lib.intros].map(([k, v]) => [k, createBag(v)])),
    time: new Map([...lib.time].map(([k, v]) => [k, createBag(v)])),
    to: new Map([...lib.to].map(([k, v]) => [k, createBag(v)])),
  };
  const queue = []; // fest eingeplante nächste Segmente (z.B. Werbeblock)
  const hasAds = lib.ads.length > 0 && bags.to.has('AD');
  const hasNews = lib.news.length > 0 && bags.to.has('NEWS');

  const seg = (type, file, extra = {}) => ({ type, file, duration: dur(file), ...extra });

  // Werbung/Nachrichten per /radio werbung abschaltbar (settings wird von radio.js geteilt)
  const adsOn = () => settings.ads !== false;
  const newsOn = () => settings.news !== false;
  function allowed(s) {
    if (s.type === 'ad' || (s.type === 'to' && s.toKind === 'AD')) return adsOn();
    if (s.type === 'news' || (s.type === 'to' && s.toKind === 'NEWS')) return newsOn();
    return true;
  }

  function songSegment(prevType, { withVoice = true } = {}) {
    const key = bags.songs.pick();
    const file = lib.songs.get(key);
    let voice = null;
    // Direkt nach einem DJ-Solo/Überleitung redet der DJ nicht gleich wieder
    if (withVoice && !['solo', 'to'].includes(prevType)) {
      const r = Math.random();
      const slot = currentTimeSlot();
      const timeBag = slot && bags.time.get(slot);
      const introBag = bags.intros.get(key);
      if (r < INTRO.time && timeBag) voice = { kind: 'time', file: timeBag.pick() };
      else if (r < INTRO.time + INTRO.song && introBag) voice = { kind: 'intro', file: introBag.pick() };
      else if (r < INTRO.time + INTRO.song + INTRO.general && bags.general.size) voice = { kind: 'general', file: bags.general.pick() };
    }
    return seg('song', file, { key, voice });
  }

  function next(prev) {
    // Eingeplantes, das inzwischen abgeschaltet wurde, überspringen
    while (queue.length) {
      const s = queue.shift();
      if (allowed(s)) return s;
    }
    if (prev?.type !== 'song') return songSegment(prev?.type);

    let r = Math.random();
    if (hasAds && adsOn() && (r -= BREAK.ad) < 0) {
      queue.push(seg('ad', bags.ads.pick()));
      if (lib.ads.length > 1 && Math.random() < 0.5) queue.push(seg('ad', bags.ads.pick()));
      if (lib.ids.length && Math.random() < 0.5) queue.push(seg('id', bags.ids.pick()));
      return seg('to', bags.to.get('AD').pick(), { toKind: 'AD' });
    }
    if (hasNews && newsOn() && (r -= BREAK.news) < 0) {
      queue.push(seg('news', bags.news.pick()));
      return seg('to', bags.to.get('NEWS').pick(), { toKind: 'NEWS' });
    }
    if (lib.ids.length && (r -= BREAK.id) < 0) return seg('id', bags.ids.pick());
    if (lib.solos.length && (r -= BREAK.solo) < 0) return seg('solo', bags.solos.pick());
    return songSegment('song');
  }

  // Sender-Zustand, wenn gerade nicht gespielt wird: Segment + Position + Zeitpunkt.
  // Start: irgendwo mitten in einem Song (wie beim Einschalten im Spiel).
  const first = songSegment(null, { withVoice: false });
  let cursor = { seg: first, offset: Math.random() * first.duration * 0.8, at: Date.now() };
  let session = null;
  let lastSong = { seg: first, at: Date.now() };

  /** Sender in der virtuellen Zeit vorspulen (er lief ja "im Hintergrund" weiter). */
  function catchUp() {
    const elapsed = (Date.now() - cursor.at) / 1000;
    if (elapsed > MAX_CATCHUP_SEC) {
      const s = songSegment(null, { withVoice: false });
      cursor = { seg: s, offset: Math.random() * s.duration * 0.8, at: Date.now() };
      return;
    }
    let { seg: s, offset } = cursor;
    offset += elapsed;
    for (let guard = 0; offset >= s.duration && guard < 10_000; guard++) {
      offset -= s.duration;
      s = next(s);
    }
    cursor = { seg: s, offset, at: Date.now() };
  }

  function decoderArgs(s, offset) {
    const out = ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1'];
    const fmt = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}`;
    const base = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

    if (s.type === 'song' && s.voice) {
      // DJ über das Song-Intro legen, Musik per Sidechain ducken
      return [
        ...base, '-i', s.file, '-i', s.voice.file,
        '-filter_complex',
        `[0:a]${stereo(s.file)},${fmt}[m];`
        + `[1:a]${stereo(s.voice.file)},${fmt},adelay=${VOICE_DELAY_MS}:all=1,apad[v];`
        + '[v]asplit=2[sc][vm];'
        + '[m][sc]sidechaincompress=threshold=0.03:ratio=4:attack=40:release=700[d];'
        + '[d][vm]amix=inputs=2:duration=first:normalize=0[out]',
        '-map', '[out]',
        ...(offset > 0 ? ['-ss', offset.toFixed(3)] : []),
        ...out,
      ];
    }
    return [
      ...base,
      ...(offset > 0 ? ['-ss', offset.toFixed(3)] : []),
      '-i', s.file,
      '-af', stereo(s.file),
      ...out,
    ];
  }

  function describe(s) {
    if (!s) return null;
    if (s.type === 'song') return songMeta(s.key);
    return null;
  }

  /** Aktuelles Segment + Position darin, laut tatsächlich abgespielter Zeit im Discord-Player. */
  function currentEntry() {
    if (!session) return { seg: cursor.seg, position: cursor.offset };
    const played = (session.resource?.playbackDuration ?? 0) / 1000;
    let cur = session.entries[0];
    for (const e of session.entries) if (e.streamAt <= played) cur = e;
    if (!cur) return { seg: cursor.seg, position: cursor.offset };
    return { seg: cur.seg, position: Math.max(0, played - cur.streamAt + cur.offset) };
  }

  const currentSegment = () => currentEntry().seg;

  function trackLastSong() {
    const s = currentSegment();
    if (s?.type === 'song' && lastSong.seg !== s) lastSong = { seg: s, at: Date.now() };
    else if (s?.type === 'song') lastSong.at = Date.now();
  }

  /** Wegschalten: Position merken, der Sender läuft virtuell weiter. */
  function closeSession(sess) {
    if (sess.closed) return;
    sess.closed = true;
    if (sess !== session) return killSession(sess);
    session = null;

    const played = (sess.resource?.playbackDuration ?? 0) / 1000;
    let idx = 0;
    sess.entries.forEach((e, k) => { if (e.streamAt <= played) idx = k; });
    const cur = sess.entries[idx];
    if (cur) {
      const offset = Math.max(0, Math.min(cur.seg.duration, played - cur.streamAt + cur.offset));
      cursor = { seg: cur.seg, offset, at: Date.now() };
      // Schon vorbereitete, aber noch nicht gehörte Segmente bleiben eingeplant
      queue.unshift(...sess.entries.slice(idx + 1).map((e) => e.seg));
    }

    killSession(sess);
  }

  function killSession(sess) {
    for (const p of [sess.decoder, sess.encoder]) {
      if (!p) continue;
      p.removeAllListeners();
      p.stdout?.unpipe?.();
      p.kill('SIGKILL');
    }
  }

  log(`"${def.name}": ${lib.songs.size} Songs, ${[...lib.intros.values()].flat().length} Song-Intros, `
    + `${lib.general.length} allgemeine Ansagen, ${[...lib.time.values()].flat().length} Tageszeit-Ansagen, `
    + `${lib.solos.length} DJ-Solos, ${lib.ids.length} IDs`
    + (lib.ads.length ? `, ${lib.ads.length} Werbespots` : '')
    + (lib.news.length ? `, ${lib.news.length} Nachrichten` : ''));

  return {
    id: def.id,
    name: def.name,
    description: def.description || `GTA-V-Radio${def.dj ? ` mit ${def.dj}` : ''}`,
    emoji: def.emoji || '📻',
    type: 'gta',
    dj: def.dj || null,

    async open() {
      if (session) closeSession(session);
      catchUp();

      // Ein durchgehender Encoder, die einzelnen Segmente werden nacheinander als PCM
      // hineingeschrieben -> lückenlose Übergänge ohne neuen Discord-Stream.
      const encoder = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
        ...opusOutputArgs(volume),
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      const sess = { encoder, decoder: null, bytes: 0, entries: [], resource: null, closed: false, failures: 0 };
      session = sess;

      encoder.stdin.on('error', () => { /* EPIPE beim Stoppen */ });
      encoder.stderr.on('data', (d) => log('ffmpeg (encoder):', d.toString().trim()));
      encoder.on('error', (err) => log('ffmpeg konnte nicht gestartet werden:', err.message));
      encoder.on('close', (code) => { if (!sess.closed) log(`Encoder beendet (Code ${code})`); });

      const feed = (s, offset) => {
        if (sess.closed) return;
        sess.entries.push({ seg: s, streamAt: sess.bytes / PCM_BYTES_PER_SEC, offset });
        if (sess.entries.length > 20) sess.entries.splice(0, sess.entries.length - 20);
        if (s.type === 'song') {
          log(`▶ ${songMeta(s.key).text}${s.voice ? ` (+ ${s.voice.kind}: ${path.basename(s.voice.file)})` : ''}`
            + (offset > 1 ? ` ab ${Math.round(offset)}s` : ''));
        } else {
          log(`▶ ${s.type.toUpperCase()}: ${path.basename(s.file)}`);
        }

        const dec = spawn(ffmpegPath, decoderArgs(s, offset), { stdio: ['ignore', 'pipe', 'pipe'] });
        sess.decoder = dec;
        let wrote = 0;
        let errText = '';
        dec.stdout.on('data', (chunk) => { wrote += chunk.length; sess.bytes += chunk.length; });
        dec.stdout.pipe(encoder.stdin, { end: false });
        dec.stderr.on('data', (d) => { errText += d; });
        dec.on('error', (err) => { errText += err.message; });
        dec.on('close', (code) => {
          if (sess.closed) return;
          if (code !== 0 || wrote === 0) {
            log(`Segment fehlgeschlagen (${path.basename(s.file)}): ${errText.trim() || `Code ${code}`}`);
            if (++sess.failures >= MAX_DECODE_FAILURES) {
              log('Zu viele Fehler hintereinander -> Stream beenden');
              encoder.stdin.end();
              return;
            }
          } else {
            sess.failures = 0;
          }
          feed(next(s), 0);
        });
      };

      feed(cursor.seg, cursor.offset);

      return {
        stream: encoder.stdout,
        attach(resource) { sess.resource = resource; },
        stop() { closeSession(sess); },
      };
    },

    close() { if (session) closeSession(session); },

    /** Zum nächsten Segment springen. Danach open() aufrufen, um weiterzuspielen. */
    skip() {
      if (session) closeSession(session);
      const skipped = cursor.seg;
      cursor = { seg: next(skipped), offset: 0, at: Date.now() };
      log(`⏭ übersprungen: ${skipped.type === 'song' ? songMeta(skipped.key).text : path.basename(skipped.file)}`);
      return describe(skipped);
    },

    /** Art des laufenden Segments: song, ad, news, to, id, solo */
    currentType() {
      const s = currentSegment();
      return s.type === 'to' ? `to-${(s.toKind ?? '').toLowerCase()}` : s.type;
    },

    /** Fortschritt im aktuellen Song (für die Progress-Bar), sonst null. */
    progress() {
      const { seg: s, position } = currentEntry();
      if (s?.type !== 'song' || !s.duration) return null;
      return { position: Math.min(position, s.duration), duration: s.duration };
    },

    async nowPlaying() {
      trackLastSong();
      const s = currentSegment();
      if (s?.type === 'song') return describe(s);
      // In Jingles/Moderation: den Song von eben (für /fav direkt nach dem Song)
      if (lastSong && Date.now() - lastSong.at < 3 * 60_000) return describe(lastSong.seg);
      return null;
    },

    async presence() {
      trackLastSong();
      const s = currentSegment();
      if (s?.type === 'song') return `${def.name}: ${songMeta(s.key).text}`;
      if (s?.type === 'solo' || s?.type === 'to') return `${def.name}${def.dj ? ` · 🎙️ ${def.dj}` : ''}`;
      if (s?.type === 'ad') return `${def.name} · Werbung`;
      if (s?.type === 'news') return `${def.name} · Nachrichten`;
      return def.name;
    },
  };
}
