'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Cross-platform on-device transcription via whisper.cpp (the `whisper-cli`
// binary). This is the HOST's addition — NOT vendored from router-daybook — so
// the vendor sync never clobbers it. It backs voice on Windows / Linux / Intel
// macs (and anywhere via ROUTER_WHISPER=cpp), where the MLX-Whisper sidecar
// (daybook/whisper_server.py) can't run.
//
// Self-contained when packaged: a per-platform `whisper-cli` + a GGUF model are
// shipped under Contents/Resources/whisper/ (electron-builder extraResources;
// see package.json + scripts/fetch-whisper-cpp.sh). In dev it falls back to a
// PATH / Homebrew binary (`brew install whisper-cpp`) and a model resolved from
// build-resources/ or ~/.cache/whisper/.
//
// On-device: audio stays local; only the transcribed TEXT is returned.
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function exists(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }
function firstExisting(cands) { for (const c of cands) if (exists(c)) return c; return null; }

// Per-platform packaged resources dir (Contents/Resources/whisper in a build).
function resourcesWhisperDir() {
  return process.resourcesPath ? path.join(process.resourcesPath, 'whisper') : null;
}

// The whisper-cli binary: env override → bundled → dev PATH/Homebrew → bare name.
function resolveCli() {
  if (process.env.ROUTER_WHISPER_CLI) return process.env.ROUTER_WHISPER_CLI;
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const res = resourcesWhisperDir();
  return firstExisting([
    res && path.join(res, exe),
    '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli',
  ]) || exe; // bare name → resolved on PATH at spawn time
}

// The GGUF model file: env override → bundled → Homebrew share → ~/.cache.
function resolveModel() {
  if (process.env.ROUTER_WHISPER_MODEL) return process.env.ROUTER_WHISPER_MODEL;
  const res = resourcesWhisperDir();
  const buildRes = path.join(__dirname, 'build-resources', 'whisper'); // dev (unpacked) location
  const names = ['ggml-base.en.bin', 'ggml-small.en.bin', 'ggml-tiny.en.bin'];
  const cands = [];
  for (const dir of [res, buildRes, '/opt/homebrew/share/whisper-cpp', path.join(os.homedir(), '.cache', 'whisper')]) {
    if (!dir) continue;
    for (const n of names) cands.push(path.join(dir, n));
  }
  return firstExisting(cands);
}

// whisper.cpp can run as long as we can resolve a model; the cli itself may be
// on PATH (resolveCli falls back to a bare name). We gate on the model because
// that's the piece that must physically exist.
function available() { return !!resolveModel(); }

// Transcribe a 16kHz mono WAV → text. Returns '' on any failure (so the caller
// falls back to type-only). The cli prints the transcript to stdout with -nt
// (no timestamps) -np (no progress prints).
function transcribeWav(wavPath, { timeoutMs = 60000 } = {}) {
  const cli = resolveCli();
  const model = resolveModel();
  if (!model) return Promise.resolve(''); // no model shipped/installed here
  return new Promise((resolve) => {
    const args = ['-m', model, '-f', wavPath, '-nt', '-np', '-l', 'en'];
    let child;
    try { child = spawn(cli, args, { env: { ...process.env } }); }
    catch { return resolve(''); }
    let out = '', done = false;
    const finish = (t) => {
      if (done) return; done = true;
      // strip whisper.cpp's non-speech markers + collapse whitespace
      const text = String(t || '')
        .replace(/\[(?:BLANK_AUDIO|MUSIC|SOUND|NOISE|INAUDIBLE)\]/gi, '')
        .replace(/\s+/g, ' ').trim();
      resolve(text);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish(''); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

module.exports = { transcribeWav, available, resolveCli, resolveModel };
