#!/usr/bin/env node
/* bench-main.mjs — TIDELINE 主线程基准（CDP Performance.getMetrics 差值法）。
 *
 * 两种模式：
 *
 * 1) 单组 / 跨页面 A/B（改代码前后对比用）：
 *    node _lab/tools/bench-main.mjs --case "base=bench=1" --case "noattr=bench=1&noattr=1" \
 *         --seconds 6 --warmup 4 --viewport 1920x1065 --out _lab/shots/perf/before.json
 *
 * 2) 同页成对 A/B（无头方差极大时用这个）：同一页面里交替 base / toggle 各采
 *    --segment 秒，重复 --rounds 轮，比较同一时段的比值，最后取中位数：
 *    node _lab/tools/bench-main.mjs --pair "norain,noattr,no2dcloud,nocardmove,nocardfx" \
 *         --segment 3 --rounds 3 --viewport 1920x1065 --out _lab/shots/perf/pairs.json
 *
 * 每组给出 RecalcStyleCount/Duration、LayoutCount/Duration、ScriptDuration、
 * TaskDuration、DocumentLayoutCount，以及页面内 __perfMain 的 rAF 帧间隔 /
 * animate 回调 / LoAF（含 style+layout）分位数；同时记录 weather 内部计数器
 * （root 自定义属性实际写入次数、2D 云生成次数、雨 clearRect 次数）做归一化。
 *
 * 重要：无头 Chrome 跑 SwiftShader（软件光栅），FPS 与 GPU 时间完全不可信。
 * 但 recalc style / layout / script / task 都是 CPU 时间，A/B 差分有效。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GIFT_INDEX, WORKSPACE_ROOT, SHOTS_ROOT, parseArgv, argList, boolArg, numArg,
  findChrome, chromeFlags, makeProfileDir, launchChrome, waitForDevTools,
  waitForPageTarget, CDP, cdpEval, waitForCondition, setViewport, navigate,
  shutdownChrome, ensureDir, writeJson, installSignalHooks, sleep, round, nowIso,
  percentile, mean,
} from './_shared.mjs';

installSignalHooks();

const HELP = [
  'TIDELINE main-thread bench (CDP Performance.getMetrics delta)',
  '',
  'Usage:',
  '  node _lab/tools/bench-main.mjs --case "base=bench=1" --case "noattr=bench=1&noattr=1"',
  '  node _lab/tools/bench-main.mjs --pair "norain,noattr,no2dcloud,nocardmove,nocardfx" --segment 3 --rounds 3',
  '  node _lab/tools/bench-main.mjs --query "bench=1" --seconds 6 --warmup 4',
  '',
  'Options:',
  '  --case NAME=QUERY     repeatable page-load case; QUERY is the URL query string',
  '  --pair LIST           comma list of runtime toggles to pair against base in one page',
  '                        (norain, noattr, no2dcloud, nocardmove, nocardfx, all)',
  '  --micro LIST          controlled micro-bench: drive N synthetic frames per mode and',
  '                        force one style/layout flush each, no rAF/GPU dependency',
  '  --frames N            synthetic frames per micro run (default 200)',
  '  --micro-query Q       page query for --micro (default bench=1&nogl=1)',
  '  --jitter              micro only: force weather values to change every frame (damping worst case)',
  '  --damp                micro only: reset to a real damping transition before each run',
  '  --query QUERY         single page-load case when no --case is given (default bench=1)',
  '  --seconds N           sampling window for --case (default 6)',
  '  --segment N           seconds per base/toggle segment for --pair (default 3)',
  '  --rounds N            repeats of the full pair list for --pair (default 3)',
  '  --warmup N            settle seconds after load before sampling (default 4)',
  '  --viewport WxH        viewport, default 1920x1065',
  '  --out FILE            write the JSON report',
  '  --no-webgl            block WebGL/WebGPU so the site falls back to Canvas-2D (CPU bench only)',
  '  --keep-profile        keep the temp Chrome profile',
  '  --json-only           only JSON on stdout',
  '  --help                this text',
].join('\n');

const args = parseArgv(process.argv.slice(2));
if (args.help) { process.stdout.write(HELP + '\n'); process.exit(0); }

const jsonOnly = boolArg(args['json-only'], false);
const seconds = Math.max(1, numArg(args.seconds, 6));
const segment = Math.max(1, numArg(args.segment, 3));
const rounds = Math.max(1, numArg(args.rounds, 3));
const warmup = Math.max(0, numArg(args.warmup, 4));
const keepProfile = boolArg(args['keep-profile'], false);
const noWebgl = boolArg(args['no-webgl'], false);
const jitter = boolArg(args.jitter, false);
const damp = boolArg(args.damp, false);
const vpRaw = String(args.viewport || '1920x1065');
const vp = vpRaw.split(/[xX*,]/).map((s) => Math.max(2, Math.floor(Number(s) || 0)));
const viewport = { width: vp[0] || 1920, height: vp[1] || 1065 };
const pairList = argList(args.pair);
const microList = argList(args.micro);
const microFrames = Math.max(10, numArg(args.frames, 200));
const cases = argList(args.case);

const TOGGLE_KEYS = ['norain', 'noattr', 'no2dcloud', 'nocardfx', 'nocardmove', 'nocache', 'rootscope'];
const TOGGLE_MAP = {
  base: {},
  nocache: { nocache: true },
  rootscope: { rootscope: true },
  norain: { norain: true },
  noattr: { noattr: true },
  no2dcloud: { no2dcloud: true },
  nocardmove: { nocardmove: true },
  nocardfx: { nocardfx: true, bodyClass: 'is-nocardfx' },
  all: { norain: true, noattr: true, no2dcloud: true, nocardfx: true, bodyClass: 'is-nocardfx' },
};

const chromePath = findChrome();
if (!chromePath) { process.stderr.write('bench-main: Chrome not found (set CHROME_PATH)\n'); process.exit(1); }
function log(msg) { if (!jsonOnly) process.stderr.write('[bench-main] ' + msg + '\n'); }

function metricsMap(list) {
  const out = {};
  for (const m of list || []) out[m.name] = m.value;
  return out;
}
const WANTED = [
  'RecalcStyleCount', 'RecalcStyleDuration',
  'LayoutCount', 'LayoutDuration',
  'ScriptDuration', 'TaskDuration',
  'DocumentLayoutCount', 'Nodes', 'JSHeapUsedSize', 'Timestamp',
];
function pickDelta(before, after) {
  const out = {};
  for (const key of WANTED) {
    const a = before[key];
    const b = after[key];
    out[key] = Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
  }
  return out;
}

const READY = 'document.readyState === "complete" && !!(window.Weather && window.Weather.state) && !!window.__perfMain';
const APPLY_TOGGLE = `(function (spec) {
  var d = window.__tidelineDiag || (window.__tidelineDiag = {});
  var keys = ['norain', 'noattr', 'no2dcloud', 'nocardfx', 'nocardmove', 'nocache', 'rootscope'];
  for (var i = 0; i < keys.length; i += 1) d[keys[i]] = !!spec[keys[i]];
  if (document.body) document.body.classList.toggle('is-nocardfx', !!spec.bodyClass);
  return { diag: Object.assign({}, d), bodyClass: document.body ? document.body.className : '' };
})`;

async function openPage(query, profileName) {
  const profileDir = makeProfileDir(path.join(SHOTS_ROOT, 'perf'), profileName);
  const flags = chromeFlags({ width: viewport.width, height: viewport.height, profileDir, remote: true });
  const { child, getStderr } = await launchChrome(chromePath, flags);
  let cdp = null;
  try {
    const { port } = await waitForDevTools(profileDir, { timeoutMs: 30000, getStderr });
    const target = await waitForPageTarget(port, { timeoutMs: 20000 });
    cdp = await new CDP(target.webSocketDebuggerUrl).connect(15000);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await setViewport(cdp, viewport.width, viewport.height, 1);
    await cdp.send('Performance.enable');
    /* 固定 FULL 画质：否则 AUTO 会在弱机/无头里落 LITE，改变 cloudFps 等预算，
       让 A/B 的两侧不在同一档。 */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try { localStorage.setItem("tideline.quality.v1", \'{"mode":"full"}\'); } catch (e) {}',
    });
    /* --no-webgl：让 WebGL/WebGPU 全部失败，站点回落到 Canvas-2D 海面 + 2D 云。
       只用于 CPU 基准：SwiftShader 的体素云/海面会把主线程按秒级堵住，量不到 CSS。 */
    if (noWebgl) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: '(function(){ var orig = HTMLCanvasElement.prototype.getContext;' +
          'HTMLCanvasElement.prototype.getContext = function(type){' +
          'if (/webgl/i.test(String(type))) return null;' +
          'return orig.apply(this, arguments); }; })();',
      });
    }
    const url = pathToFileURL(GIFT_INDEX).href + (query ? '?' + query : '');
    await navigate(cdp, url, 90000);
    await waitForCondition(cdp, READY, (v) => v === true, {
      timeoutMs: 90000, intervalMs: 300, label: 'site ready',
    });
    await sleep(warmup * 1000);
    return { cdp, child, profileDir };
  } catch (err) {
    await shutdownChrome({ cdp, child, profileDir, keepProfile }).catch(() => null);
    throw err;
  }
}

