#!/usr/bin/env node
// TIDELINE site probe: read --sun-x/--sun-y, #celestial visibility, body classes,
// canvas readback and screenshot-region brightness at multiple times.
// Writes only below _lab/shots/site/<tag>/ by default.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SHOTS_ROOT, WORKSPACE_ROOT, GIFT_INDEX, parseArgv, argList, boolArg, numArg,
  mergeKvArgs, parseTimeSpec, findChrome, chromeFlags, installSignalHooks,
  launchChrome, waitForDevTools, waitForPageTarget, CDP, cdpEval, waitForCondition,
  waitFrames, setViewport, captureScreenshot, navigate, shutdownChrome, ensureDir,
  writeJson, fileSize, isPng, analyzeImages, makeProfileDir, nowIso, safeFileStem,
  uniqueName, fmtDuration, sleep, tailString, round, pctToNumber, NL,
} from './_shared.mjs';

installSignalHooks();

const HELP = [
  'TIDELINE site probe',
  '',
  'Usage:',
  '  node probe.mjs --tag site1 --times 06:09,09:00,11:57,14:48,17:56,21:04',
  '  node probe.mjs --tag site1 --times 09:00 --repeat 3 --json-only',
  '  node probe.mjs --tag site1 --times 06:09 --element "#celestial" --element "#gallery"',
  '',
  'Options:',
  '  --tag NAME             output folder under _lab/shots/site/NAME',
  '  --times LIST           comma list: HH:MM, H:MM, HHMM, decimal hours, or now',
  '  --repeat N             repeat every time N times (default 1)',
  '  --element SELECTOR     element whose screenshot-region brightness is measured',
  '                         (repeatable; default #celestial)',
  '  --state k=v,k=v        override fields on window.Weather.state once after load',
  '  --settle MS            settle time after setting the clock (default 1200)',
  '  --boot-settle MS       extra wait after the site is ready (default 2000)',
  '  --load-timeout MS      page readiness timeout (default 90000)',
  '  --width N --height N   viewport (default 1280x800)',
  '  --min-stddev N         flat screenshot threshold (default 2.0)',
  '  --assert               exit 2 when screenshots are flat/black/white',
  '  --json-only            only JSON on stdout (diagnostics go to stderr)',
  '  --dry-run              plan cases without launching Chrome',
  '  --keep-profile         keep temporary Chrome profile for debugging',
  '  --help                 this text',
].join(NL);

function stampTag() {
  return nowIso().replaceAll(':', '').replaceAll('-', '').replace('T', '-').slice(0, 15);
}

function makeOptions(argv) {
  const args = parseArgv(argv);
  if (args.help) return { help: true };
  const tag = safeFileStem(args.tag === undefined ? 'site-' + stampTag() : args.tag, 'site');
  const outDir = args.out
    ? path.resolve(WORKSPACE_ROOT, String(args.out))
    : path.join(SHOTS_ROOT, 'site', tag);
  const timeTokens = argList(args.times);
  const times = (timeTokens.length ? timeTokens : ['now']).map((t) => parseTimeSpec(t));
  const elements = argList(args.element);
  return {
    help: false,
    tag,
    outDir,
    siteUrl: pathToFileURL(GIFT_INDEX).href,
    times,
    repeat: Math.max(1, Math.min(20, Math.floor(numArg(args.repeat, 1)))),
    elements: elements.length ? elements : ['#celestial'],
    state: mergeKvArgs(args.state),
    settle: Math.max(0, numArg(args.settle, 1200)),
    bootSettle: Math.max(0, numArg(args['boot-settle'], 2000)),
    loadTimeout: Math.max(5000, numArg(args['load-timeout'], 90000)),
    width: Math.max(320, Math.floor(numArg(args.width, 1280))),
    height: Math.max(240, Math.floor(numArg(args.height, 800))),
    minStddev: Math.max(0, numArg(args['min-stddev'], 2)),
    assert: boolArg(args.assert, false),
    jsonOnly: boolArg(args['json-only'], false),
    dryRun: boolArg(args['dry-run'], false),
    keepProfile: boolArg(args['keep-profile'], false),
    noPil: boolArg(args['no-pil'], false),
  };
}

