#!/usr/bin/env node
// Cloud Lab capture / perf bench.
// Screenshots + image-quality stats + contact sheet, or CDP performance sampling.
// Writes only below _lab/shots/<tag>/ by default.

import fs from 'node:fs';
import path from 'node:path';
import {
  SHOTS_ROOT, WORKSPACE_ROOT, LAB_PRESETS, buildLabUrl, normalizeLabParams,
  parseArgv, argList, boolArg, numArg, mergeKvArgs, findChrome, chromeFlags,
  installSignalHooks, launchChrome, waitForExit, waitForDevTools, waitForPageTarget,
  CDP, cdpEval, waitForCondition, waitFrames, setViewport, captureScreenshot,
  navigate, shutdownChrome, ensureDir, writeJson, fileSize, isPng, analyzeImages,
  buildContactSheet, makeProfileDir, cleanupProfile, nowIso, randomId, safeFileStem,
  uniqueName, fmtDuration, sleep, tailString, summarizePerf, round, NL,
} from './_shared.mjs';

installSignalHooks();

const HELP = [
  'Cloud Lab capture bench',
  '',
  'Usage:',
  '  node capture.mjs --tag v2 --matrix default,storm,stratus --dur 15000',
  '  node capture.mjs --tag perf --matrix default,storm --perf --perf-seconds 8',
  '  node capture.mjs --tag one --matrix storm@steps=32@scale=0.5 --json-only --assert',
  '',
  'Options:',
  '  --tag NAME             output folder under _lab/shots/NAME (default capture-<stamp>)',
  '  --matrix LIST          comma list of cases. A case is NAME or NAME@k=v@k=v.',
  '                         Known preset names cumulus/stratus/storm auto-select a preset.',
  '  --set k=v,k=v          global override applied to every case (after preset/inline)',
  '  --dur MS               virtual-time-budget for CLI screenshots (default 15000)',
  '  --perf                 CDP mode: no screenshot, sample window.__lab.stats()',
  '  --perf-seconds N       sampling duration per case (default dur/1000)',
  '  --sample-interval MS   CDP sample interval (default 150)',
  '  --width N --height N   viewport (default 1280x800)',
  '  --cdp                  force CDP screenshot path (needed for paused/cam.*)',
  '  --settle MS            settle time after __lab.set before shot/perf (default 800)',
  '  --no-sheet             skip contact sheet',
  '  --min-stddev N         flat-image threshold for qualityOk (default 2.0)',
  '  --assert               exit 2 when a capture or image-quality check fails',
  '  --retries N            retry failed screenshot runs (default 1)',
  '  --out DIR              override output dir (default _lab/shots/<tag>)',
  '  --json-only            only JSON on stdout (diagnostics go to stderr)',
  '  --dry-run              plan cases without launching Chrome',
  '  --keep-profile         keep the temporary Chrome profile for debugging',
  '  --help                 this text',
].join(NL);

function stampTag() {
  return nowIso().replaceAll(':', '').replaceAll('-', '').replace('T', '-').slice(0, 15);
}