async function sampleSegment(cdp, ms) {
  const countersBefore = await cdpEval(cdp, 'Object.assign({}, window.__weatherCounters || {})');
  const before = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
  const t0 = await cdpEval(cdp, 'performance.now()');
  await sleep(ms);
  const t1 = await cdpEval(cdp, 'performance.now()');
  const after = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
  const countersAfter = await cdpEval(cdp, 'Object.assign({}, window.__weatherCounters || {})');
  const raf = await cdpEval(cdp, 'window.__perfMain.report(' + t0 + ', ' + t1 + ')');
  const wallMs = t1 - t0;
  const delta = pickDelta(before, after);
  const counters = {};
  for (const key of Object.keys(countersAfter)) {
    counters[key] = (countersAfter[key] || 0) - (countersBefore[key] || 0);
  }
  const frames = raf && Number.isFinite(raf.frames) ? raf.frames : 0;
  const perSec = (s) => (wallMs > 0 ? round((s * 1000) / wallMs, 2) : null);
  const perFrame = (s) => (frames > 0 ? round(s / frames, 3) : null);
  const recalcMs = Number.isFinite(delta.RecalcStyleDuration) ? delta.RecalcStyleDuration * 1000 : null;
  const scriptMs = Number.isFinite(delta.ScriptDuration) ? delta.ScriptDuration * 1000 : null;
  const layoutMs = Number.isFinite(delta.LayoutDuration) ? delta.LayoutDuration * 1000 : null;
  const taskMs = Number.isFinite(delta.TaskDuration) ? delta.TaskDuration * 1000 : null;
  return {
    wallMs: round(wallMs, 1),
    frames,
    pageFps: raf && Number.isFinite(raf.fps) ? round(raf.fps, 2) : null,
    raf: raf ? {
      intervalP50: round(raf.intervalP50, 2),
      intervalP95: round(raf.intervalP95, 2),
      cbP50: round(raf.cbP50, 2),
      cbP95: round(raf.cbP95, 2),
      cbMax: round(raf.cbMax, 2),
      gapP50: round(raf.gapP50, 2),
      gapP95: round(raf.gapP95, 2),
      loafCount: raf.loaf ? raf.loaf.count : null,
      loafMean: raf.loaf ? round(raf.loaf.mean, 2) : null,
      loafP95: raf.loaf ? round(raf.loaf.p95, 2) : null,
      loafStyleMean: raf.loaf ? round(raf.loaf.styleMean, 2) : null,
      loafStyleP95: raf.loaf ? round(raf.loaf.styleP95, 2) : null,
    } : null,
    counters,
    metrics: {
      RecalcStyleCount: delta.RecalcStyleCount,
      RecalcStyleMs: round(recalcMs, 1),
      RecalcStyleMsPerSec: perSec(recalcMs),
      RecalcStyleCountPerSec: perSec(delta.RecalcStyleCount),
      RecalcStyleMsPerFrame: perFrame(recalcMs),
      LayoutCount: delta.LayoutCount,
      LayoutMs: round(layoutMs, 1),
      DocumentLayoutCount: delta.DocumentLayoutCount,
      ScriptMs: round(scriptMs, 1),
      ScriptMsPerSec: perSec(scriptMs),
      ScriptMsPerFrame: perFrame(scriptMs),
      TaskMs: round(taskMs, 1),
      TaskMsPerSec: perSec(taskMs),
      TaskMsPerFrame: perFrame(taskMs),
      rootWritesPerSec: perSec(counters.rootWrites || 0),
      rootWritesPerFrame: perFrame(counters.rootWrites || 0),
      updatesPerSec: perSec(counters.updates || 0),
      applySkyPerSec: perSec(counters.applySky || 0),
      updateCloudsPerSec: perSec(counters.updateClouds || 0),
      cloudGeneratedPerSec: perSec(counters.cloudGenerated || 0),
      rainClearedPerSec: perSec(counters.rainCleared || 0),
    },
    raw: delta,
  };
}

