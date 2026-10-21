#!/usr/bin/env node
/* imgdiff.mjs — 两张同尺寸 PNG 的像素差统计（Pillow）。
 * node _lab/tools/imgdiff.mjs A.png B.png [--crop x,y,w,h] [--json-only]
 * 输出 meanAbsDiff(0-255) / maxDiff / 超过 2、8、16 的像素占比 / 差异包围盒。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { findPython, parseArgv, numArg, boolArg, argList } from './_shared.mjs';

const args = parseArgv(process.argv.slice(2));
const files = args._ || [];
if (files.length < 2) { process.stderr.write('usage: node imgdiff.mjs A.png B.png [--crop x,y,w,h]\n'); process.exit(1); }
const crop = args.crop ? String(args.crop).split(',').map(Number) : null;
const python = findPython();
if (!python) { process.stderr.write('imgdiff: Python + Pillow not available\n'); process.exit(1); }
const code = `
import sys, json
from PIL import Image, ImageChops, ImageStat
a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
crop = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
if crop:
    box = (crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3])
    a = a.crop(box); b = b.crop(box)
if a.size != b.size:
    print(json.dumps({'ok': False, 'reason': 'size mismatch', 'a': a.size, 'b': b.size}))
    sys.exit(0)
diff = ImageChops.difference(a, b)
stat = ImageStat.Stat(diff)
mean = stat.mean
extrema = diff.getextrema()
maxd = max(e[1] for e in extrema)
gray = diff.convert('L')
hist = gray.histogram()
total = gray.width * gray.height
over = lambda t: sum(hist[t+1:]) / total
bbox = diff.getbbox()
print(json.dumps({
    'ok': True,
    'width': a.width, 'height': a.height,
    'meanAbsDiff': round(sum(mean) / 3.0, 4),
    'meanPerChannel': [round(v, 4) for v in mean],
    'maxDiff': maxd,
    'pctOver2': round(over(2) * 100, 4),
    'pctOver8': round(over(8) * 100, 4),
    'pctOver16': round(over(16) * 100, 4),
    'diffBBox': bbox,
    'identical': maxd == 0
}))
`;
const res = spawnSync(python.cmd, [...python.args, '-c', code, path.resolve(files[0]), path.resolve(files[1]), JSON.stringify(crop)], {
  encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});
if (res.status !== 0) {
  process.stderr.write('imgdiff failed: ' + (res.stderr || res.stdout || '') + '\n');
  process.exit(1);
}
const text = String(res.stdout || '').trim();
const parsed = JSON.parse(text);
if (boolArg(args['json-only'], false)) process.stdout.write(JSON.stringify(parsed) + '\n');
else { process.stdout.write(JSON.stringify(parsed, null, 2) + '\n'); }