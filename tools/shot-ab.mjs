#!/usr/bin/env node
/* shot-ab.mjs — 固定随机种子 / reduced-motion / 固定天气状态下的站点截图，
   用来做「改前 vs 改后」的像素级对比。
 *
 * 用法：
 *   node _lab/tools/shot-ab.mjs --url "file:///E:/DeepSeekplay/GIFT/index.html?seed=7&nogl=1" \
 *        --out E:/DeepSeekplay/_lab/shots/perf/a.png --steps _lab/shots/perf/steps-ab.json \
 *        --viewport 1280x800 --reduced-motion
 *
 * 输出一行 JSON：{ok,out,bodyClass,sunX,sunY,errors}
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  findChrome, chromeFlags, makeProfileDir, launchChrome, waitForDevTools,
  waitForPageTarget, CDP, cdpEval, waitForCondition, setViewport, navigate,
  captureScreenshot, shutdownChrome, ensureDir, installSignalHooks, sleep,
  parseArgv, boolArg, numArg,
} from './_shared.mjs';

installSignalHooks();

const args = parseArgv(process.argv.slice(2));
if (args.help) {
  process.stdout.write('usage: node shot-ab.mjs --url URL --out PNG [--steps FILE] [--viewport WxH] [--reduced-motion]\n');
  process.exit(0);
}
const url = String(args.url || '');
const out = String(args.out || '');
if (!url || !out) { process.stderr.write('shot-ab: --url and --out are required\n'); process.exit(1); }
const vp = String(args.viewport || '1280x800').split(/[xX,]/).map(Number);
const viewport = { width: vp[0] || 1280, height: vp[1] || 800 };
const reduced = boolArg(args['reduced-motion'], false);
const settle = Math.max(0, numArg(args.settle, 600));
const stepsArg = args.steps ? String(args.steps) : '';
const steps = stepsArg
  ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), stepsArg), 'utf8'))
  : [];

const chromePath = findChrome();
if (!chromePath) { process.stderr.write('shot-ab: Chrome not found\n'); process.exit(1); }
const profileDir = makeProfileDir(path.join(path.dirname(out), '.profiles'), 'shot');
const { child, getStderr } = await launchChrome(chromePath, chromeFlags({
  width: viewport.width, height: viewport.height, profileDir, remote: true,
}));
let cdp = null;
const errors = [];
try {
  const { port } = await waitForDevTools(profileDir, { timeoutMs: 30000, getStderr });
  const target = await waitForPageTarget(port, { timeoutMs: 20000 });
  cdp = await new CDP(target.webSocketDebuggerUrl).connect(15000);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails && p.exceptionDetails.text)));
  cdp.on('Log.entryAdded', (p) => { if (p.entry && p.entry.level === 'error') errors.push(String(p.entry.text).slice(0, 300)); });
  await setViewport(cdp, viewport.width, viewport.height, 1);
  if (reduced) {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }
  await navigate(cdp, url, 90000);
  await waitForCondition(cdp, 'document.readyState === "complete" && !!(window.Weather && window.Weather.state)', (v) => v === true, {
    timeoutMs: 90000, intervalMs: 250, label: 'site ready',
  });
  for (const step of steps) {
    if (step.expr) {
      const res = await cdpEval(cdp, step.expr).catch((err) => { errors.push(err.message); return null; });
      if (res !== null && res !== undefined && typeof res !== 'object') { /* keep quiet */ }
    }
    await sleep(step.wait || 1000);
  }
  await sleep(settle);
  ensureDir(path.dirname(out));
  const shot = await captureScreenshot(cdp, out);
  const state = await cdpEval(cdp, `(function(){
    var cs = getComputedStyle(document.documentElement);
    var at = document.querySelector('.atmosphere');
    var g = document.getElementById('gallery');
    var wb = document.getElementById('weatherBar');
    var f = document.getElementById('focus');
    var pick = function (el) { return el ? {
      sunX: getComputedStyle(el).getPropertyValue('--sun-x').trim(),
      sunY: getComputedStyle(el).getPropertyValue('--sun-y').trim(),
      sunGlow: getComputedStyle(el).getPropertyValue('--sun-glow').trim(),
      ambient: getComputedStyle(el).getPropertyValue('--ambient').trim(),
      cloudCover: getComputedStyle(el).getPropertyValue('--cloud-cover').trim(),
      flash: getComputedStyle(el).getPropertyValue('--flash').trim()
    } : null; };
    return {
      bodyClass: document.body.className,
      root: pick(document.documentElement),
      atmosphere: pick(at),
      gallery: pick(g),
      weatherBar: pick(wb),
      focus: pick(f),
      celestialLeft: (function(){ var c = document.getElementById('celestial'); return c ? getComputedStyle(c).left : null; })(),
      celestialTop: (function(){ var c = document.getElementById('celestial'); return c ? getComputedStyle(c).top : null; })(),
      dotColor: (function(){ var d = document.querySelector('.weather-bar__dot'); return d ? getComputedStyle(d).backgroundColor : null; })(),
      rainCanvas: (function(){
        var c = document.getElementById('rainCanvas');
        if (!c) return null;
        var ctx = c.getContext('2d');
        var data = ctx.getImageData(0, 0, c.width, c.height).data;
        var opaque = 0;
        for (var i = 3; i < data.length; i += 4) if (data[i] > 0) opaque += 1;
        return { display: getComputedStyle(c).display, w: c.width, h: c.height, opaqueSample: opaque };
      })(),
      bench: (function(){ var el = document.querySelector('[data-bench]'); return el ? el.textContent : null; })()
    };
  })()`);
  process.stdout.write(JSON.stringify({ ok: true, out, bytes: shot.bytes, state, errors }, null, 2) + '\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message, errors }, null, 2) + '\n');
  process.exitCode = 2;
} finally {
  await shutdownChrome({ cdp, child, profileDir, keepProfile: false }).catch(() => null);
}