function makeOptions(argv) {
  const args = parseArgv(argv);
  if (args.help) return { help: true };
  const tag = safeFileStem(args.tag === undefined ? 'capture-' + stampTag() : args.tag, 'capture');
  const outDir = args.out
    ? path.resolve(WORKSPACE_ROOT, String(args.out))
    : path.join(SHOTS_ROOT, tag);
  const dur = Math.max(1000, numArg(args.dur, 15000));
  const width = Math.max(320, Math.floor(numArg(args.width, 1280)));
  const height = Math.max(240, Math.floor(numArg(args.height, 800)));
  const perf = boolArg(args.perf, false);
  const perfSeconds = Math.max(1, Math.min(120, numArg(args['perf-seconds'], dur / 1000)));
  return {
    help: false,
    tag,
    outDir,
    matrix: argList(args.matrix),
    globalSet: mergeKvArgs(args.set),
    dur,
    perf,
    perfSeconds,
    sampleInterval: Math.max(50, numArg(args['sample-interval'], 150)),
    width,
    height,
    forceCdp: boolArg(args.cdp, false),
    settle: Math.max(0, numArg(args.settle, 800)),
    noSheet: boolArg(args['no-sheet'], false),
    minStddev: Math.max(0, numArg(args['min-stddev'], 2)),
    assert: boolArg(args.assert, false),
    retries: Math.max(0, Math.min(4, Math.floor(numArg(args.retries, 1)))),
    jsonOnly: boolArg(args['json-only'], false),
    dryRun: boolArg(args['dry-run'], false),
    keepProfile: boolArg(args['keep-profile'], false),
    timeoutMs: Math.max(10000, numArg(args.timeout, dur + 60000)),
    columns: Math.max(1, Math.min(4, Math.floor(numArg(args.columns, 2)))),
    thumbWidth: Math.max(200, Math.floor(numArg(args['thumb-width'], 600))),
    thumbHeight: Math.max(120, Math.floor(numArg(args['thumb-height'], 375))),
  };
}

function makeLogger(opts) {
  const lines = [];
  return {
    lines,
    info(message) {
      const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + message;
      lines.push(line);
      if (!opts.jsonOnly) process.stderr.write('[capture] ' + message + NL);
    },
    warn(message) {
      const line = 'WARN ' + message;
      lines.push(line);
      if (!opts.jsonOnly) process.stderr.write('[capture] WARN ' + message + NL);
    },
  };
}

function expandCases(tokens, globalSet) {
  const used = new Set();
  const out = [];
  const list = tokens.length ? tokens : ['default'];
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i]).trim();
    if (!token) continue;
    const at = token.indexOf('@');
    const rawName = at >= 0 ? token.slice(0, at) : token;
    const inline = {};
    if (at >= 0) {
      for (const piece of token.slice(at + 1).split('@')) {
        if (!piece.trim()) continue;
        Object.assign(inline, mergeKvArgs([piece]));
      }
    }
    let preset = null;
    if (Object.prototype.hasOwnProperty.call(inline, 'preset')) {
      preset = String(inline.preset);
      delete inline.preset;
    } else if (LAB_PRESETS.has(rawName)) {
      preset = rawName;
    }
    const merged = {};
    if (preset) merged.preset = preset;
    Object.assign(merged, inline, globalSet);
    if (Object.prototype.hasOwnProperty.call(merged, 'preset')) {
      preset = String(merged.preset);
      delete merged.preset;
    }
    const norm = normalizeLabParams(merged);
    const name = uniqueName(safeFileStem(rawName || ('case' + (i + 1)), 'case'), used);
    out.push({
      name,
      rawName: rawName || name,
      preset,
      params: merged,
      query: norm.query,
      patch: norm.patch,
      cam: norm.cam,
      unknown: norm.unknown,
      url: buildLabUrl(preset, norm.query),
    });
  }
  return out;
}

function caseNeedsCdp(spec, opts) {
  if (opts.perf || opts.forceCdp) return true;
  if (spec.unknown.length) return true;
  for (const key of Object.keys(spec.cam)) {
    if (!(key in spec.query)) return true;
  }
  return false;
}

