// Giảm màu cho entry BMP 8-bit (256 màu) và 4-bit (16 màu):
// bảng màu theo median cut trên các pixel đặc, rồi khuếch tán sai số Floyd–Steinberg.
// Các định dạng này không có alpha: pixel có alpha < 128 thành trong suốt hẳn
// (mặt nạ AND), còn lại thành đặc.

export const ALPHA_CUTOFF = 128;

function describe(colors) {
  let rMin = 255; let rMax = 0; let gMin = 255; let gMax = 0; let bMin = 255; let bMax = 0; let total = 0;
  for (const c of colors) {
    if (c.r < rMin) rMin = c.r; if (c.r > rMax) rMax = c.r;
    if (c.g < gMin) gMin = c.g; if (c.g > gMax) gMax = c.g;
    if (c.b < bMin) bMin = c.b; if (c.b > bMax) bMax = c.b;
    total += c.n;
  }
  const ranges = [rMax - rMin, gMax - gMin, bMax - bMin];
  const axis = ranges.indexOf(Math.max(...ranges));
  return { colors, axis, score: colors.length < 2 ? 0 : ranges[axis] * Math.sqrt(total), total };
}

function buildBoxes(colors, maxColors) {
  // colors: [{ r, g, b, n }]
  const boxes = [describe(colors)];
  while (boxes.length < maxColors) {
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i += 1) if (boxes[i].score > best) { best = boxes[i].score; pick = i; }
    if (pick < 0) break;
    const { colors: box, axis, total } = boxes[pick];
    const key = ['r', 'g', 'b'][axis];
    box.sort((a, b) => a[key] - b[key]);
    const half = total / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      acc += box[i].n;
      cut = i + 1;
      if (acc >= half) break;
    }
    boxes.splice(pick, 1, describe(box.slice(0, cut)), describe(box.slice(cut)));
  }
  return boxes.map(({ colors: box }) => {
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (const c of box) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; n += c.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

// Ít màu thì giữ nguyên từng màu; nhiều màu thì gom theo lưới 5 bit mỗi kênh
// (lấy màu trung bình của mỗi ô) rồi mới chia hộp, nhanh hơn nhiều với ảnh chụp.
export function buildPalette(rgba, maxColors) {
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < ALPHA_CUTOFF) continue;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) return [[0, 0, 0]];
  if (counts.size <= maxColors) return [...counts.keys()].map((key) => [key >> 16, (key >> 8) & 255, key & 255]);
  const bins = new Map();
  for (const [key, n] of counts) {
    const r = key >> 16; const g = (key >> 8) & 255; const b = key & 255;
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const entry = bins.get(bin);
    if (entry) { entry.r += r * n; entry.g += g * n; entry.b += b * n; entry.n += n; } else bins.set(bin, { r: r * n, g: g * n, b: b * n, n });
  }
  const colors = [...bins.values()].map((c) => ({ r: c.r / c.n, g: c.g / c.n, b: c.b / c.n, n: c.n }));
  return buildBoxes(colors, maxColors);
}

function nearestIndex(palette, r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const [pr, pg, pb] = palette[i];
    const d = (pr - r) ** 2 * 0.3 + (pg - g) ** 2 * 0.59 + (pb - b) ** 2 * 0.11;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Tra màu gần nhất. Bảng màu đúng y màu ảnh thì tra chính xác; bảng màu đã gom
// thì tra theo ô lưới 5 bit (sai số nhỏ, khuếch tán sai số bù lại).
function makeLookup(palette, exact) {
  if (exact) {
    const cache = new Map();
    return (r, g, b) => {
      const key = (r << 16) | (g << 8) | b;
      let hit = cache.get(key);
      if (hit === undefined) { hit = nearestIndex(palette, r, g, b); cache.set(key, hit); }
      return hit;
    };
  }
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let hit = cache[key];
    if (hit < 0) { hit = nearestIndex(palette, (r & 248) + 4, (g & 248) + 4, (b & 248) + 4); cache[key] = hit; }
    return hit;
  };
}

function isExact(rgba, palette) {
  const keys = new Set(palette.map(([r, g, b]) => (r << 16) | (g << 8) | b));
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] >= ALPHA_CUTOFF && !keys.has((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])) return false;
  }
  return true;
}

// Trả về { palette, indices (chỉ số màu của từng pixel), transparent (1 = trong suốt) }.
export function quantize(rgba, size, maxColors) {
  const palette = buildPalette(rgba, maxColors);
  const exact = palette.length < maxColors || isExact(rgba, palette);
  const lookup = makeLookup(palette, exact);
  const count = size * size;
  const indices = new Uint8Array(count);
  const transparent = new Uint8Array(count);
  const err = new Float32Array((size + 2) * 2 * 3);
  for (let y = 0; y < size; y += 1) {
    const cur = (y % 2) * (size + 2) * 3;
    const next = ((y + 1) % 2) * (size + 2) * 3;
    err.fill(0, next, next + (size + 2) * 3);
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      if (rgba[i * 4 + 3] < ALPHA_CUTOFF) {
        transparent[i] = 1;
        continue;
      }
      const e = cur + (x + 1) * 3;
      const r = Math.min(255, Math.max(0, Math.round(rgba[i * 4] + err[e])));
      const g = Math.min(255, Math.max(0, Math.round(rgba[i * 4 + 1] + err[e + 1])));
      const b = Math.min(255, Math.max(0, Math.round(rgba[i * 4 + 2] + err[e + 2])));
      const index = lookup(r, g, b);
      indices[i] = index;
      const [pr, pg, pb] = palette[index];
      const dr = r - pr; const dg = g - pg; const db = b - pb;
      const spread = (offset, w) => {
        err[offset] += dr * w; err[offset + 1] += dg * w; err[offset + 2] += db * w;
      };
      spread(cur + (x + 2) * 3, 7 / 16);
      spread(next + x * 3, 3 / 16);
      spread(next + (x + 1) * 3, 5 / 16);
      spread(next + (x + 2) * 3, 1 / 16);
    }
  }
  return { palette, indices, transparent };
}
