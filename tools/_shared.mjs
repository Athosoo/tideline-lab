// Shared helpers for the Cloud Lab verification bench.
// No third-party Node dependencies: uses Node >= 22 built-in fetch + WebSocket,
// and the system Python + Pillow only for image analysis / contact sheets.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LAB_ROOT = path.resolve(TOOLS_DIR, '..');
export const WORKSPACE_ROOT = path.resolve(LAB_ROOT, '..');
export const SHOTS_ROOT = path.join(LAB_ROOT, 'cloud', 'shots');
export const CLOUD_INDEX = path.join(LAB_ROOT, 'cloud', 'index.html');
export const GIFT_INDEX = path.join(WORKSPACE_ROOT, 'GIFT', 'index.html');
export const LAB_PRESETS = new Set(['cumulus', 'stratus', 'storm']);
export const LAB_P_KEYS = new Set([
  'coverage', 'type', 'density', 'detail', 'base', 'top', 'wind', 'sunEl', 'sunAz',
  'haze', 'steps', 'light', 'scale', 'msContrib', 'msOccl', 'powder', 'budgetMs',
  'seedX', 'seedZ', 'aerial', 'reflect', 'accumulate', 'auto', 'paused', 'debug',
  'maxDist',
]);
export const LAB_QUERY_KEYS = new Set([
  'coverage', 'type', 'density', 'detail', 'base', 'top', 'wind', 'sunEl', 'sunAz',
  'haze', 'steps', 'light', 'scale', 'msContrib', 'msOccl', 'powder', 'budgetMs',
  'seedX', 'seedZ', 'maxdist', 'aerial', 'reflect', 'accum', 'auto', 'debug',
  'pitch', 'yaw', 'fov', 'camX', 'camY', 'camZ',
]);

const ACTIVE_CHILDREN = new Set();
let SIGNAL_HOOKS_INSTALLED = false;

export const NL = String.fromCharCode(10);
export const CR = String.fromCharCode(13);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomId() {
  return Math.random().toString(36).slice(2, 9) + String(Date.now()).slice(-5);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value, pretty = true) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, pretty ? 2 : 0) + NL, 'utf8');
}

export function isPng(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return buf.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } catch {
    return false;
  }
}

export function pctToNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let i = 0;
  let sign = 1;
  if (s[i] === '-') { sign = -1; i += 1; }
  else if (s[i] === '+') { i += 1; }
  let digits = '';
  let dot = false;
  for (; i < s.length; i += 1) {
    const ch = s[i];
    if (ch >= '0' && ch <= '9') digits += ch;
    else if (ch === '.' && !dot) { dot = true; digits += '.'; }
    else break;
  }
  if (!digits || digits === '.') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? sign * n : null;
}

export function safeFileStem(name, fallback = 'case') {
  const s = String(name === undefined || name === null ? '' : name).trim();
  let out = '';
  const allowed = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-');
  for (const ch of s) out += allowed.has(ch) ? ch : '_';
  out = out.replaceAll('..', '_');
  return out || fallback;
}

export function uniqueName(base, used) {
  let name = base;
  let n = 2;
  while (used.has(name)) { name = base + '-' + n; n += 1; }
  used.add(name);
  return name;
}

export function parseKvList(input) {
  const out = {};
  const text = String(input === undefined || input === null ? '' : input);
  for (const piece of text.split(',')) {
    const s = piece.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq < 0) throw new Error('expected key=value, got: ' + s);
    const key = s.slice(0, eq).trim();
    if (!key) throw new Error('empty key in: ' + s);
    let value = s.slice(eq + 1).trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value !== '' && Number.isFinite(Number(value))) value = Number(value);
    out[key] = value;
  }
  return out;
}

export function mergeKvArgs(values) {
  const out = {};
  const list = Array.isArray(values) ? values : (values === undefined ? [] : [values]);
  for (const v of list) Object.assign(out, parseKvList(v));
  return out;
}