async function captureCliOnce(spec, opts) {
  const outPng = path.join(opts.outDir, spec.name + '.png');
  try { fs.rmSync(outPng, { force: true }); } catch { /* no-op */ }
  const profileDir = makeProfileDir(opts.outDir, 'cli-' + spec.name);
  const args = [
    ...chromeFlags({ width: opts.width, height: opts.height, profileDir }),
    '--virtual-time-budget=' + opts.dur,
    '--screenshot=' + outPng,
    spec.url,
  ];
  const started = Date.now();
  let launched = null;
  let exit = { code: null, signal: null, timedOut: false };
  try {
    launched = await launchChrome(opts.chrome, args);
    exit = await waitForExit(launched.child, opts.timeoutMs);
  } finally {
    if (launched) await shutdownChrome({ child: launched.child, profileDir, keepProfile: opts.keepProfile });
  }
  const stderr = launched ? launched.getStderr() : '';
  const bytes = fileSize(outPng);
  const png = bytes > 0 && isPng(outPng);
  return {
    ok: png,
    used: 'cli-screenshot',
    png: png ? outPng : null,
    pngTried: outPng,
    bytes,
    captureMs: Date.now() - started,
    chromeExitCode: exit.code,
    timedOut: exit.timedOut,
    stderrTail: png ? '' : tailString(stderr, 4000),
    error: png ? null : (exit.timedOut ? 'Chrome timed out before writing a PNG' : 'Chrome did not write a valid PNG (stderr tail attached)'),
  };
}

async function captureCli(spec, opts, log) {
  let last = null;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    if (attempt > 0) {
      log.warn(spec.name + ': retry ' + attempt + '/' + opts.retries);
      await sleep(500);
    }
    last = await captureCliOnce(spec, opts);
    if (last.ok) return last;
  }
  return last;
}

async function openCdpSession(spec, opts) {
  const profileDir = makeProfileDir(opts.outDir, 'cdp-' + spec.name);
  const args = [...chromeFlags({ width: opts.width, height: opts.height, profileDir, remote: true }), 'about:blank'];
  const launched = await launchChrome(opts.chrome, args);
  let cdp = null;
  try {
    const dev = await waitForDevTools(profileDir, { timeoutMs: 30000, getStderr: launched.getStderr });
    const target = await waitForPageTarget(dev.port, { timeoutMs: 20000 });
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect(20000);
    await cdp.send('Page.enable', {}, 20000);
    await cdp.send('Runtime.enable', {}, 20000);
    await setViewport(cdp, opts.width, opts.height, 1);
    return { cdp, child: launched.child, profileDir, getStderr: launched.getStderr, port: dev.port, targetUrl: target.url };
  } catch (err) {
    await shutdownChrome({ cdp, child: launched.child, profileDir, keepProfile: opts.keepProfile });
    throw err;
  }
}

const LAB_READY_EXPR = `(function(){
  try {
    var lab = window.__lab;
    var errEl = document.getElementById('err');
    var errVisible = errEl ? getComputedStyle(errEl).display !== 'none' : false;
    return {
      ready: document.readyState,
      hasLab: !!lab,
      stats: lab ? lab.stats() : null,
      errVisible: errVisible,
      errText: errVisible && errEl ? errEl.textContent : null,
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      dpr: devicePixelRatio
    };
  } catch (err) { return { error: String(err) }; }
})()`;

async function waitLabReady(cdp, timeoutMs) {
  const result = await waitForCondition(
    cdp,
    LAB_READY_EXPR,
    (v) => v && v.ready === 'complete' && v.hasLab && v.stats && !v.errVisible,
    { timeoutMs, intervalMs: 300, label: 'cloud lab ready' },
  );
  return result.value;
}

async function applyLabPatch(cdp, spec) {
  const patch = spec.patch || {};
  const cam = spec.cam || {};
  if (!Object.keys(patch).length && !Object.keys(cam).length) {
    return cdpEval(cdp, `({ ok: true, P: Object.assign({}, window.__lab.P), cam: Object.assign({}, window.__lab.cam), applied: false })`);
  }
  const expr = `(function(){
    var lab = window.__lab;
    if (!lab) return { ok: false, error: 'window.__lab missing' };
    var patch = ${JSON.stringify(patch)};
    var cam = ${JSON.stringify(cam)};
    if (typeof lab.set === 'function') lab.set(patch);
    else Object.assign(lab.P, patch);
    if (cam && Object.keys(cam).length) {
      var posX = cam.posX; var posY = cam.posY; var posZ = cam.posZ;
      delete cam.posX; delete cam.posY; delete cam.posZ;
      if (lab.cam && Array.isArray(lab.cam.pos)) {
        if (posX !== undefined) lab.cam.pos[0] = posX;
        if (posY !== undefined) lab.cam.pos[1] = posY;
        if (posZ !== undefined) lab.cam.pos[2] = posZ;
      }
      Object.assign(lab.cam, cam);
    }
    return { ok: true, applied: true, P: Object.assign({}, lab.P), cam: Object.assign({}, lab.cam) };
  })()`;
  const result = await cdpEval(cdp, expr);
  if (!result || !result.ok) throw new Error('window.__lab.set failed: ' + (result && result.error ? result.error : 'unknown'));
  return result;
}

