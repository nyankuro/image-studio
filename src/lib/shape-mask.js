// Mặt nạ hình dạng icon: từ hình vuông (t = 0) đến hình tròn (t = 1).
// Mỗi pixel nhận độ phủ 0..1 bằng cách lấy mẫu samples × samples điểm,
// nên mép luôn được khử răng cưa ở mọi kích thước, kể cả 16 px.

export const SHAPE_STYLES = ['arc', 'soft'];

const SOFT_RADIUS_BOOST = 1.45;
const SOFT_EXPONENT = 4;
const SOFT_BLEND_START = 0.85;

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

// Bán kính góc và số mũ siêu elip cho một cạnh `size`.
// arc  : góc là cung tròn (số mũ 2), bán kính = t × size / 2.
// soft : góc siêu elip số mũ 4 (kiểu squircle). Bán kính được nhân 1.45 để
//        nhìn tròn tương đương kiểu arc. Từ 85% đến 100%, số mũ giảm dần về 2
//        để chuyển sang hình tròn liền mạch, 100% luôn là hình tròn thật.
export function cornerParams(size, t, style = 'arc') {
  const half = size / 2;
  const amount = clamp01(t);
  let radius = amount * half;
  let exponent = 2;
  if (style === 'soft') {
    radius = Math.min(half, radius * SOFT_RADIUS_BOOST);
    const blend = clamp01((amount - SOFT_BLEND_START) / (1 - SOFT_BLEND_START));
    exponent = SOFT_EXPONENT * (1 - blend) + 2 * blend;
  }
  return { radius, exponent };
}

function insideShape(px, py, x0, y0, side, radius, exponent) {
  if (px < x0 || py < y0 || px > x0 + side || py > y0 + side) return false;
  if (radius <= 0) return true;
  const u = Math.min(px - x0, x0 + side - px);
  const v = Math.min(py - y0, y0 + side - py);
  if (u >= radius || v >= radius) return true;
  const dx = (radius - u) / radius;
  const dy = (radius - v) / radius;
  return dx ** exponent + dy ** exponent <= 1;
}

// Giới hạn khoảng cách chuẩn hóa tới tâm góc bo trên một trục, cho đoạn pixel [a, a+1].
// d = (radius - u) / radius, kẹp về 0..1, với u là khoảng cách tới cạnh gần nhất.
// Trong góc, vùng "bên trong" giảm dần theo d trên cả hai trục, nên chỉ cần
// xét d nhỏ nhất và lớn nhất để biết pixel nằm trọn trong, trọn ngoài hay cắt mép.
function axisBounds(size, lo, hi, radius) {
  const minD = new Float64Array(size);
  const maxD = new Float64Array(size);
  const full = new Uint8Array(size);
  const out = new Uint8Array(size);
  const center = (lo + hi) / 2;
  for (let i = 0; i < size; i += 1) {
    const a = Math.max(i, lo);
    const b = Math.min(i + 1, hi);
    if (b <= a) { out[i] = 1; continue; }
    full[i] = i >= lo && i + 1 <= hi ? 1 : 0;
    if (radius <= 0) continue;
    const ua = Math.min(a - lo, hi - a);
    const ub = Math.min(b - lo, hi - b);
    const uMin = Math.min(ua, ub);
    const uMax = a <= center && b >= center ? (hi - lo) / 2 : Math.max(ua, ub);
    maxD[i] = Math.min(1, Math.max(0, (radius - uMin) / radius));
    minD[i] = Math.min(1, Math.max(0, (radius - uMax) / radius));
  }
  return { minD, maxD, full, out };
}

// Trả về Float32Array size*size, mỗi phần tử là độ phủ 0..1.
// inset: thu hình vào trong (px) đều 4 cạnh, bán kính co theo tỉ lệ
// (dùng để tạo viền chạy theo hình).
// Chỉ các pixel cắt mép mới được lấy mẫu samples × samples; kết quả giống hệt
// cách lấy mẫu mọi pixel nhưng nhanh hơn nhiều ở size lớn.
export function shapeCoverage(size, { t = 0, style = 'arc', inset = 0, samples = 8 } = {}) {
  const coverage = new Float32Array(size * size);
  const side = size - 2 * inset;
  if (side <= 0) return coverage;
  const { radius: fullRadius, exponent } = cornerParams(size, t, style);
  const radius = fullRadius * (side / size);
  const x0 = inset;
  const y0 = inset;
  const x1 = inset + side;
  const step = 1 / samples;
  const weight = 1 / (samples * samples);
  const axis = axisBounds(size, x0, x1, radius);
  const powMin = new Float64Array(size);
  const powMax = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    powMin[i] = axis.minD[i] ** exponent;
    powMax[i] = axis.maxD[i] ** exponent;
  }

  for (let y = 0; y < size; y += 1) {
    if (axis.out[y]) continue;
    for (let x = 0; x < size; x += 1) {
      if (axis.out[x]) continue;
      const fullyInBox = axis.full[x] && axis.full[y];
      if (fullyInBox && (radius <= 0 || powMax[x] + powMax[y] <= 1)) {
        coverage[y * size + x] = 1;
        continue;
      }
      if (radius > 0 && powMin[x] + powMin[y] > 1) continue;
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        const py = y + (sy + 0.5) * step;
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) * step;
          if (insideShape(px, py, x0, y0, side, radius, exponent)) hits += 1;
        }
      }
      coverage[y * size + x] = hits * weight;
    }
  }
  return coverage;
}