export function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq >= 0) { addArg(out, arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) addArg(out, key, true);
    else { addArg(out, key, next); i += 1; }
  }
  return out;
}

function addArg(out, key, value) {
  if (out[key] === undefined) out[key] = value;
  else if (Array.isArray(out[key])) out[key].push(value);
  else out[key] = [out[key], value];
}

export function argList(value) {
  if (value === undefined || value === null || value === true) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of arr) {
    if (v === true) continue;
    for (const s of String(v).split(',')) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function boolArg(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  const s = String(value).trim().toLowerCase();
  if (s === '' || s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

export function numArg(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function fmtDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return Math.round(n) + 'ms';
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 's';
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return m + 'm' + s + 's';
}

export function hoursToLabel(hours) {
  let h = Math.floor(hours);
  let m = Math.round((hours - h) * 60);
  if (m >= 60) { h += 1; m -= 60; }
  h = ((h % 24) + 24) % 24;
  return String(h).padStart(2, '0') + String(m).padStart(2, '0');
}

export function parseTimeSpec(spec) {
  const s = String(spec === undefined || spec === null ? '' : spec).trim();
  if (!s) throw new Error('empty time spec');
  const low = s.toLowerCase();
  if (low === 'now' || low === 'current' || low === 'auto') {
    return { kind: 'now', hours: null, label: 'now', raw: s };
  }
  let hours = null;
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length < 2 || parts.length > 3) throw new Error('bad time: ' + s);
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const sec = parts.length === 3 ? Number(parts[2]) : 0;
    if (![h, m, sec].every(Number.isFinite)) throw new Error('bad time: ' + s);
    if (h < 0 || h > 23 || m < 0 || m > 59 || sec < 0 || sec > 59) throw new Error('bad time: ' + s);
    hours = h + m / 60 + sec / 3600;
  } else if (s.length === 4 && s[0] >= '0' && s[0] <= '9') {
    const h = Number(s.slice(0, 2));
    const m = Number(s.slice(2, 4));
    if (h > 23 || m > 59) throw new Error('bad time: ' + s);
    hours = h + m / 60;
  } else if (Number.isFinite(Number(s))) {
    const n = Number(s);
    if (n < 0 || n > 24) throw new Error('bad time: ' + s);
    hours = n;
  } else {
    throw new Error('bad time: ' + s);
  }
  return { kind: 'fixed', hours, label: hoursToLabel(hours), raw: s };
}

export function buildLabUrl(preset, params = {}) {
  const u = pathToFileURL(CLOUD_INDEX);
  const q = new URLSearchParams();
  if (preset) q.set('preset', String(preset));
  for (const [key, value] of Object.entries(params)) {
    if (key === 'preset') continue;
    if (value === undefined || value === null) continue;
    q.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const qs = q.toString();
  if (qs) u.search = qs;
  return u.href;
}

export function normalizeLabParams(params) {
  const query = {};
  const patch = {};
  const cam = {};
  const unknown = [];
  for (const [key, value] of Object.entries(params)) {
    if (key === 'preset') continue;
    if (key.startsWith('cam.')) { cam[key.slice(4)] = value; continue; }
    if (key === 'yaw' || key === 'pitch') { cam[key] = value; query[key] = value; continue; }
    if (key === 'fov') {
      cam.fov = Number(value) * Math.PI / 180;
      query.fov = value;
      continue;
    }
    if (key === 'camX' || key === 'camY' || key === 'camZ') {
      cam['pos' + key.slice(3)] = value;
      query[key] = value;
      continue;
    }
    if (key === 'maxDist' || key === 'maxdist') { patch.maxDist = value; query.maxdist = value; continue; }
    if (key === 'accumulate' || key === 'accum') {
      const on = value === true || value === 1 || value === '1' || value === 'true';
      patch.accumulate = on;
      query.accum = on ? 1 : 0;
      continue;
    }
    if (LAB_P_KEYS.has(key)) {
      patch[key] = value;
      if (LAB_QUERY_KEYS.has(key)) query[key] = value;
      else unknown.push(key);
      continue;
    }
    if (LAB_QUERY_KEYS.has(key)) { query[key] = value; unknown.push(key); continue; }
    unknown.push(key);
  }
  return { query, patch, cam, unknown };
}

// ---------------------------------------------------------------------------
// Chrome process helpers

export function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  candidates.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
  candidates.push('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  if (process.env.LOCALAPPDATA) candidates.push(process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe');
  candidates.push('C:/Program Files/Microsoft/Edge/Application/msedge.exe');
  candidates.push('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return path.resolve(c);
  }
  return null;
}

export function chromeFlags({ width = 1280, height = 800, profileDir, remote = false, extra = [] } = {}) {
  const flags = [
    '--headless=new',
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--force-device-scale-factor=1',
    '--window-size=' + width + ',' + height,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--mute-audio',
    '--no-pings',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
  ];
  if (remote) {
    flags.push('--remote-debugging-port=0');
    flags.push('--remote-debugging-address=127.0.0.1');
    flags.push('--remote-allow-origins=*');
  }
  if (profileDir) flags.push('--user-data-dir=' + profileDir);
  for (const f of extra) flags.push(f);
  return flags;
}

export function installSignalHooks() {
  if (SIGNAL_HOOKS_INSTALLED) return;
  SIGNAL_HOOKS_INSTALLED = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      killAllChildren();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
  process.on('exit', () => killAllChildren());
}

export function trackChild(child) {
  ACTIVE_CHILDREN.add(child);
  child.once('exit', () => ACTIVE_CHILDREN.delete(child));
}

export function killAllChildren() {
  for (const child of ACTIVE_CHILDREN) {
    try { killTree(child); } catch { /* no-op */ }
  }
  ACTIVE_CHILDREN.clear();
}

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 15000,
      });
      return;
    } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* no-op */ }
}