async function samplePerf(cdp, opts) {
  const durationMs = Math.max(1000, opts.perfSeconds * 1000);
  const interval = Math.max(50, opts.sampleInterval);
  const start = Date.now();
  const series = [];
  let first = true;
  while (first || Date.now() - start < durationMs) {
    first = false;
    const loopStart = Date.now();
    const sample = await cdpEval(cdp, `(function(){
      var lab = window.__lab;
      return {
        stats: lab ? lab.stats() : null,
        scale: lab ? lab.P.scale : null,
        pageNow: performance.now(),
        wallT: Date.now(),
        innerWidth: innerWidth,
        innerHeight: innerHeight,
        visibilityState: document.visibilityState
      };
    })()`, { timeoutMs: 15000 });
    if (sample && sample.stats) series.push(sample);
    await sleep(Math.max(0, interval - (Date.now() - loopStart)));
  }
  if (!series.length) throw new Error('no __lab.stats() samples were collected');
  return summarizePerf(series, {
    steps: series[series.length - 1].stats.steps,
    w: series[series.length - 1].stats.w,
    h: series[series.length - 1].stats.h,
    scale: series[series.length - 1].scale,
  });
}

async function cdpCaseOnce(spec, opts, log) {
  const outPng = path.join(opts.outDir, spec.name + '.png');
  const started = Date.now();
  const session = await openCdpSession(spec, opts);
  const { cdp } = session;
  let result = null;
  try {
    const baseUrl = buildLabUrl(spec.preset, {});
    await navigate(cdp, baseUrl, 60000);
    const ready = await waitLabReady(cdp, Math.min(opts.timeoutMs, 90000));
    const applied = await applyLabPatch(cdp, spec);
    try { await waitFrames(cdp, 3, 30000); }
    catch (err) { log.warn(spec.name + ': frame wait after __lab.set: ' + err.message); }
    await sleep(opts.settle);
    const viewport = await cdpEval(cdp, `({ innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio, ready: document.readyState })`);
    if (opts.perf) {
      const perf = await samplePerf(cdp, opts);
      const last = await cdpEval(cdp, `({ P: Object.assign({}, window.__lab.P), cam: Object.assign({}, window.__lab.cam), stats: window.__lab.stats() })`);
      result = {
        ok: true,
        used: 'cdp-perf',
        png: null,
        bytes: 0,
        captureMs: Date.now() - started,
        perf,
        effectiveP: last.P,
        cam: last.cam,
        stats: last.stats,
        viewport,
        applied,
        ready,
        error: null,
      };
    } else {
      try { await waitFrames(cdp, 2, 30000); }
      catch (err) { log.warn(spec.name + ': frame wait before shot: ' + err.message); }
      const shot = await captureScreenshot(cdp, outPng);
      const last = await cdpEval(cdp, `({ P: Object.assign({}, window.__lab.P), cam: Object.assign({}, window.__lab.cam), stats: window.__lab.stats() })`);
      result = {
        ok: shot.png,
        used: 'cdp-screenshot',
        png: shot.png ? outPng : null,
        pngTried: outPng,
        bytes: shot.bytes,
        captureMs: Date.now() - started,
        perf: null,
        effectiveP: last.P,
        cam: last.cam,
        stats: last.stats,
        viewport,
        applied,
        ready,
        error: shot.png ? null : 'Page.captureScreenshot did not produce a PNG',
      };
    }
  } finally {
    const cleanup = await shutdownChrome({ cdp, child: session.child, profileDir: session.profileDir, keepProfile: opts.keepProfile });
    if (!cleanup.removed && !opts.keepProfile) log.warn(spec.name + ': Chrome profile was not fully removed: ' + (cleanup.error || session.profileDir));
  }
  return result;
}

