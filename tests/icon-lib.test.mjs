import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import pica from 'pica';
import { cornerParams, shapeCoverage } from '../src/lib/shape-mask.js';
import { autoSharpen, composeEntry, innerSize, renderEntry, sharpenFor } from '../src/lib/icon-render.js';
import { buildIco, readIco, resolveEntryFormat, storedRgba } from '../src/lib/ico-file.js';
import { buildPalette, quantize } from '../src/lib/palette.js';
import { halveRGBA, resampleRGBA, unsharpRGBA } from '../src/lib/resample.js';
import { encodePng } from '../src/lib/png-encode.js';
import { clampCrop, cropDrawRect, defaultCrop, flipCrop, panCrop, zoomCrop } from '../src/lib/crop-math.js';

const resizer = pica({ features: ['js'] });
const resize = (options) => resizer.resizeBuffer(options);

function area(coverage) {
  return coverage.reduce((sum, value) => sum + value, 0);
}

function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part))));
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= 4 ? out[y * stride + i - 4] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= 4 ? out[(y - 1) * stride + i - 4] : 0;
      let predictor = 0;
      if (type === 1) predictor = left;
      else if (type === 2) predictor = up;
      else if (type === 3) predictor = (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + i] = (value + predictor) & 0xff;
    }
  }
  return { width, height, rgba: out };
}

function solidImage(size, [r, g, b, a]) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) data.set([r, g, b, a], i * 4);
  return { data, width: size, height: size };
}

test('0% is a full square and 100% is an anti-aliased circle in both corner styles', () => {
  const size = 64;
  assert.equal(area(shapeCoverage(size, { t: 0 })), size * size);
  for (const style of ['arc', 'soft']) {
    const circle = shapeCoverage(size, { t: 1, style });
    const expected = Math.PI * (size / 2) ** 2;
    assert.ok(Math.abs(area(circle) - expected) / expected < 0.005, `${style} circle area`);
    assert.equal(circle[0], 0);
    assert.equal(circle[(size / 2) * size + size / 2], 1);
    assert.ok(circle.some((value) => value > 0 && value < 1), 'edge has partial coverage');
  }
  assert.deepEqual(cornerParams(100, 1, 'soft'), { radius: 50, exponent: 2 });
});

test('the slider removes area monotonically, including the soft style near 100%', () => {
  for (const style of ['arc', 'soft']) {
    let previous = Infinity;
    for (let step = 0; step <= 20; step += 1) {
      const current = area(shapeCoverage(48, { t: step / 20, style }));
      assert.ok(current <= previous + 1e-6, `${style} at ${step * 5}%`);
      previous = current;
    }
  }
});

test('16 px masks stay smooth and symmetric', () => {
  const size = 16;
  const mask = shapeCoverage(size, { t: 0.5, style: 'soft' });
  const levels = new Set([...mask].map((value) => value.toFixed(3)));
  assert.ok(levels.size >= 5);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      assert.equal(mask[y * size + x], mask[y * size + (size - 1 - x)]);
      assert.equal(mask[y * size + x], mask[(size - 1 - y) * size + x]);
    }
  }
});

test('background, padding and stroke follow the shape', () => {
  const size = 32;
  const inner = innerSize(size, 0.125);
  assert.equal(inner, 24);
  const scaled = solidImage(inner, [255, 0, 0, 255]).data;
  const rgba = composeEntry(size, scaled, inner, {
    shape: { t: 1, style: 'arc' },
    background: { enabled: true, r: 0, g: 0, b: 255, a: 1 },
    stroke: { enabled: true, r: 0, g: 255, b: 0, a: 1, width: 0.0625 },
  });
  const pixel = (x, y) => [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(16, 16), [255, 0, 0, 255]);
  assert.deepEqual(pixel(16, 0), [0, 255, 0, 255]);
  assert.deepEqual(pixel(16, 3), [0, 0, 255, 255]);
});

test('each size is scaled from the source with size-dependent sharpening and no dark fringes', async () => {
  assert.deepEqual(autoSharpen(16), { amount: 70, radius: 0.5 });
  assert.equal(autoSharpen(256).amount, 0);
  assert.equal(sharpenFor(32, 'off').amount, 0);
  assert.equal(sharpenFor(32, 'manual', 120).amount, 120);
  const base = solidImage(256, [255, 255, 255, 255]);
  const rgba = await renderEntry(base, 16, { shape: { t: 1, style: 'arc' }, filter: 'mks2013', sharpen: autoSharpen(16) }, resize);
  for (let i = 0; i < 16 * 16; i += 1) {
    if (rgba[i * 4 + 3] > 0) assert.deepEqual([...rgba.subarray(i * 4, i * 4 + 3)], [255, 255, 255]);
  }
  assert.equal(rgba[3], 0);
});