export async function launchChrome(chromePath, args, { cwd = WORKSPACE_ROOT } = {}) {
  const child = spawn(chromePath, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 30000) stderr = stderr.slice(-30000);
  });
  child.on('error', (err) => {
    stderr += NL + 'spawn error: ' + err.message;
  });
  await new Promise((resolve, reject) => {
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(new Error('failed to launch Chrome: ' + err.message)); };
    const cleanup = () => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  trackChild(child);
  return { child, getStderr: () => stderr };
}

export async function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code, signal, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    };
    const timer = setTimeout(() => {
      killTree(child);
      setTimeout(() => finish(null, 'SIGKILL', true), 500);
    }, Math.max(1000, timeoutMs));
    child.once('exit', (code, signal) => finish(code, signal, false));
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(child.exitCode, child.signalCode, false);
    }
  });
}

export async function waitForDevTools(profileDir, { timeoutMs = 30000, getStderr = () => '' } = {}) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(NL).map((s) => s.split(CR).join('')).filter(Boolean);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0) return { port, wsPath: lines[1] || '', file };
    }
    await sleep(120);
  }
  throw new Error('Chrome DevTools port was not ready at ' + file + '; stderr=' + tailString(getStderr(), 1500));
}

export async function waitForPageTarget(port, { timeoutMs = 20000 } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list', {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const list = await res.json();
        const pages = list.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
        if (pages.length) {
          const blank = pages.find((t) => t.url === 'about:blank');
          return blank || pages[pages.length - 1];
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error('no page target exposed by Chrome' + (lastErr ? ': ' + lastErr.message : ''));
}

export async function cleanupProfile(profileDir, { keep = false } = {}) {
  if (!profileDir || keep) return { removed: false, kept: true };
  await sleep(250);
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    return { removed: !fs.existsSync(profileDir) };
  } catch (err) {
    return { removed: false, error: err.message };
  }
}

export function makeProfileDir(outDir, name) {
  const dir = path.join(outDir, '.profiles', safeFileStem(name, 'chrome') + '-' + process.pid + '-' + randomId());
  ensureDir(dir);
  return dir;
}

export function tailString(text, n = 4000) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s.length <= n) return s;
  return s.slice(-n);
}

