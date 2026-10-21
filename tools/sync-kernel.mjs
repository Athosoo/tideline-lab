#!/usr/bin/env node
/* sync-kernel.mjs — 把 kernel.glsl 注入 lab 与 ship 的 CLOUD-KERNEL 标记区（所有出现处）。
   开发期工具；站点本身没有任何构建步骤。
   用法: node _lab/tools/sync-kernel.mjs [--check]                        */
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KERNEL = ROOT + "_lab/cloud/kernel.glsl";
const TARGETS = [ROOT + "_lab/cloud/index.html", ROOT + "GIFT/js/clouds.js"];
const BEGIN = ">>> CLOUD-KERNEL:BEGIN";
const END = "<<< CLOUD-KERNEL:END";
const check = process.argv.includes("--check");

const kernel = readFileSync(KERNEL, "utf8").replace(/\r\n/g, "\n").trimEnd();
let bad = 0;

for (const file of TARGETS) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { console.log("skip (missing):", file); continue; }
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  const norm = src.replace(/\r\n/g, "\n");

  let out = "", cursor = 0, n = 0;
  for (;;) {
    const i = norm.indexOf(BEGIN, cursor);
    if (i < 0) break;
    const j = norm.indexOf(END, i);
    if (j < 0) break;
    const lineStart = norm.lastIndexOf("\n", i) + 1;
    const indent = /^([ \t]*)/.exec(norm.slice(lineStart))[1];
    const body = kernel.split("\n").map((l) => (l.length ? indent + l : l)).join("\n");
    /* 保留 END 标记自身的行前缀（例如 "// "），否则它会被当成着色器代码 */
    const tail = norm.slice(norm.lastIndexOf("\n", j) + 1, j + END.length);
    out += norm.slice(cursor, i + BEGIN.length) + "\n" + body + "\n" + indent + tail;
    cursor = j + END.length;
    n++;
  }
  out += norm.slice(cursor);

  if (n === 0) { console.log("MISSING MARKERS:", file); bad++; continue; }
  const changed = out !== norm;
  if (changed && !check) writeFileSync(file, out.replace(/\n/g, nl));
  console.log((changed ? (check ? "WOULD UPDATE " : "updated  ") : "up-to-date  ") + file +
              "  (" + n + " slot(s), " + kernel.split("\n").length + " kernel lines)");
}
process.exit(bad ? 1 : 0);
