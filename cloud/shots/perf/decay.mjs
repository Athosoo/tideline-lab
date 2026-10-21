import path from "node:path";
import { pathToFileURL } from "node:url";
import { findChrome, chromeFlags, makeProfileDir, launchChrome, waitForDevTools, waitForPageTarget, CDP, cdpEval, waitForCondition, setViewport, navigate, shutdownChrome, sleep, SHOTS_ROOT, GIFT_INDEX } from "../../tools/_shared.mjs";
const q = process.argv[2] || "bench=1&nogl=1";
const vp = (process.argv[3] || "640x400").split("x").map(Number);
const seconds = Number(process.argv[4] || 60);
const chromePath = findChrome();
const profileDir = makeProfileDir(path.join(SHOTS_ROOT, "perf"), "decay");
const { child, getStderr } = await launchChrome(chromePath, chromeFlags({ width: vp[0], height: vp[1], profileDir, remote: true }));
let cdp = null;
try {
  const { port } = await waitForDevTools(profileDir, { timeoutMs: 30000, getStderr });
  const target = await waitForPageTarget(port);
  cdp = await new CDP(target.webSocketDebuggerUrl).connect(15000);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Performance.enable");
  cdp.on("Runtime.exceptionThrown", (p) => console.log("EXC", JSON.stringify(p.exceptionDetails).slice(0, 900)));
  cdp.on("Log.entryAdded", (p) => console.log("LOG", JSON.stringify(p.entry).slice(0, 400)));
  await setViewport(cdp, vp[0], vp[1], 1);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: 'try { localStorage.setItem("tideline.quality.v1", \'{"mode":"full"}\'); } catch (e) {}' });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: '(function(){ var orig = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type){ if (/webgl/i.test(String(type))) return null; return orig.apply(this, arguments); }; })();' });
  await navigate(cdp, pathToFileURL(GIFT_INDEX).href + "?" + q);
  await waitForCondition(cdp, 'document.readyState === "complete" && !!(window.Weather && window.Weather.state)', (v) => v === true, { timeoutMs: 90000, intervalMs: 300 });
  const start = Date.now();
  let prev = await cdpEval(cdp, "performance.now()");
  while (Date.now() - start < seconds * 1000) {
    await sleep(3000);
    const now = await cdpEval(cdp, "performance.now()");
    const info = await cdpEval(cdp, `(function(){ var PREV=${prev}, NOW=${now};
      var cv = document.getElementById("cloudVolume");
      var tv = window.__tideStats ? window.__tideStats() : null;
      var d = window.__tideelineDiag || window.__tidelineDiag || {};
      return { t: performance.now(), body: document.body.className, tide: tv,
        cw: cv ? cv.width : -1, ch: cv ? cv.height : -1,
        disp: cv ? getComputedStyle(cv).display : "",
        raf: window.__perfMain ? window.__perfMain.report(PREV, NOW).frames : -1,
        diag: Object.assign({}, d) };
    })()`);
    const m = await cdpEval(cdp, "JSON.stringify(window.__weatherCounters)").catch(() => null);
    console.log(((now-prev)/1000).toFixed(2)+"s", "fps~", (info.raf >= 0 ? "n/a" : ""), "tide", JSON.stringify(info.tide), "body", info.body, "cv", info.cw+"x"+info.ch, info.disp, "counters", m);
    prev = now;
  }
} finally { await shutdownChrome({ cdp, child, profileDir, keepProfile: false }).catch(() => null); }