// ---------------------------------------------------------------------------
// Minimal CDP client over the Node built-in WebSocket (Node 22+).

export class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect(timeoutMs = 15000) {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error('CDP WebSocket connect timeout')), timeoutMs);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* no-op */ }
        reject(err);
      };
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => fail(new Error('CDP WebSocket error: ' + this.url)), { once: true });
    });
    ws.addEventListener('message', (event) => this.handleMessage(event));
    ws.addEventListener('close', () => this.handleClose());
    ws.addEventListener('error', () => { /* pending calls will time out */ });
    return this;
  }

  handleMessage(event) {
    const data = event && event.data;
    if (typeof data === 'string') { this.handleText(data); return; }
    if (data instanceof ArrayBuffer) { this.handleText(Buffer.from(data).toString('utf8')); return; }
    if (ArrayBuffer.isView(data)) {
      this.handleText(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
      return;
    }
    if (data && typeof data.text === 'function') {
      data.text().then((text) => this.handleText(text)).catch(() => { /* no-op */ });
    }
  }

  handleText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error('CDP ' + msg.error.code + ': ' + msg.error.message));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const cb of [...set]) {
        try { cb(msg.params); } catch { /* no-op */ }
      }
    }
  }

  handleClose() {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(cb);
    return () => {
      const set = this.listeners.get(method);
      if (set) set.delete(cb);
    };
  }

  waitEvent(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('CDP event timeout: ' + method)); }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
    if (!this.ws || this.ws.readyState !== 1 || this.closed) {
      return Promise.reject(new Error('CDP not connected (readyState=' + (this.ws ? this.ws.readyState : 'none') + ')'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('CDP send failed: ' + err.message));
      }
    });
  }

  close() {
    this.closed = true;
    try { if (this.ws) this.ws.close(); } catch { /* no-op */ }
  }
}

export async function cdpEval(cdp, expression, { timeoutMs = 60000 } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    includeCommandLineAPI: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails.exception;
    const detail = ex && ex.description ? ex.description : (result.exceptionDetails.text || 'unknown exception');
    throw new Error('Runtime.evaluate failed: ' + detail);
  }
  const remote = result.result || {};
  if (remote.unserializableValue !== undefined) return remote.unserializableValue;
  return remote.value;
}

export async function waitForCondition(cdp, expression, predicate, {
  timeoutMs = 30000,
  intervalMs = 250,
  label = 'condition',
} = {}) {
  const start = Date.now();
  let last = null;
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await cdpEval(cdp, expression);
      lastError = null;
      if (predicate(last)) return { value: last, elapsedMs: Date.now() - start };
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const detail = lastError ? lastError.message : JSON.stringify(last);
  throw new Error(label + ' timed out after ' + timeoutMs + 'ms; last=' + tailString(detail, 2000));
}

export async function waitFrames(cdp, count = 3, timeoutMs = 30000) {
  const n = Math.max(1, Math.floor(count));
  const expr = 'new Promise(function(resolve){ let n = 0; function tick(){ n += 1; if (n >= ' + n + ') resolve(n); else requestAnimationFrame(tick); } requestAnimationFrame(tick); })';
  return cdpEval(cdp, expr, { timeoutMs });
}

export async function setViewport(cdp, width, height, dpr = 1) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.max(2, Math.floor(width)),
    height: Math.max(2, Math.floor(height)),
    deviceScaleFactor: dpr,
    mobile: false,
    screenWidth: Math.max(2, Math.floor(width)),
    screenHeight: Math.max(2, Math.floor(height)),
  });
}

export async function captureScreenshot(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  }, 90000);
  if (!result || !result.data) throw new Error('Page.captureScreenshot returned no data');
  const buf = Buffer.from(result.data, 'base64');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, png: isPng(file) };
}

export async function navigate(cdp, url, timeoutMs = 60000) {
  const result = await cdp.send('Page.navigate', { url }, timeoutMs);
  if (result && result.errorText) throw new Error('Page.navigate failed: ' + result.errorText);
  return result;
}