function makeLogger(opts) {
  return {
    info(message) { if (!opts.jsonOnly) process.stderr.write('[probe] ' + message + NL); },
    warn(message) { if (!opts.jsonOnly) process.stderr.write('[probe] WARN ' + message + NL); },
  };
}

function expandProbeCases(opts) {
  const used = new Set();
  const out = [];
  for (const time of opts.times) {
    for (let r = 1; r <= opts.repeat; r += 1) {
      const base = time.label + (opts.repeat > 1 ? '_r' + r : '');
      const name = uniqueName(safeFileStem(base, 'case'), used);
      out.push({ name, time, repeat: r });
    }
  }
  return out;
}

const READY_EXPR = `(function(){
  try {
    var body = document.body;
    var w = window.Weather;
    var el = document.getElementById('celestial');
    /* --sun-* 现在写在 .atmosphere 上（缩小样式失效范围），从它上面读。 */
    var cs = body ? getComputedStyle(document.querySelector('.atmosphere') || body) : null;
    return {
      ready: document.readyState,
      weather: !!(w && w.state),
      celestial: !!el,
      sunX: cs ? cs.getPropertyValue('--sun-x').trim() : '',
      bodyClass: body ? body.className : '',
      fonts: document.fonts ? document.fonts.status : 'n/a',
      innerWidth: innerWidth,
      innerHeight: innerHeight
    };
  } catch (err) { return { error: String(err) }; }
})()`;

const WEATHER_API_EXPR = `(function(){
  var w = window.Weather;
  return {
    available: !!w,
    keys: w ? Object.keys(w) : [],
    dedicatedSetTime: !!(w && (typeof w.setTime === 'function' || typeof w.setTimeOfDay === 'function')),
    stateKeys: w && w.state ? Object.keys(w.state) : [],
    timeSlider: !!document.getElementById('timeSlider'),
    weatherSlider: !!document.getElementById('weatherSlider'),
    cloudSlider: !!document.getElementById('cloudSlider')
  };
})()`;

function setTimeExpr(time) {
  if (time.kind === 'now') {
    return `(function(){
      var w = window.Weather;
      if (!w || !w.state) return { ok: false, method: 'none', error: 'window.Weather missing' };
      w.state.manualTime = false;
      w.state.autoTime = true;
      w.state.elevationOffset = 0;
      if (typeof w.readSystemTime === 'function') w.readSystemTime();
      if (typeof w.update === 'function') w.update(0.016, performance.now());
      return { ok: true, method: 'Weather.readSystemTime + autoTime', dedicatedApi: false };
    })()`;
  }
  const hours = time.hours;
  return `(function(){
    var w = window.Weather;
    if (w && w.state) {
      w.state.manualTime = true;
      w.state.autoTime = false;
      w.state.elevationOffset = 0;
      w.state.timeTarget = ${hours};
      w.state.timeOfDay = ${hours};
      if (typeof w.update === 'function') w.update(0.016, performance.now());
      return {
        ok: true,
        method: 'Weather.state.manualTime/autoTime/timeTarget/timeOfDay + Weather.update()',
        dedicatedApi: !!(typeof w.setTime === 'function' || typeof w.setTimeOfDay === 'function')
      };
    }
    var slider = document.getElementById('timeSlider');
    if (slider) {
      slider.value = String(${hours} / 24 * 100);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, method: 'timeSlider input event fallback', dedicatedApi: false };
    }
    return { ok: false, method: 'none', error: 'no window.Weather and no #timeSlider' };
  })()`;
}