function resultBase(spec, result, opts) {
  return {
    name: spec.name,
    rawName: spec.rawName,
    preset: spec.preset,
    params: Object.assign({}, spec.params, spec.preset ? { preset: spec.preset } : {}),
    query: spec.query,
    patch: spec.patch,
    camPatch: spec.cam,
    unknown: spec.unknown,
    url: spec.url,
    captureMode: result.used || (opts.perf ? 'cdp-perf' : 'cli-screenshot'),
    png: result.png ? path.basename(result.png) : null,
    pngPath: result.png || null,
    pngBytes: result.bytes || 0,
    captureMs: Number.isFinite(result.captureMs) ? result.captureMs : null,
    ok: !!result.ok,
    error: result.error || null,
    chrome: {
      exitCode: result.chromeExitCode === undefined ? null : result.chromeExitCode,
      timedOut: !!result.timedOut,
      stderrTail: result.stderrTail || undefined,
    },
    appliedVia: result.used === 'cdp-perf' || result.used === 'cdp-screenshot'
      ? 'window.__lab.set after load'
      : 'URL query params',
    perf: result.perf || null,
    effectiveP: result.effectiveP || null,
    cam: result.cam || null,
    viewport: result.viewport || null,
    labStats: result.stats || null,
    image: null,
    qualityOk: null,
  };
}

function attachImageStats(cases, opts) {
  const entries = [];
  const byId = new Map();
  cases.forEach((c, i) => {
    if (c.pngPath && fs.existsSync(c.pngPath)) {
      const id = String(i);
      entries.push({ id, path: c.pngPath });
      byId.set(id, c);
    }
  });
  if (!entries.length) return { ok: false, reason: 'no PNG files were produced' };
  const analysis = analyzeImages(entries, opts.outDir, { minStddev: opts.minStddev });
  if (!analysis.ok) return analysis;
  for (const entry of analysis.data.entries) {
    const c = byId.get(String(entry.id));
    if (!c) continue;
    if (!entry.ok) {
      c.image = { ok: false, error: entry.error || 'image analysis failed' };
      c.qualityOk = false;
      continue;
    }
    c.image = {
      width: entry.width,
      height: entry.height,
      mean: round(entry.meanLuma, 2),
      meanLuma: round(entry.meanLuma, 2),
      stddev: round(entry.stddevLuma, 2),
      variance: round(entry.varianceLuma, 2),
      meanRgb: entry.meanRgb.map((v) => round(v, 2)),
      stddevRgb: entry.stddevRgb.map((v) => round(v, 2)),
      lumaMin: entry.lumaMin,
      lumaMax: entry.lumaMax,
      blackRatio: round(entry.blackRatio, 6),
      whiteRatio: round(entry.whiteRatio, 6),
      allBlack: entry.allBlack,
      allWhite: entry.allWhite,
      flat: entry.flat,
      ok: entry.qualityOk,
      method: 'Pillow ImageStat',
    };
    c.qualityOk = entry.qualityOk;
  }
  return { ok: true, entries: entries.length, python: analysis.python, data: analysis.data };
}