export async function shutdownChrome({ cdp, child, profileDir, keepProfile = false } = {}) {
  if (cdp) { try { cdp.close(); } catch { /* no-op */ } }
  if (child) {
    killTree(child);
    await waitForExit(child, 8000).catch(() => null);
  }
  return cleanupProfile(profileDir, { keep: keepProfile });
}

// ---------------------------------------------------------------------------
// Python / Pillow helpers (no third-party Node modules)

const ANALYZE_CODE = `
import sys, json
from PIL import Image, ImageStat

with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    manifest = json.load(fh)

min_stddev = float(manifest.get('minStddev', 2.0))
out = []
cache = {}

for entry in manifest.get('entries', []):
    eid = entry.get('id')
    p = entry.get('path')
    try:
        im = cache.get(p)
        if im is None:
            im = Image.open(p)
            im.load()
            im = im.convert('RGB')
            cache[p] = im
        rect = entry.get('rect')
        crop = None
        if rect:
            vp = entry.get('viewport') or {}
            vpw = float(vp.get('width') or im.width)
            vph = float(vp.get('height') or im.height)
            sx = im.width / vpw
            sy = im.height / vph
            x = int(round(float(rect.get('x', 0)) * sx))
            y = int(round(float(rect.get('y', 0)) * sy))
            w = int(round(float(rect.get('width', 0)) * sx))
            h = int(round(float(rect.get('height', 0)) * sy))
            x0 = max(0, min(im.width, x))
            y0 = max(0, min(im.height, y))
            x1 = max(0, min(im.width, x + w))
            y1 = max(0, min(im.height, y + h))
            if x1 <= x0 or y1 <= y0:
                raise ValueError('empty crop rect: ' + repr(rect))
            region = im.crop((x0, y0, x1, y1))
            crop = {'x': x0, 'y': y0, 'width': x1 - x0, 'height': y1 - y0}
        else:
            region = im
        stat = ImageStat.Stat(region)
        luma = region.convert('L')
        lstat = ImageStat.Stat(luma)
        hist = luma.histogram()
        total = max(1, luma.width * luma.height)
        black = sum(hist[:8]) / total
        white = sum(hist[248:]) / total
        lmin, lmax = luma.getextrema()
        mean_luma = lstat.mean[0]
        sd = lstat.stddev[0]
        out.append({
            'id': eid,
            'ok': True,
            'path': p,
            'width': im.width,
            'height': im.height,
            'crop': crop,
            'meanRgb': stat.mean,
            'stddevRgb': stat.stddev,
            'meanLuma': mean_luma,
            'stddevLuma': sd,
            'varianceLuma': sd * sd,
            'lumaMin': lmin,
            'lumaMax': lmax,
            'blackRatio': black,
            'whiteRatio': white,
            'allBlack': lmax <= 1,
            'allWhite': lmin >= 254,
            'flat': sd < min_stddev,
            'qualityOk': (lmax > 1 and lmin < 254 and sd >= min_stddev),
        })
    except Exception as exc:
        out.append({'id': eid, 'ok': False, 'path': p, 'error': str(exc)})

print(json.dumps({'ok': True, 'entries': out}))
`;