async function openSiteSession(opts, log) {
  const profileDir = makeProfileDir(opts.outDir, 'site');
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
    await navigate(cdp, opts.siteUrl, 60000);
    const ready = await waitForCondition(
      cdp,
      READY_EXPR,
      (v) => v && v.ready === 'complete' && v.weather && v.celestial && v.sunX,
      { timeoutMs: opts.loadTimeout, intervalMs: 500, label: 'TIDELINE ready' },
    );
    log.info('site ready in ' + fmtDuration(ready.elapsedMs) + ' (' + ready.value.innerWidth + 'x' + ready.value.innerHeight + ')');
    try {
      await waitForCondition(cdp, `(document.fonts ? document.fonts.status : 'n/a')`, (v) => v === 'loaded' || v === 'n/a', { timeoutMs: 15000, intervalMs: 300, label: 'fonts' });
    } catch { /* fonts are best effort */ }
    let boot = { seaBundle: false, lite: false, className: '' };
    try {
      const sea = await waitForCondition(
        cdp,
        `({ sea: document.body.classList.contains('has-sea-bundle'), lite: document.body.classList.contains('is-lite'), className: document.body.className })`,
        (v) => v && (v.sea || v.lite),
        { timeoutMs: 20000, intervalMs: 500, label: 'has-sea-bundle or is-lite' },
      );
      boot = sea.value;
    } catch (err) {
      log.warn('has-sea-bundle / is-lite not observed: ' + err.message);
    }
    if (opts.bootSettle > 0) await sleep(opts.bootSettle);
    const api = await cdpEval(cdp, WEATHER_API_EXPR);
    const viewport = await cdpEval(cdp, `({ innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio, scrollY: scrollY, visibilityState: document.visibilityState })`);
    return { cdp, child: launched.child, profileDir, api, boot, viewport, ready: ready.value };
  } catch (err) {
    await shutdownChrome({ cdp, child: launched.child, profileDir, keepProfile: opts.keepProfile });
    throw err;
  }
}

function snapshotExpr(elements) {
  return `(function(){
    try { window.scrollTo(0, 0); } catch (err) { /* no-op */ }
    var body = document.body;
    var cs = getComputedStyle(document.querySelector('.atmosphere') || body);
    var el = document.getElementById('celestial');
    var rect = el ? el.getBoundingClientRect() : null;
    var vw = innerWidth;
    var vh = innerHeight;
    function rectObj(r) {
      if (!r) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    function inside(r) {
      return !!r && r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
    }
    var selectors = ${JSON.stringify(elements)};
    var elementInfo = selectors.map(function(sel) {
      var node = document.querySelector(sel);
      if (!node) return { selector: sel, found: false, rect: null, visible: false, inside: false };
      var b = node.getBoundingClientRect();
      var st = getComputedStyle(node);
      var visible = st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 && b.width > 0 && b.height > 0;
      return {
        selector: sel,
        found: true,
        rect: rectObj(b),
        visible: visible,
        inside: inside(b),
        style: { display: st.display, visibility: st.visibility, opacity: st.opacity }
      };
    });
    var w = window.Weather;
    var st = w && w.state ? w.state : null;
    var weatherState = st ? {
      timeOfDay: st.timeOfDay,
      timeTarget: st.timeTarget,
      sunElevation: st.sunElevation,
      sunElevationRaw: st.sunElevationRaw,
      sunAzimuth: st.sunAzimuth,
      isNight: st.isNight,
      cloudCover: st.cloudCover,
      overcast: st.overcast,
      storminess: st.storminess,
      manualTime: st.manualTime,
      autoTime: st.autoTime,
      source: st.source
    } : null;
    return {
      ready: document.readyState,
      innerWidth: vw,
      innerHeight: vh,
      dpr: devicePixelRatio,
      scrollY: scrollY,
      sun: {
        xRaw: cs.getPropertyValue('--sun-x').trim(),
        yRaw: cs.getPropertyValue('--sun-y').trim(),
        sizeRaw: cs.getPropertyValue('--sun-size').trim(),
        colorRaw: cs.getPropertyValue('--sun-color').trim(),
        alphaRaw: cs.getPropertyValue('--sun-alpha').trim()
      },
      celestial: {
        rect: rectObj(rect),
        inside: inside(rect),
        visible: !!(el && rect && rect.width > 0 && rect.height > 0),
        margins: rect ? { left: rect.left, top: rect.top, right: vw - rect.right, bottom: vh - rect.bottom } : null,
        className: el ? el.className : null
      },
      body: {
        className: body.className,
        classList: Array.from(body.classList),
        flags: {
          hasCloudVolume: body.classList.contains('has-cloud-volume'),
          hasSeaBundle: body.classList.contains('has-sea-bundle'),
          isLite: body.classList.contains('is-lite')
        }
      },
      elements: elementInfo,
      weatherState: weatherState,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
    };
  })()`;
}