function median(values) {
  return round(percentile(values.filter((v) => Number.isFinite(v)), 0.5), 3);
}
function summarizePairs(pairs, toggle) {
  const mine = pairs.filter((p) => p.name === toggle);
  const ratio = (key) => mine.map((p) => {
    const a = p.base.metrics[key];
    const b = p.on.metrics[key];
    return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? b / a : null;
  }).filter((v) => Number.isFinite(v));
  const side = (which, key) => median(mine.map((p) => p[which].metrics[key]));
  return {
    toggle,
    pairs: mine.length,
    recalcMsPerSec: { base: side('base', 'RecalcStyleMsPerSec'), off: side('on', 'RecalcStyleMsPerSec'), ratio: median(ratio('RecalcStyleMsPerSec')) },
    recalcCountPerSec: { base: side('base', 'RecalcStyleCountPerSec'), off: side('on', 'RecalcStyleCountPerSec'), ratio: median(ratio('RecalcStyleCountPerSec')) },
    recalcMsPerFrame: { base: side('base', 'RecalcStyleMsPerFrame'), off: side('on', 'RecalcStyleMsPerFrame'), ratio: median(ratio('RecalcStyleMsPerFrame')) },
    scriptMsPerSec: { base: side('base', 'ScriptMsPerSec'), off: side('on', 'ScriptMsPerSec'), ratio: median(ratio('ScriptMsPerSec')) },
    taskMsPerSec: { base: side('base', 'TaskMsPerSec'), off: side('on', 'TaskMsPerSec'), ratio: median(ratio('TaskMsPerSec')) },
    layoutMs: { base: side('base', 'LayoutMs'), off: side('on', 'LayoutMs') },
    framesPerSec: {
      base: median(mine.map((p) => p.base.pageFps)),
      off: median(mine.map((p) => p.on.pageFps)),
    },
    counters: {
      rootWritesPerSec: { base: side('base', 'rootWritesPerSec'), off: side('on', 'rootWritesPerSec') },
      rootWritesPerFrame: { base: side('base', 'rootWritesPerFrame'), off: side('on', 'rootWritesPerFrame') },
      updateCloudsPerSec: { base: side('base', 'updateCloudsPerSec'), off: side('on', 'updateCloudsPerSec') },
      cloudGeneratedPerSec: { base: side('base', 'cloudGeneratedPerSec'), off: side('on', 'cloudGeneratedPerSec') },
      rainClearedPerSec: { base: side('base', 'rainClearedPerSec'), off: side('on', 'rainClearedPerSec') },
    },
    rafCbP50: { base: side('base', 'RecalcStyleMsPerFrame'), n: mine.length },
  };
}

