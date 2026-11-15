import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamStation, azuracastApiUrl } from './stream.js';
import { createGtaStation } from './gta.js';

// Sender-Liste zusammenstellen:
//   1. RADIO_URL / STREAM_URL aus der .env (das bisherige Internet-Radio)
//   2. alle radios/*.json (im Repo/Image) und RADIOS_DIR/*.json (eigene, optional)
//
// Sender-Definition (radios/<name>.json):
//   { "id": "nonstoppop", "name": "Non-Stop-Pop FM", "type": "gta", "folder": "non-stop-pop", ... }
//   { "id": "j-indies", "name": "J-Indies", "type": "azuracast", "url": "https://host/public/j-indies" }
//   { "id": "x", "name": "X", "type": "stream", "url": "https://host/stream.mp3" }

const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'radios');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleCase = (s) => s.split(/[-_ ]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function readDefs(dir, log) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      try {
        const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        def.id = slug(def.id ?? path.basename(f, '.json'));
        def.fixedName = Boolean(def.name);
        def.name ??= titleCase(def.id);
        return [def];
      } catch (err) {
        log(`radios/${f} kaputt:`, err.message);
        return [];
      }
    });
}

function envDefs(env) {
  if (env.RADIO_URL) {
    const { shortcode } = azuracastApiUrl(env.RADIO_URL);
    return [{
      id: slug(env.RADIO_ID || shortcode),
      name: env.RADIO_NAME || titleCase(shortcode),
      fixedName: Boolean(env.RADIO_NAME),
      type: 'azuracast',
      url: env.RADIO_URL,
      streamUrl: env.STREAM_URL || null,
    }];
  }
  if (env.STREAM_URL) {
    return [{ id: slug(env.RADIO_ID || 'stream'), name: env.RADIO_NAME || 'Radio', type: 'stream', url: env.STREAM_URL }];
  }
  return [];
}

/** Lädt alle Sender. Gibt eine Map id -> Station zurück (Reihenfolge = Anzeige-Reihenfolge). */
export async function loadStations(env, ctx) {
  const { log } = ctx;
  const defs = [...envDefs(env), ...readDefs(BUILTIN_DIR, log)];
  if (env.RADIOS_DIR && path.resolve(env.RADIOS_DIR) !== path.resolve(BUILTIN_DIR)) {
    defs.push(...readDefs(env.RADIOS_DIR, log));
  }

  const stations = new Map();
  for (const def of defs) {
    if (stations.has(def.id)) {
      log(`Sender-ID "${def.id}" doppelt -> zweiter Eintrag ignoriert`);
      continue;
    }
    const slog = (...a) => log(`[${def.id}]`, ...a);
    try {
      let station = null;
      if (def.type === 'gta') {
        station = await createGtaStation(def, { ...ctx, log: slog });
      } else if (def.type === 'azuracast') {
        station = createStreamStation({ ...def, azuracast: def.url, url: def.streamUrl ?? null }, { ...ctx, log: slog });
      } else if (def.type === 'stream') {
        station = createStreamStation(def, { ...ctx, log: slog });
      } else {
        slog(`Unbekannter Typ "${def.type}" (erlaubt: gta, azuracast, stream)`);
      }
      await station?.init?.();
      if (station) stations.set(station.id, station);
    } catch (err) {
      slog('Sender konnte nicht geladen werden:', err.message);
    }
  }
  return stations;
}