function makeSheet(cases, opts, log) {
  if (opts.noSheet) return { ok: false, skipped: true, reason: '--no-sheet' };
  const withImages = cases.filter((c) => c.pngPath && fs.existsSync(c.pngPath));
  if (!withImages.length) return { ok: false, skipped: true, reason: 'no images to sheet' };
  const images = withImages.map((c) => ({
    path: c.pngPath,
    label: c.name + (c.preset ? ' [' + c.preset + ']' : ''),
    sub: c.image
      ? 'mean ' + c.image.mean.toFixed(1) + ' sd ' + c.image.stddev.toFixed(1)
      : 'no stats',
  }));
  const output = path.join(opts.outDir, 'sheet.png');
  const res = buildContactSheet({
    images,
    output,
    title: 'CLOUD LAB / ' + opts.tag,
    subtitle: opts.perf ? 'perf run' : 'screenshot run',
    outDir: opts.outDir,
    columns: opts.columns,
    thumbWidth: opts.thumbWidth,
    thumbHeight: opts.thumbHeight,
  });
  if (!res.ok) {
    log.warn('contact sheet skipped: ' + res.reason);
    return { ok: false, reason: res.reason, detail: res };
  }
  return {
    ok: true,
    path: output,
    file: path.basename(output),
    width: res.data.width,
    height: res.data.height,
    count: res.data.count,
    method: 'Pillow',
    python: res.python,
  };
}

function qualitySummary(cases, opts) {
  const withImages = cases.filter((c) => c.pngPath);
  const checked = withImages.filter((c) => c.image && typeof c.image.ok === 'boolean').length;
  const failed = withImages.filter((c) => c.image && c.image.ok === false).length;
  return {
    checked,
    passed: checked - failed,
    failed,
    ok: checked ? failed === 0 : null,
    minStddev: opts.minStddev,
    note: checked ? 'PNG is non-black, non-white and has luma standard deviation >= minStddev.' : 'No image stats were available.',
  };
}

// main-start

function buildReport(opts, cases, sheet, quality, warnings, errors, startedAt, startedMs, mode) {
  const failedCount = cases.filter((c) => !c.ok).length;
  const summary = {
    caseCount: cases.length,
    okCount: cases.length - failedCount,
    failedCount,
    imageCount: cases.filter((c) => c.pngPath).length,
    perfCount: cases.filter((c) => c.perf).length,
    quality,
    ok: cases.length > 0 && failedCount === 0 && quality.ok !== false,
  };
  return {
    schema: 'cloudlab.capture/1',
    tool: 'capture.mjs',
    toolVersion: '1.0.0',
    tag: opts.tag,
    mode,
    dryRun: !!opts.dryRun,
    startedAt,
    finishedAt: nowIso(),
    elapsedMs: Date.now() - startedMs,
    outputDir: opts.outDir,
    chrome: { path: opts.chrome || null },
    options: {
      matrix: opts.matrix,
      set: opts.globalSet,
      dur: opts.dur,
      perf: opts.perf,
      perfSeconds: opts.perfSeconds,
      sampleInterval: opts.sampleInterval,
      width: opts.width,
      height: opts.height,
      settle: opts.settle,
      minStddev: opts.minStddev,
      retries: opts.retries,
      forceCdp: opts.forceCdp,
      noSheet: opts.noSheet,
    },
    matrix: cases.map((c) => c.name),
    cases,
    sheet,
    summary,
    warnings: [...new Set(warnings)],
    errors,
  };
}