test('pixelate upscaling keeps hard pixel blocks', async () => {
  const base = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) };
  const rgba = await renderEntry(base, 8, { shape: { t: 0 }, upscale: 'pixelate', sharpen: { amount: 0 } }, resize);
  assert.deepEqual([...rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...rgba.subarray((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...rgba.subarray((0 * 8 + 4) * 4, (0 * 8 + 4) * 4 + 4)], [0, 255, 0, 255]);
});

test('ICO files round-trip BMP 32-bit and PNG entries, with sizes above 256 forced to PNG', async () => {
  assert.equal(resolveEntryFormat(16), 'bmp32');
  assert.equal(resolveEntryFormat(16, 'auto'), 'bmp32');
  assert.equal(resolveEntryFormat(256, 'auto'), 'png');
  assert.equal(resolveEntryFormat(256, 'bmp8'), 'bmp8');
  assert.equal(resolveEntryFormat(512, 'bmp32'), 'png');
  assert.equal(resolveEntryFormat(512, 'bmp4'), 'png');
  const sizes = [16, 32, 256, 512];
  const sources = sizes.map((size) => {
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i += 1) rgba.set([(i * 7) & 255, (i * 3) & 255, size & 255, i % 5 === 0 ? 0 : 200], i * 4);
    return { size, rgba, format: 'bmp32' };
  });
  const { bytes, entries } = await buildIco(sources);
  assert.deepEqual(entries.map((entry) => [entry.size, entry.format]), [[16, 'bmp32'], [32, 'bmp32'], [256, 'bmp32'], [512, 'png']]);
  const parsed = readIco(bytes);
  assert.deepEqual(parsed.map((entry) => [entry.width, entry.height, entry.format, entry.bitCount]), [
    [16, 16, 'bmp', 32], [32, 32, 'bmp', 32], [256, 256, 'bmp', 32], [256, 256, 'png', 32],
  ]);
  for (let index = 0; index < 3; index += 1) assert.deepEqual(parsed[index].rgba, new Uint8Array(sources[index].rgba));
  const png = decodePng(parsed[3].data);
  assert.equal(png.width, 512);
  assert.deepEqual(png.rgba, new Uint8Array(sources[3].rgba));
  // AND mask marks fully transparent pixels.
  const bmp = parsed[0].data;
  const maskStart = 40 + 16 * 16 * 4;
  const bottomRowFirstPixelTransparent = sources[0].rgba[(15 * 16) * 4 + 3] === 0;
  assert.equal(Boolean(bmp[maskStart] & 0x80), bottomRowFirstPixelTransparent);
});

function gradientIcon(size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = x + y < 4 ? 0 : x === size - 1 ? 90 : x === size - 2 ? 170 : 255;
      rgba.set([Math.round((x * 255) / (size - 1)), Math.round((y * 255) / (size - 1)), 128, alpha], (y * size + x) * 4);
    }
  }
  return rgba;
}

test('ICO BMP 24/8/4-bit entries decode to exactly what the preview shows', async () => {
  for (const size of [13, 20, 48]) {
    const rgba = gradientIcon(size);
    const sources = [['bmp24', 24, 0], ['bmp8', 8, 0], ['bmp4', 4, 16]].map(([format]) => ({ size, rgba, format }));
    for (const [index, [format, bits, colorCount]] of [['bmp24', 24, 0], ['bmp8', 8, 0], ['bmp4', 4, 16]].entries()) {
      const { bytes, entries } = await buildIco([sources[index]]);
      assert.equal(entries[0].format, format);
      const [entry] = readIco(bytes);
      assert.deepEqual([entry.format, entry.bitCount, entry.bits, entry.colorCount], ['bmp', bits, bits, colorCount], `${format} ${size}`);
      assert.deepEqual(entry.rgba, new Uint8Array(storedRgba(rgba, size, format)), `${format} ${size}`);
      // Không có alpha: pixel chỉ đặc hẳn hoặc trong suốt hẳn, ngưỡng 50%.
      for (let i = 0; i < size * size; i += 1) assert.equal(entry.rgba[i * 4 + 3], rgba[i * 4 + 3] < 128 ? 0 : 255);
      const colors = new Set();
      for (let i = 0; i < size * size; i += 1) if (entry.rgba[i * 4 + 3]) colors.add(entry.rgba.subarray(i * 4, i * 4 + 3).join());
      if (bits <= 8) assert.ok(colors.size <= 1 << bits, `${format} has ${colors.size} colors`);
    }
  }
});

