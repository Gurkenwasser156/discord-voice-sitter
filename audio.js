import { spawn } from 'node:child_process';

// Gemeinsame ffmpeg-Helfer für alle Sender-Typen.

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
/** Bytes pro Sekunde für s16le, 48 kHz, Stereo */
export const PCM_BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * 2;

export async function resolveFfmpeg(explicit) {
  if (explicit) return explicit;
  try {
    const mod = await import('ffmpeg-static');
    if (mod.default) return mod.default;
  } catch { /* nicht installiert -> System-ffmpeg */ }
  return 'ffmpeg';
}

/** "0.5", "50%" -> 0.5; leer/ungültig -> fallback */
export function parseVolume(raw, fallback = 0.3) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const str = String(raw).trim();
  const v = str.endsWith('%') ? Number(str.slice(0, -1)) / 100 : Number(str);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Ausgabe-Teil der ffmpeg-Argumente: Ogg/Opus für @discordjs/voice (kein Opus-Encoder in Node nötig). */
export function opusOutputArgs(volume) {
  return [
    ...(volume !== 1 ? ['-af', `volume=${volume}`] : []),
    '-c:a', 'libopus', '-b:a', '128k', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
    '-f', 'ogg', 'pipe:1',
  ];
}

/** Dauer einer Audiodatei in Sekunden (über ffmpeg selbst – ffprobe ist bei ffmpeg-static nicht dabei). */
export function probeDuration(ffmpegPath, file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return reject(new Error(`Keine Dauer für ${file}`));
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}