async function runCases() {
  const list = cases.length
    ? cases.map((raw) => {
      const eq = raw.indexOf('=');
      return { name: eq >= 0 ? raw.slice(0, eq) : raw, query: eq >= 0 ? raw.slice(eq + 1) : 'bench=1' };
    })
    : [{ name: 'single', query: String(args.query === undefined || args.query === true ? 'bench=1' : args.query) }];
  const results = [];
  for (const entry of list) {
    log('case ' + entry.name + ' ?' + entry.query + '  ' + seconds + 's');
    const { cdp, child, profileDir } = await openPage(entry.query, entry.name);
    try {
      const seg = await sampleSegment(cdp, seconds * 1000);
      const tide = await cdpEval(cdp, 'window.__tideStats ? window.__tideStats() : null');
      const bodyClass = await cdpEval(cdp, 'document.body.className');
      results.push({ name: entry.name, query: entry.query, bodyClass, tide, ...seg });
    } finally {
      await shutdownChrome({ cdp, child, profileDir, keepProfile }).catch(() => null);
    }
    log('  frames ' + results[results.length - 1].frames + '  recalc ' + results[results.length - 1].metrics.RecalcStyleMs + ' ms  script ' + results[results.length - 1].metrics.ScriptMs + ' ms');
  }
  return results;
}