test('palette keeps exact colors when they fit and flags see-through pixels', () => {
  const size = 6;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [17, 34, 51], [250, 250, 250]];
  for (let i = 0; i < size * size; i += 1) rgba.set([...colors[i % colors.length], i % 7 === 0 ? 100 : 255], i * 4);
  const { palette, indices, transparent } = quantize(rgba, size, 16);
  assert.equal(palette.length, colors.length);
  for (let i = 0; i < size * size; i += 1) {
    assert.equal(transparent[i], i % 7 === 0 ? 1 : 0);
    if (!transparent[i]) assert.deepEqual(palette[indices[i]], colors[i % colors.length]);
  }
  assert.ok(buildPalette(gradientIcon(64), 16).length <= 16);
});

function solid(width, height, color) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set(color, i * 4);
  return rgba;
}

test('Mitchell resampling keeps flat colors exact and transparent edges free of dark fringes', () => {
  for (const [sw, dw] of [[100, 37], [37, 100], [512, 16], [3, 256]]) {
    const out = resampleRGBA(solid(sw, sw, [12, 200, 99, 255]), sw, sw, dw, dw);
    for (let i = 0; i < dw * dw; i += 1) assert.deepEqual([...out.subarray(i * 4, i * 4 + 4)], [12, 200, 99, 255], `${sw}->${dw}`);
  }
  // Nửa trái đỏ đặc, nửa phải trong suốt (màu đen ẩn): mép không được ngả tối.
  const w = 64;
  const src = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y += 1) for (let x = 0; x < w / 2; x += 1) src.set([255, 0, 0, 255], (y * w + x) * 4);
  for (const dw of [20, 150]) {
    const out = resampleRGBA(src, w, w, dw, dw);
    let edge = 0;
    for (let i = 0; i < dw * dw; i += 1) {
      if (!out[i * 4 + 3]) continue;
      if (out[i * 4 + 3] < 255) edge += 1;
      assert.ok(out[i * 4] >= 250 && out[i * 4 + 1] <= 3 && out[i * 4 + 2] <= 3, `fringe at ${i}: ${out.subarray(i * 4, i * 4 + 4)}`);
    }
    assert.ok(edge > 0, 'edge should be antialiased');
  }
});

test('Mitchell upscaling of a hard edge barely overshoots (no bright halo along dark lines)', async () => {
  const w = 16;
  const src = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y += 1) for (let x = 0; x < w; x += 1) src.set(x < 8 ? [20, 20, 20, 255] : [200, 200, 200, 255], (y * w + x) * 4);
  const spread = (out) => {
    let max = 0;
    let min = 255;
    for (let i = 0; i < out.length; i += 4) { max = Math.max(max, out[i]); min = Math.min(min, out[i]); }
    return max - 200 + 20 - min;
  };
  const mitchell = spread(resampleRGBA(src, w, w, 128, 128));
  const sharp = spread(await resize({ src, width: w, height: w, toWidth: 128, toHeight: 128, filter: 'mks2013' }));
  assert.ok(mitchell <= 16, `Mitchell overshoot ${mitchell}`);
  assert.ok(mitchell * 2 < sharp, `Mitchell ${mitchell} vs Magic Kernel Sharp ${sharp}`);
});

test('halving averages 2x2 blocks by alpha and keeps odd edges', () => {
  const src = new Uint8ClampedArray(3 * 3 * 4);
  src.set([200, 0, 0, 255], 0);
  src.set([0, 0, 0, 0], 4);
  src.set([100, 0, 0, 255], 12);
  src.set([0, 0, 0, 0], 16);
  src.set([9, 9, 9, 255], 8);
  const { data, width, height } = halveRGBA(src, 3, 3);
  assert.deepEqual([width, height], [2, 2]);
  assert.deepEqual([...data.subarray(0, 4)], [150, 0, 0, 128]);
  assert.deepEqual([...data.subarray(4, 8)], [9, 9, 9, 128]);
});