const CANVAS_PROBE_EXPR = `new Promise(function(resolve) {
  var nodes = Array.prototype.slice.call(document.querySelectorAll('canvas'));
  var metas = nodes.map(function(c, i) {
    var r = c.getBoundingClientRect();
    var st = getComputedStyle(c);
    var visible = st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 && r.width > 0 && r.height > 0;
    return {
      index: i, node: c, id: c.id || '', className: c.className || '',
      width: c.width, height: c.height,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      visible: visible, display: st.display, opacity: st.opacity
    };
  });
  function statsFrom(data, w, h) {
    var total = w * h;
    var step = Math.max(1, Math.floor(Math.sqrt(total / 20000)));
    var n = 0, sr = 0, sg = 0, sb = 0, sa = 0, sl = 0, sl2 = 0;
    var lmin = 255, lmax = 0, black = 0, opaque = 0, opaqueL = 0;
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        var i = (y * w + x) * 4;
        var rr = data[i], gg = data[i + 1], bb = data[i + 2], aa = data[i + 3];
        var l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
        n += 1; sr += rr; sg += gg; sb += bb; sa += aa;
        sl += l; sl2 += l * l;
        if (l < lmin) lmin = l;
        if (l > lmax) lmax = l;
        if (l < 8) black += 1;
        if (aa > 0) { opaque += 1; opaqueL += l; }
      }
    }
    if (!n) return null;
    var mean = sl / n;
    var sd = Math.sqrt(Math.max(0, sl2 / n - mean * mean));
    return {
      sampleCount: n,
      meanRgb: [sr / n, sg / n, sb / n],
      meanLuma: mean,
      stddevLuma: sd,
      varianceLuma: sd * sd,
      lumaMin: lmin, lumaMax: lmax,
      alphaMean: sa / n,
      blackRatio: black / n,
      opaquePixels: opaque,
      meanLumaOpaque: opaque ? opaqueL / opaque : null,
      allZero: (sr + sg + sb + sa) === 0
    };
  }
  function readOne(meta) {
    var c = meta.node;
    var out = {
      id: meta.id, className: meta.className, index: meta.index,
      width: meta.width, height: meta.height, rect: meta.rect,
      visible: meta.visible, display: meta.display, opacity: meta.opacity,
      mode: null, method: null, readable: false, error: null, stats: null
    };
    if (!meta.visible) { out.reason = 'not visible'; return out; }
    var gl = null;
    var glError = null;
    try {
      if (c.id === 'oceanCanvas' || String(c.className || '').indexOf('ocean') >= 0) {
        gl = c.getContext('webgl2') || c.getContext('webgl');
      }
    } catch (err) { glError = String(err && err.message ? err.message : err); }
    try {
      if (gl) {
        out.mode = 'webgl'; out.method = 'webgl-readPixels';
        var w = gl.drawingBufferWidth;
        var h = gl.drawingBufferHeight;
        out.width = w; out.height = h;
        var data = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
        out.stats = statsFrom(data, w, h);
      } else {
        var ctx = c.getContext('2d');
        if (ctx) {
          out.mode = '2d'; out.method = '2d-getImageData';
          var w2 = c.width, h2 = c.height;
          out.stats = statsFrom(ctx.getImageData(0, 0, w2, h2).data, w2, h2);
        } else {
          out.error = glError || 'no 2d or webgl context available';
        }
      }
    } catch (err) {
      out.error = String(err && err.message ? err.message : err);
    }
    if (out.stats) {
      out.readable = out.mode === '2d' ? true : !out.stats.allZero;
      if (!out.readable) out.reason = 'all-zero WebGL readback; preserveDrawingBuffer=false may hide the frame';
    } else if (!out.error) {
      out.error = 'no pixel stats';
    }
    return out;
  }
  function score(r) {
    if (!r || !r.stats) return -1;
    if (r.stats.allZero) return 0;
    return 1 + r.stats.stddevLuma;
  }
  var best = {};
  function capture() {
    for (var i = 0; i < metas.length; i += 1) {
      var m = metas[i];
      var r = readOne(m);
      var key = String(m.index);
      if (score(r) > score(best[key])) best[key] = r;
    }
  }
  requestAnimationFrame(function() {
    capture();
    requestAnimationFrame(function() {
      capture();
      requestAnimationFrame(function() {
        capture();
        var list = metas.map(function(m) {
          var key = String(m.index);
          if (best[key]) return best[key];
          return {
            id: m.id, className: m.className, index: m.index, width: m.width, height: m.height,
            rect: m.rect, visible: m.visible, display: m.display, opacity: m.opacity,
            mode: null, method: null, readable: false, error: null, stats: null, reason: 'not sampled'
          };
        });
        resolve({ attempts: 3, canvases: list });
      });
    });
  });
})`;