async function runMicro() {
  const modes = microList.length ? microList : ['noattr', 'no2dcloud', 'norain', 'nocardmove', 'nocardfx'];
  const unknown = modes.filter((t) => !TOGGLE_MAP[t]);
  if (unknown.length) throw new Error('unknown micro modes: ' + unknown.join(','));
  const query = String(args['micro-query'] === undefined || args['micro-query'] === true
    ? 'bench=1&nogl=1'
    : args['micro-query']);
  const { cdp, child, profileDir } = await openPage(query, 'micro');
  const pairs = [];
  try {
    const applyToggle = async (name) => {
      await cdpEval(cdp, APPLY_TOGGLE + '(' + JSON.stringify(TOGGLE_MAP[name]) + ')');
      await sleep(250);
    };
    const runOne = async () => {
      const c0 = await cdpEval(cdp, 'Object.assign({}, window.__weatherCounters || {})');
      const m0 = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
      const microOpts = damp ? '{ dampReset: true }' : (jitter ? '{ jitter: true }' : '{}');
      const out = await cdpEval(cdp, 'window.__benchMicro(' + microFrames + ', ' + microOpts + ')', { timeoutMs: 120000 });
      const m1 = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
      const c1 = await cdpEval(cdp, 'Object.assign({}, window.__weatherCounters || {})');
      const delta = pickDelta(m0, m1);
      const counters = {};
      for (const key of Object.keys(c1)) counters[key] = (c1[key] || 0) - (c0[key] || 0);
      const frames = out.frames;
      const msOf = (s) => (Number.isFinite(s) ? s * 1000 : null);
      const perFrame = (v) => (Number.isFinite(v) ? round(v / frames, 3) : null);
      return {
        frames,
        wallMs: round(out.ms, 1),
        wallMsPerFrame: round(out.ms / frames, 3),
        recalcMsPerFrame: perFrame(msOf(delta.RecalcStyleDuration)),
        layoutMsPerFrame: perFrame(msOf(delta.LayoutDuration)),
        scriptMsPerFrame: perFrame(msOf(delta.ScriptDuration)),
        taskMsPerFrame: perFrame(msOf(delta.TaskDuration)),
        recalcCountPerFrame: perFrame(delta.RecalcStyleCount),
        countersPerFrame: {
          rootWrites: perFrame(counters.rootWrites || 0),
          rootApplied: perFrame(counters.rootApplied || 0),
          updates: perFrame(counters.updates || 0),
          applySky: perFrame(counters.applySky || 0),
          updateClouds: perFrame(counters.updateClouds || 0),
          cloudGenerated: perFrame(counters.cloudGenerated || 0),
          rainCleared: perFrame(counters.rainCleared || 0),
        },
      };
    };
    for (let round = 1; round <= rounds; round += 1) {
      for (const mode of modes) {
        const modeFirst = round % 2 === 0;
        log('micro round ' + round + '/' + rounds + '  ' + (modeFirst ? mode + ' -> base' : 'base -> ' + mode));
        let base;
        let on;
        if (modeFirst) {
          await applyToggle(mode); on = await runOne();
          await applyToggle('base'); base = await runOne();
        } else {
          await applyToggle('base'); base = await runOne();
          await applyToggle(mode); on = await runOne();
        }
        pairs.push({ round, name: mode, base, on });
        log('  ' + mode + ': base ' + base.wallMsPerFrame + ' ms/f (recalc ' + base.recalcMsPerFrame
          + ') -> ' + on.wallMsPerFrame + ' ms/f (recalc ' + on.recalcMsPerFrame + ')');
      }
    }
    const summary = modes.map((mode) => {
      const mine = pairs.filter((p) => p.name === mode);
      const read = (p, side, key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), p[side]);
      const medianOf = (side, key) => round(percentile(mine.map((p) => read(p, side, key)).filter(Number.isFinite), 0.5), 3);
      const ratioOf = (key) => {
        const rs = mine.map((p) => (Number.isFinite(p.base[key]) && p.base[key] > 0 && Number.isFinite(p.on[key])
          ? p.on[key] / p.base[key] : null)).filter(Number.isFinite);
        return round(percentile(rs, 0.5), 3);
      };
      return {
        mode,
        pairs: mine.length,
        wallMsPerFrame: { base: medianOf('base', 'wallMsPerFrame'), off: medianOf('on', 'wallMsPerFrame'), ratio: ratioOf('wallMsPerFrame') },
        recalcMsPerFrame: { base: medianOf('base', 'recalcMsPerFrame'), off: medianOf('on', 'recalcMsPerFrame'), ratio: ratioOf('recalcMsPerFrame') },
        scriptMsPerFrame: { base: medianOf('base', 'scriptMsPerFrame'), off: medianOf('on', 'scriptMsPerFrame'), ratio: ratioOf('scriptMsPerFrame') },
        taskMsPerFrame: { base: medianOf('base', 'taskMsPerFrame'), off: medianOf('on', 'taskMsPerFrame'), ratio: ratioOf('taskMsPerFrame') },
        layoutMsPerFrame: { base: medianOf('base', 'layoutMsPerFrame'), off: medianOf('on', 'layoutMsPerFrame') },
        counters: {
          rootWrites: { base: medianOf('base', 'countersPerFrame.rootWrites'), off: medianOf('on', 'countersPerFrame.rootWrites') },
          rootApplied: { base: medianOf('base', 'countersPerFrame.rootApplied'), off: medianOf('on', 'countersPerFrame.rootApplied') },
        },
      };
    });
    return { pairs, summary };
  } finally {
    await shutdownChrome({ cdp, child, profileDir, keepProfile }).catch(() => null);
  }
}

