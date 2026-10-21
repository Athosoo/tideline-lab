/* labshot.mjs — CDP 截图实验室（精确视口 + 隐藏 HUD + 注入参数）。
   用法: node labshot.mjs <url> <out.png> '@steps.json' <w> <h> [settleMs]
   steps.json = [{expr, wait}]，expr 里可用 window.__lab。 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [, , url, out = "shot.png", stepsArg = "[]", wArg = "1280", hArg = "400", settleArg = "6000"] = process.argv;
const steps = JSON.parse(stepsArg.startsWith("@") ? readFileSync(stepsArg.slice(1), "utf8") : stepsArg);
const W = parseInt(wArg, 10), H = parseInt(hArg, 10), settle = parseInt(settleArg, 10);
const port = 9800 + Math.floor(Math.random() * 150);
const profile = `C:/Users/18316/AppData/Local/Temp/cdplab_${Date.now()}_${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--disable-gpu-sandbox", "--hide-scrollbars", "--mute-audio",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, "about:blank",
], { stdio: "ignore" });
async function jjson(path) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}${path}`); if (r.ok) return await r.json(); } catch {}
    await sleep(200);
  }
  throw new Error("CDP did not come up");
}
let ws, msgId = 0; const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId; ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
try {
  const targets = await jjson("/json/list");
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(2500);
  await send("Runtime.evaluate", { expression: "document.querySelectorAll('.hud,.panel,#err').forEach(e=>e.style.display='none');", returnByValue: true });
  for (const s of steps) {
    const r = await send("Runtime.evaluate", { expression: s.expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) console.error("EXPR ERROR:", JSON.stringify(r.exceptionDetails).slice(0, 500));
    else if (r.result && r.result.value !== undefined) console.log("expr ->", JSON.stringify(r.result.value).slice(0, 200));
    await sleep(s.wait || 1000);
  }
  await sleep(settle);
  const probe = await send("Runtime.evaluate", { expression: `JSON.stringify(window.__lab ? window.__lab.stats() : null)`, returnByValue: true });
  console.log("stats:", probe.result && probe.result.value);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved", out);
} catch (e) { console.error("FAIL:", e.message); }
finally { try { ws && ws.close(); } catch {} proc.kill(); process.exit(0); }