async function applyStateOverride(cdp, state, log) {
  if (!state || !Object.keys(state).length) return { ok: true, applied: null };
  const expr = `(function(){
    var w = window.Weather;
    if (!w || !w.state) return { ok: false, error: 'window.Weather.state missing' };
    Object.assign(w.state, ${JSON.stringify(state)});
    if (typeof w.update === 'function') w.update(0.016, performance.now());
    return { ok: true, applied: ${JSON.stringify(state)} };
  })()`;
  const result = await cdpEval(cdp, expr);
  if (!result || !result.ok) log.warn('Weather.state override failed: ' + (result && result.error ? result.error : 'unknown'));
  else log.info('Weather.state override applied: ' + JSON.stringify(state));
  return result;
}

async function settleSun(cdp, time, opts, log) {
  const expr = `(function(){
    var cs = getComputedStyle(document.body);
    var w = window.Weather;
    return {
      sunX: cs.getPropertyValue('--sun-x').trim(),
      sunY: cs.getPropertyValue('--sun-y').trim(),
      target: w && w.state ? w.state.timeTarget : null,
      clock: w && w.state ? w.state.timeOfDay : null,
      sunElevation: w && w.state ? w.state.sunElevation : null
    };
  })()`;
  try {
    const result = await waitForCondition(
      cdp,
      expr,
      (v) => {
        if (!v || !v.sunX) return false;
        if (time.kind === 'now') return true;
        return Number.isFinite(v.target) && Math.abs(v.target - time.hours) < 0.01;
      },
      { timeoutMs: 12000, intervalMs: 200, label: 'sun vars after setting ' + time.label },
    );
    return result.value;
  } catch (err) {
    log.warn('sun vars did not settle for ' + time.label + ': ' + err.message);
    return null;
  }
}

async function runProbeCase(cdp, probeCase, opts, log) {
  const started = Date.now();
  const time = probeCase.time;
  const pngPath = path.join(opts.outDir, probeCase.name + '.png');
  try { fs.rmSync(pngPath, { force: true }); } catch { /* no-op */ }
  const setTime = await cdpEval(cdp, setTimeExpr(time));
  const sunSettled = await settleSun(cdp, time, opts, log);
  if (opts.settle > 0) await sleep(opts.settle);
  try { await waitFrames(cdp, 2, 25000); }
  catch (err) { log.warn(probeCase.name + ': frame wait before snapshot: ' + err.message); }
  const snapshot = await cdpEval(cdp, snapshotExpr(opts.elements));
  let canvas = { attempts: 0, canvases: [] };
  try {
    canvas = await cdpEval(cdp, CANVAS_PROBE_EXPR, { timeoutMs: 90000 });
  } catch (err) {
    canvas = { attempts: 0, canvases: [], error: err.message };
    log.warn(probeCase.name + ': canvas readback failed: ' + err.message);
  }
  const shot = await captureScreenshot(cdp, pngPath);
  const sunX = pctToNumber(snapshot.sun.xRaw);
  const sunY = pctToNumber(snapshot.sun.yRaw);
  const fixedTimeFailed = time.kind !== 'now' && (!setTime || !setTime.ok);
  return {
    name: probeCase.name,
    time: time.label,
    timeRaw: time.raw,
    kind: time.kind,
    hours: time.hours,
    repeat: probeCase.repeat,
    capturedAt: nowIso(),
    png: shot.png ? path.basename(pngPath) : null,
    pngPath: shot.png ? pngPath : null,
    pngBytes: shot.bytes,
    captureMs: Date.now() - started,
    ok: !fixedTimeFailed && shot.png,
    error: fixedTimeFailed
      ? 'could not set requested time: ' + (setTime && setTime.error ? setTime.error : 'unknown')
      : (shot.png ? null : 'screenshot was not a PNG'),
    setTime,
    sunSettled,
    sun: Object.assign({}, snapshot.sun, { xPct: sunX, yPct: sunY }),
    celestial: snapshot.celestial,
    inside: snapshot.celestial.inside,
    body: snapshot.body,
    elements: snapshot.elements,
    weatherState: snapshot.weatherState,
    viewport: { width: snapshot.innerWidth, height: snapshot.innerHeight, dpr: snapshot.dpr, scrollY: snapshot.scrollY },
    reducedMotion: snapshot.reducedMotion,
    canvas,
    brightness: null,
    qualityOk: null,
  };
}