function printMicroTable(summary) {
  const cols = ['mode', 'pairs', 'ms/f base', 'ms/f off', 'ratio', 'recalc/f base', 'recalc/f off', 'ratio', 'script/f base', 'script/f off', 'rootW/f base', 'rootW/f off'];
  const rows = summary.map((s) => [
    s.mode, String(s.pairs),
    String(s.wallMsPerFrame.base), String(s.wallMsPerFrame.off), String(s.wallMsPerFrame.ratio),
    String(s.recalcMsPerFrame.base), String(s.recalcMsPerFrame.off), String(s.recalcMsPerFrame.ratio),
    String(s.scriptMsPerFrame.base), String(s.scriptMsPerFrame.off),
    String(s.counters.rootWrites.base), String(s.counters.rootWrites.off),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  process.stdout.write([line(cols), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n') + '\n');
}

async function runPairs() {
  const unknown = pairList.filter((t) => !TOGGLE_MAP[t]);
  if (unknown.length) throw new Error('unknown toggles: ' + unknown.join(',') + ' (known: ' + Object.keys(TOGGLE_MAP).join(',') + ')');
  const baseQuery = String(args['pair-query'] === undefined || args['pair-query'] === true ? 'bench=1' : args['pair-query']);
  const { cdp, child, profileDir } = await openPage(baseQuery, 'pair');
  const pairs = [];
  try {
    const applyToggle = async (name) => {
      const spec = TOGGLE_MAP[name];
      const res = await cdpEval(cdp, APPLY_TOGGLE + '(' + JSON.stringify(spec) + ')');
      await sleep(700); // let the toggle itself settle out of the sample window
      return res;
    };
    for (let round = 1; round <= rounds; round += 1) {
      for (const toggle of pairList) {
        /* 交替顺序：奇数轮 base→toggle，偶数轮 toggle→base。
           同一个页面的帧率会随时间缓慢漂移，交替可以把这种线性漂移
           从比值里抵消掉。 */
        const toggleFirst = round % 2 === 0;
        log('round ' + round + '/' + rounds + '  ' + (toggleFirst ? toggle + ' -> base' : 'base -> ' + toggle));
        let base;
        let tog;
        if (toggleFirst) {
          await applyToggle(toggle);
          tog = await sampleSegment(cdp, segment * 1000);
          await applyToggle('base');
          base = await sampleSegment(cdp, segment * 1000);
        } else {
          await applyToggle('base');
          base = await sampleSegment(cdp, segment * 1000);
          await applyToggle(toggle);
          tog = await sampleSegment(cdp, segment * 1000);
        }
        pairs.push({ round, name: toggle, base, on: tog });
      }
    }
    const summary = pairList.map((t) => summarizePairs(pairs, t));
    return { pairs, summary };
  } finally {
    await shutdownChrome({ cdp, child, profileDir, keepProfile }).catch(() => null);
  }
}

function printCaseTable(results) {
  const cols = ['case', 'frames', 'fps', 'rAF p50', 'rAF p95', 'cb p50', 'cb p95', 'Recalc ms', 'Recalc ms/s', 'Recalc/f', 'Layout ms', 'Script ms', 'Task ms', 'rootW/s', 'cloud2d/s'];
  const rows = results.map((r) => [
    r.name, String(r.frames), String(r.pageFps),
    String(r.raf ? r.raf.intervalP50 : 'n/a'), String(r.raf ? r.raf.intervalP95 : 'n/a'),
    String(r.raf ? r.raf.cbP50 : 'n/a'), String(r.raf ? r.raf.cbP95 : 'n/a'),
    String(r.metrics.RecalcStyleMs), String(r.metrics.RecalcStyleMsPerSec),
    String(r.metrics.RecalcStyleMsPerFrame), String(r.metrics.LayoutMs),
    String(r.metrics.ScriptMs), String(r.metrics.TaskMs),
    String(r.metrics.rootWritesPerSec), String(r.metrics.cloudGeneratedPerSec),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  process.stdout.write([line(cols), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n') + '\n');
}

function printPairTable(summary) {
  const cols = ['toggle', 'pairs', 'recalc/s ratio', 'recalc/s base', 'recalc/s off', 'recalc/f ratio', 'script/s ratio', 'task/s ratio', 'fps base', 'fps off', 'rootW/s base', 'rootW/s off'];
  const rows = summary.map((s) => [
    s.toggle, String(s.pairs),
    String(s.recalcMsPerSec.ratio), String(s.recalcMsPerSec.base), String(s.recalcMsPerSec.off),
    String(s.recalcMsPerFrame.ratio), String(s.scriptMsPerSec.ratio), String(s.taskMsPerSec.ratio),
    String(s.framesPerSec.base), String(s.framesPerSec.off),
    String(s.counters.rootWritesPerSec.base), String(s.counters.rootWritesPerSec.off),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  process.stdout.write([line(cols), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n') + '\n');
}

const startedAt = nowIso();
const report = {
  schema: 'tideline.bench-main/1',
  tool: 'bench-main.mjs',
  startedAt,
  finishedAt: null,
  viewport: viewport.width + 'x' + viewport.height,
  note: 'Headless Chrome runs SwiftShader (software raster). fps and GPU time are NOT representative; RecalcStyleDuration/LayoutDuration/ScriptDuration/TaskDuration are CPU time and valid for A/B deltas. In --pair mode compare ratios (toggle/base) from the same page run; medians over rounds.',
};
try {
  if (microList.length || boolArg(args.micro, false)) {
    const { pairs, summary } = await runMicro();
    report.mode = 'micro';
    report.microFrames = microFrames;
    report.rounds = rounds;
    report.pairs = pairs;
    report.summary = summary;
  } else if (pairList.length) {
    const { pairs, summary } = await runPairs();
    report.mode = 'pair';
    report.segment = segment;
    report.rounds = rounds;
    report.pairs = pairs;
    report.summary = summary;
  } else {
    const results = await runCases();
    report.mode = 'case';
    report.seconds = seconds;
    report.results = results;
  }
} finally {
  report.finishedAt = nowIso();
}
const outFile = args.out
  ? path.resolve(WORKSPACE_ROOT, String(args.out))
  : path.join(SHOTS_ROOT, 'perf', 'bench-main-' + nowIso().replace(/[:.]/g, '').slice(0, 15) + '.json');
ensureDir(path.dirname(outFile));
writeJson(outFile, report);
if (jsonOnly) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  if (report.mode === 'case') printCaseTable(report.results);
  else if (report.mode === 'micro') printMicroTable(report.summary);
  else printPairTable(report.summary);
  process.stdout.write('report: ' + outFile + '\n');
}