const SHEET_CODE = `
import sys, json, os
from PIL import Image, ImageDraw, ImageFont

with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    manifest = json.load(fh)

images = manifest.get('images', [])
if not images:
    print(json.dumps({'ok': False, 'reason': 'no images'}))
    sys.exit(0)

thumb_w = int(manifest.get('thumbWidth', 600))
thumb_h = int(manifest.get('thumbHeight', 375))
pad = int(manifest.get('padding', 12))
header = int(manifest.get('headerHeight', 42))
title_h = int(manifest.get('titleHeight', 56))
cols = max(1, min(int(manifest.get('columns', 2)), len(images)))
rows = (len(images) + cols - 1) // cols

def load_font(size, bold=False):
    paths = []
    if bold:
        paths.extend(['C:/Windows/Fonts/consolab.ttf', 'C:/Windows/Fonts/arialbd.ttf'])
    paths.extend(['C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/arial.ttf'])
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

font_title = load_font(20, True)
font_sub = load_font(13)
font_label = load_font(15, True)
font_meta = load_font(12)

W = pad + cols * (thumb_w + pad)
H = title_h + pad + rows * (header + thumb_h + pad)
canvas = Image.new('RGB', (W, H), (11, 14, 18))
draw = ImageDraw.Draw(canvas)
draw.text((pad, 16), str(manifest.get('title', 'CLOUD LAB')), fill=(232, 237, 243), font=font_title)
draw.text((pad + 270, 22), str(manifest.get('subtitle', '')), fill=(139, 152, 168), font=font_sub)

for i, item in enumerate(images):
    col = i % cols
    row = i // cols
    x = pad + col * (thumb_w + pad)
    y = title_h + pad + row * (header + thumb_h + pad)
    draw.rectangle([x, y, x + thumb_w, y + header + thumb_h], fill=(20, 27, 35))
    label = str(item.get('label', ''))
    if len(label) > 60:
        label = label[:57] + '...'
    draw.text((x + 10, y + 7), label, fill=(232, 237, 243), font=font_label)
    sub = str(item.get('sub', ''))
    if sub:
        box = draw.textbbox((0, 0), sub, font=font_meta)
        tw = box[2] - box[0]
        draw.text((x + thumb_w - 10 - tw, y + 9), sub, fill=(139, 152, 168), font=font_meta)
    try:
        im = Image.open(item['path']).convert('RGB')
        im.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        ix = x + (thumb_w - im.width) // 2
        iy = y + header + (thumb_h - im.height) // 2
        canvas.paste(im, (ix, iy))
    except Exception as exc:
        draw.text((x + 10, y + header + 10), 'missing: ' + str(exc), fill=(255, 120, 120), font=font_meta)

out = manifest.get('output') or 'sheet.png'
canvas.save(out, 'PNG', optimize=True)
print(json.dumps({'ok': True, 'path': out, 'width': W, 'height': H, 'count': len(images)}))
`;

let PYTHON_CACHE = null;
let PYTHON_PROBED = false;

export function findPython() {
  if (PYTHON_PROBED) return PYTHON_CACHE;
  PYTHON_PROBED = true;
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ cmd: process.env.PYTHON, args: [] });
  candidates.push({ cmd: 'python', args: [] });
  candidates.push({ cmd: 'py', args: ['-3'] });
  candidates.push({ cmd: 'python3', args: [] });
  const bundled = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
  if (fs.existsSync(bundled)) candidates.push({ cmd: bundled, args: [] });
  for (const candidate of candidates) {
    try {
      const res = spawnSync(candidate.cmd, [...candidate.args, '-c', 'import PIL, sys; print(PIL.__version__)'], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
      if (res.status === 0) {
        PYTHON_CACHE = { ...candidate, pilVersion: String(res.stdout || '').trim() };
        return PYTHON_CACHE;
      }
    } catch { /* try next */ }
  }
  PYTHON_CACHE = null;
  return null;
}

function parsePythonJson(stdout) {
  const text = String(stdout || '').trim();
  try { return JSON.parse(text); } catch { /* find a JSON line */ }
  const lines = text.split(NL);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* continue */ }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* no-op */ }
  }
  return null;
}

