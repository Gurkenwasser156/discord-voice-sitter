#!/usr/bin/env node
// Wandelt einen GTA-Audio-Dump (WAV) in Opus um – gleiche Ordnerstruktur, ~10x kleiner.
//
//   node scripts/convert-audio.mjs "<dump-ordner>" audio/non-stop-pop [bitrate]
//
// Bitrate Standard 160k (Songs/Jingles). Moderation (mono) bekommt automatisch die Hälfte.
// Bereits umgewandelte Dateien werden übersprungen, Abbrechen + Neustarten ist also ok.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const [src, dst, bitrate = '160k'] = process.argv.slice(2);
if (!src || !dst) {
  console.error('Aufruf: node scripts/convert-audio.mjs <dump-ordner> <ziel-ordner> [bitrate]');
  process.exit(1);
}
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const AUDIO = /\.(wav|mp3|flac|ogg|opus|m4a|aac)$/i;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return AUDIO.test(e.name) ? [p] : [];
  });
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.trim() || `Code ${code}`))));
  });
}

const files = walk(path.resolve(src));
const kbps = parseInt(bitrate, 10);
let i = 0;
let done = 0;
let failed = 0;

async function worker() {
  while (i < files.length) {
    const file = files[i++];
    const rel = path.relative(path.resolve(src), file);
    const out = path.join(path.resolve(dst), rel).replace(AUDIO, '.opus');
    if (fs.existsSync(out) && fs.statSync(out).size > 0) { done++; continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    try {
      const info = await run(['-hide_banner', '-i', file]).catch((e) => e.message);
      const mono = /Audio:.*\bmono\b/.test(info);
      const rate = mono ? `${Math.round(kbps / 2)}k` : bitrate;
      await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn',
        '-c:a', 'libopus', '-b:a', rate, '-ar', '48000', `${out}.tmp.opus`]);
      fs.renameSync(`${out}.tmp.opus`, out);
      done++;
      process.stdout.write(`\r${done}/${files.length} ${rel.padEnd(60).slice(0, 60)}`);
    } catch (err) {
      failed++;
      console.error(`\n${rel}: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, os.cpus().length - 1) }, worker));
console.log(`\nFertig: ${done} Dateien${failed ? `, ${failed} fehlgeschlagen` : ''} -> ${path.resolve(dst)}`);