test('unsharp mask only touches brightness, never hue, and ignores flat areas', () => {
  const flat = solid(9, 9, [40, 80, 160, 255]);
  assert.deepEqual(unsharpRGBA(new Uint8ClampedArray(flat), 9, 9, 150), flat);
  const w = 12;
  const rgba = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y += 1) for (let x = 0; x < w; x += 1) rgba.set(x < 6 ? [30, 60, 90, 255] : [60, 120, 180, 255], (y * w + x) * 4);
  const before = new Uint8ClampedArray(rgba);
  unsharpRGBA(rgba, w, w, 100);
  assert.notDeepEqual(rgba, before);
  for (let i = 0; i < w * w; i += 1) {
    const [r, g, b] = rgba.subarray(i * 4, i * 4 + 3);
    assert.ok(Math.abs(g - 2 * r) <= 2 && Math.abs(b - 3 * r) <= 3, `hue drift ${r},${g},${b}`);
  }
});

test('PNG encoder output decodes back to the same pixels', async () => {
  const rgba = new Uint8Array(13 * 7 * 4).map((_, i) => (i * 37) & 255);
  const decoded = decodePng(await encodePng(rgba, 13, 7));
  assert.deepEqual(decoded.rgba, rgba);
});

// Cách lấy mẫu cũ: lấy mẫu mọi pixel. Bản tối ưu phải cho kết quả y hệt.
function bruteCoverage(size, { t = 0, style = 'arc', inset = 0, samples = 8 } = {}) {
  const coverage = new Float32Array(size * size);
  const side = size - 2 * inset;
  if (side <= 0) return coverage;
  const { radius: fullRadius, exponent } = cornerParams(size, t, style);
  const radius = fullRadius * (side / size);
  const inside = (px, py) => {
    if (px < inset || py < inset || px > inset + side || py > inset + side) return false;
    if (radius <= 0) return true;
    const u = Math.min(px - inset, inset + side - px);
    const v = Math.min(py - inset, inset + side - py);
    if (u >= radius || v >= radius) return true;
    return ((radius - u) / radius) ** exponent + ((radius - v) / radius) ** exponent <= 1;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) if (inside(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) hits += 1;
      }
      coverage[y * size + x] = hits / (samples * samples);
    }
  }
  return coverage;
}

test('fast shape coverage matches per-pixel supersampling exactly', () => {
  for (const size of [1, 3, 16, 17, 24, 48, 64]) {
    for (const style of ['arc', 'soft']) {
      for (const t of [0, 0.2, 0.5, 0.9, 1]) {
        for (const inset of [0, 0.5, 2.25]) {
          assert.deepEqual(shapeCoverage(size, { t, style, inset }), bruteCoverage(size, { t, style, inset }), `${size} ${style} ${t} ${inset}`);
        }
      }
    }
  }
});

test('crop frame stays inside the image, or around it when zoomed out', () => {
  assert.deepEqual(defaultCrop(300, 200), { x: 50, y: 0, size: 200 });
  assert.deepEqual(panCrop({ x: 50, y: 0, size: 200 }, -500, 30, 300, 200), { x: 0, y: 0, size: 200 });
  const fit = zoomCrop({ x: 50, y: 0, size: 200 }, 10, 0.5, 0.5, 300, 200);
  assert.deepEqual(fit, { x: 0, y: -50, size: 300 });
  assert.deepEqual(panCrop(fit, 0, 999, 300, 200), { x: 0, y: 0, size: 300 });
  assert.deepEqual(panCrop(fit, 0, -999, 300, 200), { x: 0, y: -100, size: 300 });
  const zoomed = zoomCrop({ x: 50, y: 0, size: 200 }, 0.5, 0, 0, 300, 200);
  assert.deepEqual(zoomed, { x: 50, y: 0, size: 100 });
  assert.deepEqual(flipCrop({ x: 0, y: 0, size: 200 }, 300, 200, true), { x: 100, y: 0, size: 200 });
  assert.equal(clampCrop({ x: 0, y: 0, size: 1 }, 300, 200).size, 8);
  const rect = cropDrawRect({ x: 0, y: -50, size: 300 }, 300, 200, 48, 0.5);
  assert.deepEqual(rect, { sx: 0, sy: 0, sw: 150, sh: 100, dx: 0, dy: 8, dw: 48, dh: 32 });
});