export function runPillow(kind, manifest, outDir) {
  const python = findPython();
  if (!python) {
    return { ok: false, reason: 'Python + Pillow not available (checked PYTHON, python, py -3, python3)' };
  }
  ensureDir(outDir);
  const manifestPath = path.join(outDir, '.pillow-' + kind + '-' + process.pid + '-' + randomId() + '.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  try {
    const code = kind === 'sheet' ? SHEET_CODE : ANALYZE_CODE;
    const res = spawnSync(python.cmd, [...python.args, '-c', code, manifestPath], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.status !== 0) {
      return {
        ok: false,
        reason: 'Pillow ' + kind + ' failed (exit ' + res.status + ')',
        stderr: tailString(res.stderr, 3000),
        stdout: tailString(res.stdout, 1000),
        python: { cmd: python.cmd, args: python.args, pilVersion: python.pilVersion },
      };
    }
    const data = parsePythonJson(res.stdout);
    if (!data) {
      return {
        ok: false,
        reason: 'Pillow ' + kind + ' returned unparseable output',
        stdout: tailString(res.stdout, 2000),
        stderr: tailString(res.stderr, 2000),
      };
    }
    return { ok: true, data, python: { cmd: python.cmd, args: python.args, pilVersion: python.pilVersion } };
  } finally {
    try { fs.rmSync(manifestPath, { force: true }); } catch { /* no-op */ }
  }
}

export function analyzeImages(entries, outDir, { minStddev = 2.0 } = {}) {
  return runPillow('analyze', { minStddev, entries }, outDir);
}

export function buildContactSheet({ images, output, title, subtitle, outDir, columns = 2, thumbWidth = 600, thumbHeight = 375 }) {
  return runPillow('sheet', {
    output, title, subtitle, images, columns, thumbWidth, thumbHeight,
    padding: 12, headerHeight: 42, titleHeight: 56,
  }, outDir);
}

export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const pos = (xs.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  let total = 0;
  for (const v of xs) total += v;
  return total / xs.length;
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

export function summarizePerf(series, meta = {}) {
  const valid = series.filter((s) => s && s.stats && Number.isFinite(s.stats.ms));
  const warm = valid.length >= 8 ? Math.floor(valid.length * 0.2) : 0;
  const steady = valid.slice(warm);
  const msValues = steady.map((s) => s.stats.ms);
  const last = valid.length ? valid[valid.length - 1] : null;
  const p50 = percentile(msValues, 0.5);
  const p95 = percentile(msValues, 0.95);
  const avg = mean(msValues);
  const mins = msValues.length ? Math.min(...msValues) : null;
  const maxs = msValues.length ? Math.max(...msValues) : null;
  const noise = valid.find((s) => s.stats && Number.isFinite(s.stats.noiseMs));
  return {
    ms: round(p50, 2),
    steps: last && last.stats ? last.stats.steps : (meta.steps === undefined ? null : meta.steps),
    w: last && last.stats ? last.stats.w : (meta.w === undefined ? null : meta.w),
    h: last && last.stats ? last.stats.h : (meta.h === undefined ? null : meta.h),
    scale: last && last.scale !== undefined ? last.scale : (meta.scale === undefined ? null : meta.scale),
    msLast: last && last.stats ? round(last.stats.ms, 2) : null,
    msP50: round(p50, 2),
    msP95: round(p95, 2),
    msMean: round(avg, 2),
    msMin: round(mins, 2),
    msMax: round(maxs, 2),
    fpsP50: p50 ? round(1000 / p50, 2) : null,
    sampleCount: valid.length,
    steadySampleCount: steady.length,
    warmupDropped: warm,
    noiseMs: noise && noise.stats ? noise.stats.noiseMs : null,
    innerWidth: last ? last.innerWidth : null,
    innerHeight: last ? last.innerHeight : null,
    visibilityState: last ? last.visibilityState : null,
    cloudW: last && last.stats ? last.stats.cloudW : null,
    cloudH: last && last.stats ? last.stats.cloudH : null,
    accum: last && last.stats ? last.stats.accum : null,
    hdr: last && last.stats ? last.stats.hdr : null,
    type: last && last.stats ? last.stats.type : null,
    worleyMs: last && last.stats ? last.stats.worleyMs : null,
    note: 'SwiftShader software rasterizer; frame times are not representative of a real GPU.',
    series: valid.map((s) => ({
      t: s.wallT,
      now: round(s.pageNow, 1),
      ms: round(s.stats.ms, 2),
      w: s.stats.w,
      h: s.stats.h,
    })),
  };
}