async function main() {
  const opts = makeOptions(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP + NL);
    return 0;
  }
  const log = makeLogger(opts);
  const warnings = [];
  const startedAt = nowIso();
  const startedMs = Date.now();
  ensureDir(opts.outDir);
  const specs = expandCases(opts.matrix, opts.globalSet);
  opts.chrome = opts.dryRun ? null : findChrome();
  if (!opts.dryRun && !opts.chrome) {
    throw new Error('Chrome not found. Set CHROME_PATH or install Google Chrome at the usual location.');
  }
  log.info('tag=' + opts.tag + ' mode=' + (opts.perf ? 'perf' : 'screenshot') + ' cases=' + specs.length + ' out=' + opts.outDir);
  for (const spec of specs) {
    if (spec.unknown.length) {
      warnings.push('case ' + spec.name + ': params need CDP / are not URL-mappable: ' + spec.unknown.join(', '));
    }
  }

  if (opts.dryRun) {
    const cases = specs.map((spec) => resultBase(spec, { ok: true, captureMs: 0, used: 'dry-run' }, opts));
    const quality = qualitySummary(cases, opts);
    const sheet = { ok: false, skipped: true, reason: 'dry run' };
    const report = buildReport(opts, cases, sheet, quality, warnings, [], startedAt, startedMs, 'dry-run');
    report.summary.ok = true;
    writeJson(path.join(opts.outDir, 'report.json'), report);
    process.stdout.write((opts.jsonOnly ? JSON.stringify(report) : JSON.stringify(report, null, 2)) + NL);
    return 0;
  }

  const cases = [];
  for (const spec of specs) {
    const needsCdp = caseNeedsCdp(spec, opts);
    log.info('case ' + spec.name + ' preset=' + (spec.preset || '-') + ' via=' + (needsCdp ? 'CDP' : 'CLI screenshot'));
    let result;
    try {
      result = needsCdp ? await cdpCaseOnce(spec, opts, log) : await captureCli(spec, opts, log);
    } catch (err) {
      result = {
        ok: false,
        used: needsCdp ? (opts.perf ? 'cdp-perf' : 'cdp-screenshot') : 'cli-screenshot',
        error: err.message,
        captureMs: 0,
        png: null,
      };
    }
    const rec = resultBase(spec, result, opts);
    cases.push(rec);
    if (rec.ok) log.info('case ' + spec.name + ' ok in ' + fmtDuration(rec.captureMs || 0));
    else log.warn('case ' + spec.name + ' FAILED: ' + rec.error);
  }

  const stats = attachImageStats(cases, opts);
  if (!stats.ok) {
    const msg = 'image quality stats unavailable: ' + (stats.reason || 'unknown');
    warnings.push(msg);
    log.warn(msg);
  } else {
    log.info('image stats: ' + stats.entries + ' PNG(s) analyzed with Pillow ' + (stats.python ? stats.python.pilVersion : '?'));
  }
  const quality = qualitySummary(cases, opts);
  if (quality.ok === false) {
    warnings.push('flat/black/white PNG detected: ' + cases.filter((c) => c.image && c.image.ok === false).map((c) => c.name).join(', '));
  }
  const sheet = makeSheet(cases, opts, log);
  if (sheet.ok) log.info('contact sheet: ' + sheet.path + ' (' + sheet.width + 'x' + sheet.height + ')');
  else if (!sheet.skipped) log.warn('contact sheet unavailable: ' + sheet.reason);
  const errors = cases.filter((c) => !c.ok).map((c) => ({
    case: c.name,
    error: c.error,
    stderrTail: c.chrome && c.chrome.stderrTail ? c.chrome.stderrTail : undefined,
  }));
  if (quality.ok === false) {
    errors.push({ case: null, error: 'image quality assertion failed (flat/black/white PNG)', failed: cases.filter((c) => c.image && c.image.ok === false).map((c) => c.name) });
  }
  const mode = opts.perf ? 'perf' : 'screenshot';
  const report = buildReport(opts, cases, sheet, quality, warnings, errors, startedAt, startedMs, mode);
  writeJson(path.join(opts.outDir, 'report.json'), report);
  log.info('report: ' + path.join(opts.outDir, 'report.json'));
  process.stdout.write((opts.jsonOnly ? JSON.stringify(report) : JSON.stringify(report, null, 2)) + NL);
  return report.summary.ok ? 0 : (opts.assert ? 2 : 1);
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  const report = {
    schema: 'cloudlab.capture/1',
    tool: 'capture.mjs',
    toolVersion: '1.0.0',
    ok: false,
    at: nowIso(),
    error: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : undefined,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + NL);
  process.exitCode = 1;
});
