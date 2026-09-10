// Screenshot assertions for the e2e harness. Dependency-free on purpose:
// decode the PNG in-process and check the capture is real (right size, not a
// blank rectangle) instead of shelling out to image tooling.
//
// Usage:
//   node e2e/assert.mjs e2e/out/bar.png
//   node e2e/assert.mjs e2e/out/popout-overview.png --region "0,44 400x300"
import fs from "node:fs";
import { inflateSync } from "node:zlib";

function decodePng(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32BE(12) !== 0x49484452) throw new Error(path + ": not a PNG");
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  let pos = 8;
  const idat = [];
  let colorType = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === "IHDR") colorType = buf[pos + 17];
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  return { w, h, channels, out, stride };
}

// Fraction of pixels differing from the region's dominant colour. A blank
// capture (bar never drew, popout failed to open) reads as ~0.
function inkRatio(png, region) {
  const [rx, ry] = region;
  const [rw, rh] = region[2] ?? [png.w, png.h];
  const luma = (x, y) => {
    const o = y * png.stride + x * png.channels;
    const r = png.out[o];
    const g = png.channels >= 3 ? png.out[o + 1] : r;
    const b = png.channels >= 3 ? png.out[o + 2] : r;
    return (r * 299 + g * 587 + b * 114) / 1000;
  };
  const hist = new Array(256).fill(0);
  const x1 = Math.min(rx + rw, png.w);
  const y1 = Math.min(ry + rh, png.h);
  for (let y = ry; y < y1; y++) {
    for (let x = rx; x < x1; x++) hist[Math.round(luma(x, y))]++;
  }
  const bg = hist.indexOf(Math.max(...hist));
  let ink = 0;
  let total = 0;
  for (let y = ry; y < y1; y++) {
    for (let x = rx; x < x1; x++) {
      total++;
      if (Math.abs(luma(x, y) - bg) > 18) ink++;
    }
  }
  return total === 0 ? 0 : ink / total;
}

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: node e2e/assert.mjs <png> [--min-ink R] [--region 'X,Y WxH']");
  process.exit(2);
}
const arg = (name, fallback) => {
  const i = rest.indexOf(name);
  return i === -1 ? fallback : rest[i + 1];
};
// The bar strip is mostly transparent, so its whole-frame ink sits around
// 0.02; the popout frames are an order of magnitude above that.
const minInk = Number(arg("--min-ink", "0.01"));
const regionArg = arg("--region", null);
const png = decodePng(file);
const region = regionArg
  ? [
      ...regionArg.split(/\s+/)[0].split(",").map(Number),
      regionArg.split(/\s+/)[1].split("x").map(Number),
    ]
  : [0, 0, [png.w, png.h]];
const ink = inkRatio(png, region);

if (png.w < 100 || png.h < 10) {
  console.error("FAIL " + file + ": implausibly small (" + png.w + "x" + png.h + ")");
  process.exit(1);
}
if (ink < minInk) {
  console.error("FAIL " + file + ": blank capture, ink=" + ink.toFixed(4) + " < " + minInk);
  process.exit(1);
}
console.log("PASS " + file + ": " + png.w + "x" + png.h + " ink=" + ink.toFixed(4));