function normalizeImageStats(entry) {
  if (!entry || !entry.ok) return { ok: false, error: entry && entry.error ? entry.error : 'no stats' };
  return {
    width: entry.width,
    height: entry.height,
    crop: entry.crop,
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
}

function attachBrightness(cases, opts, log) {
  if (opts.noPil) return { ok: false, reason: '--no-pil' };
  const entries = [];
  const map = new Map();
  cases.forEach((c, i) => {
    if (c.pngPath && fs.existsSync(c.pngPath)) {
      const id = i + ':shot';
      entries.push({ id, path: c.pngPath });
      map.set(id, c);
    }
    (c.elements || []).forEach((e, ei) => {
      if (!e || !e.found || !e.rect || !e.visible) return;
      const id = i + ':el:' + ei;
      entries.push({ id, path: c.pngPath, rect: e.rect, viewport: c.viewport });
      map.set(id, c);
    });
  });
  if (!entries.length) return { ok: false, reason: 'no PNGs / visible elements to analyze' };
  const analysis = analyzeImages(entries, opts.outDir, { minStddev: opts.minStddev });
  if (!analysis.ok) return analysis;
  const byId = new Map(analysis.data.entries.map((e) => [String(e.id), e]));
  cases.forEach((c, i) => {
    const canvases = c.canvas && c.canvas.canvases ? c.canvas.canvases : [];
    c.brightness = {
      source: 'Page.captureScreenshot + Pillow region stats',
      shot: null,
      elements: (c.elements || []).map((e, ei) => {
        const entry = byId.get(i + ':el:' + ei);
        return {
          selector: e.selector,
          found: e.found,
          visible: e.visible,
          rect: e.rect,
          stats: entry ? normalizeImageStats(entry) : null,
        };
      }),
      canvasFallback: canvases.map((cv) => ({
        id: cv.id,
        mode: cv.mode,
        readable: cv.readable,
        visible: cv.visible,
        meanLuma: cv.stats ? round(cv.stats.meanLuma, 2) : null,
        stddevLuma: cv.stats ? round(cv.stats.stddevLuma, 2) : null,
        alphaMean: cv.stats ? round(cv.stats.alphaMean, 4) : null,
        error: cv.error,
        reason: cv.reason,
      })),
    };
    const shot = byId.get(i + ':shot');
    if (shot) {
      c.brightness.shot = normalizeImageStats(shot);
      c.qualityOk = c.brightness.shot.ok;
    }
  });
  return { ok: true, checked: entries.length, python: analysis.python, data: analysis.data };
}

function qualitySummary(cases, opts) {
  const shots = cases.map((c) => c.brightness && c.brightness.shot).filter(Boolean);
  const checked = shots.length;
  const failed = shots.filter((s) => s.ok === false).length;
  return {
    checked,
    passed: checked - failed,
    failed,
    flat: shots.filter((s) => s.flat).length,
    allBlack: shots.filter((s) => s.allBlack).length,
    allWhite: shots.filter((s) => s.allWhite).length,
    ok: checked ? failed === 0 : null,
    minStddev: opts.minStddev,
    note: 'Full-screen PNG is checked for non-black / non-white / luma stddev >= minStddev.',
  };
}

function summarizeCases(cases, quality) {
  const failedCount = cases.filter((c) => !c.ok).length;
  const bodyClasses = [...new Set(cases.map((c) => c.body && c.body.className).filter(Boolean))];
  const flagsSeen = {
    hasCloudVolume: cases.some((c) => c.body && c.body.flags && c.body.flags.hasCloudVolume),
    hasSeaBundle: cases.some((c) => c.body && c.body.flags && c.body.flags.hasSeaBundle),
    isLite: cases.some((c) => c.body && c.body.flags && c.body.flags.isLite),
  };
  return {
    caseCount: cases.length,
    okCount: cases.length - failedCount,
    failedCount,
    sunVarReadCount: cases.filter((c) => Number.isFinite(c.sun && c.sun.xPct) && Number.isFinite(c.sun && c.sun.yPct)).length,
    insideCount: cases.filter((c) => c.celestial && c.celestial.inside).length,
    canvasReadableCount: cases.filter((c) => c.canvas && Array.isArray(c.canvas.canvases) && c.canvas.canvases.some((cv) => cv.visible && cv.readable && cv.stats && !cv.stats.allZero)).length,
    bodyClasses,
    flagsSeen,
    quality,
    ok: cases.length > 0 && failedCount === 0 && quality.ok !== false,
  };
}

function buildReport(opts, cases, session, warnings, errors, startedAt, startedMs, mode) {
  const quality = qualitySummary(cases, opts);
  const summary = summarizeCases(cases, quality);
  const weatherApi = session && session.api ? Object.assign({}, session.api, {
    probeMethod: 'Weather.state.manualTime/autoTime/timeTarget/timeOfDay + Weather.update()',
    dedicatedSetTime: false,
    note: 'GIFT/js/weather.js exposes window.Weather (state, update, helpers) but no setTime()/setTimeOfDay() helper was found. The probe writes Weather.state and calls Weather.update().',
  }) : null;
  return {
    schema: 'tidelime.probe/1',
    tool: 'probe.mjs',
    toolVersion: '1.0.0',
    tag: opts.tag,
    mode,
    site: opts.siteUrl,
    startedAt,
    finishedAt: nowIso(),
    elapsedMs: Date.now() - startedMs,
    outputDir: opts.outDir,
    chrome: { path: opts.chrome || null },
    options: {
      times: opts.times.map((t) => ({ raw: t.raw, label: t.label, kind: t.kind, hours: t.hours })),
      repeat: opts.repeat,
      width: opts.width,
      height: opts.height,
      settle: opts.settle,
      bootSettle: opts.bootSettle,
      loadTimeout: opts.loadTimeout,
      elements: opts.elements,
      state: opts.state,
      minStddev: opts.minStddev,
      noPil: opts.noPil,
    },
    weatherApi,
    boot: session ? session.boot : null,
    viewport: session ? session.viewport : { innerWidth: opts.width, innerHeight: opts.height, dpr: 1, scrollY: 0 },
    cases,
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
  const planned = expandProbeCases(opts);
  opts.chrome = opts.dryRun ? null : findChrome();
  if (!opts.dryRun && !opts.chrome) {
    throw new Error('Chrome not found. Set CHROME_PATH or install Google Chrome at the usual location.');
  }
  log.info('tag=' + opts.tag + ' times=' + opts.times.map((t) => t.label).join(',') + ' repeat=' + opts.repeat + ' cases=' + planned.length);

  if (opts.dryRun) {
    const cases = planned.map((p) => ({
      name: p.name,
      time: p.time.label,
      timeRaw: p.time.raw,
      kind: p.time.kind,
      hours: p.time.hours,
      repeat: p.repeat,
      ok: true,
      png: null,
      setTime: null,
      sun: { xPct: null, yPct: null },
      celestial: null,
      inside: null,
      body: null,
      elements: [],
      canvas: { attempts: 0, canvases: [] },
      brightness: null,
    }));
    const report = buildReport(opts, cases, null, warnings, [], startedAt, startedMs, 'dry-run');
    report.summary.ok = true;
    writeJson(path.join(opts.outDir, 'report.json'), report);
    process.stdout.write((opts.jsonOnly ? JSON.stringify(report) : JSON.stringify(report, null, 2)) + NL);
    return 0;
  }

  log.info('opening ' + opts.siteUrl);
  const session = await openSiteSession(opts, log);
  const cases = [];
  try {
    const stateOverride = await applyStateOverride(session.cdp, opts.state, log);
    if (stateOverride && stateOverride.ok === false) warnings.push('Weather.state override failed: ' + stateOverride.error);
    for (const probeCase of planned) {
      log.info('case ' + probeCase.name + ' (' + probeCase.time.raw + ')');
      try {
        const rec = await runProbeCase(session.cdp, probeCase, opts, log);
        cases.push(rec);
        if (rec.ok) log.info('case ' + probeCase.name + ' ok: sunX=' + rec.sun.xPct + '% sunY=' + rec.sun.yPct + '% inside=' + rec.inside + ' class=' + (rec.body ? rec.body.className : '-'));
        else log.warn('case ' + probeCase.name + ' FAILED: ' + rec.error);
      } catch (err) {
        cases.push({
          name: probeCase.name,
          time: probeCase.time.label,
          timeRaw: probeCase.time.raw,
          kind: probeCase.time.kind,
          hours: probeCase.time.hours,
          repeat: probeCase.repeat,
          ok: false,
          error: err.message,
          png: null,
          pngPath: null,
          pngBytes: 0,
          captureMs: 0,
          setTime: null,
          sun: { xPct: null, yPct: null },
          celestial: null,
          inside: null,
          body: null,
          elements: [],
          canvas: { attempts: 0, canvases: [] },
          brightness: null,
        });
        log.warn('case ' + probeCase.name + ' FAILED: ' + err.message);
      }
    }
  } finally {
    const cleanup = await shutdownChrome({ cdp: session.cdp, child: session.child, profileDir: session.profileDir, keepProfile: opts.keepProfile });
    if (!cleanup.removed && !opts.keepProfile) log.warn('Chrome profile was not fully removed: ' + (cleanup.error || session.profileDir));
  }

  const stats = attachBrightness(cases, opts, log);
  if (!stats.ok) {
    warnings.push('screenshot brightness stats unavailable: ' + (stats.reason || 'unknown'));
    log.warn('screenshot brightness stats unavailable: ' + (stats.reason || 'unknown'));
  } else {
    log.info('brightness stats: ' + stats.checked + ' region(s) measured with Pillow ' + (stats.python ? stats.python.pilVersion : '?'));
  }
  const quality = qualitySummary(cases, opts);
  const errors = cases.filter((c) => !c.ok).map((c) => ({
    case: c.name,
    error: c.error,
    setTime: c.setTime && c.setTime.ok === false ? c.setTime : undefined,
  }));
  if (quality.ok === false) {
    errors.push({
      case: null,
      error: 'flat/black/white screenshot assertion failed',
      failed: cases.filter((c) => c.brightness && c.brightness.shot && c.brightness.shot.ok === false).map((c) => c.name),
    });
  }
  const report = buildReport(opts, cases, session, warnings, errors, startedAt, startedMs, 'probe');
  report.summary = summarizeCases(cases, quality);
  writeJson(path.join(opts.outDir, 'report.json'), report);
  log.info('report: ' + path.join(opts.outDir, 'report.json'));
  process.stdout.write((opts.jsonOnly ? JSON.stringify(report) : JSON.stringify(report, null, 2)) + NL);
  return report.summary.ok ? 0 : (opts.assert ? 2 : 1);
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  const report = {
    schema: 'tidelime.probe/1',
    tool: 'probe.mjs',
    toolVersion: '1.0.0',
    ok: false,
    at: nowIso(),
    error: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : undefined,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + NL);
  process.exitCode = 1;
});
