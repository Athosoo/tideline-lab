/* siteshot.mjs — 用 CDP 打开站点、执行一串动作、等 N 秒后截图。
   用法: node siteshot.mjs <url> <out.png> '[{"expr":"...","wait":3000}]' [w,h] */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [, , url, out = "shot.png", stepsJson = "[]", size = "1280,800"] = process.argv;
const { readFileSync } = await import("node:fs");
const steps = JSON.parse(stepsJson.startsWith("@") ? readFileSync(stepsJson.slice(1), "utf8") : stepsJson);
const port = 9400 + Math.floor(Math.random() * 400);
const profile = `C:/Users/18316/AppData/Local/Temp/cdp_${Date.now()}_${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--disable-gpu-sandbox", "--hide-scrollbars", "--mute-audio",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${size}`, "about:blank",
], { stdio: "ignore", detached: false });

async function jjson(path) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}${path}`); if (r.ok) return await r.json(); } catch {}
    await sleep(200);
  }
  throw new Error("CDP did not come up");
}

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

try {
  const targets = await jjson("/json/list");
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });
  await sleep(2500);
  for (const s of steps) {
    const r = await send("Runtime.evaluate", {
      expression: s.expr, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) console.error("EXPR ERROR:", s.expr, JSON.stringify(r.exceptionDetails).slice(0, 400));
    else if (r.result && r.result.value !== undefined) console.log("expr ->", JSON.stringify(r.result.value).slice(0, 300));
    await sleep(s.wait || 1000);
  }
  const probe = await send("Runtime.evaluate", {
    expression: `JSON.stringify({cls:document.body.className,dl:(document.body.dataset||{}).__x||null,
      sunx:getComputedStyle(document.body).getPropertyValue('--sun-x'),
      suny:getComputedStyle(document.body).getPropertyValue('--sun-y'),
      cc:!!window.TideClouds})`,
    returnByValue: true,
  });
  console.log("state:", probe.result && probe.result.value);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved", out);
} catch (e) {
  console.error("FAIL:", e.message);
} finally {
  try { ws && ws.close(); } catch {}
  proc.kill();
  process.exit(0);
}
