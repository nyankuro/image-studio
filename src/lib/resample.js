// Co giãn ảnh RGBA bằng JS thuần, xử lý trên kênh màu đã nhân alpha để mép
// trong suốt không bị viền tối/sáng.

// Bộ lọc bậc ba Mitchell–Netravali (B = C = 1/3): cách các trình xem ảnh thường
// dùng, mượt, gần như không có quầng sáng quanh nét đậm và không làm lộ khối vỡ.
function cubicKernel(B, C) {
  return (value) => {
    const x = Math.abs(value);
    if (x < 1) return ((12 - 9 * B - 6 * C) * x ** 3 + (-18 + 12 * B + 6 * C) * x ** 2 + (6 - 2 * B)) / 6;
    if (x < 2) return ((-B - 6 * C) * x ** 3 + (6 * B + 30 * C) * x ** 2 + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
    return 0;
  };
}

export const KERNELS = {
  mitchell: { support: 2, fn: cubicKernel(1 / 3, 1 / 3) },
  catmull: { support: 2, fn: cubicKernel(0, 0.5) },
};

function axisWeights(srcSize, dstSize, kernel) {
  const scale = dstSize / srcSize;
  const stretch = Math.min(1, scale);
  const support = kernel.support / stretch;
  const starts = new Int32Array(dstSize);
  const counts = new Int32Array(dstSize);
  const lists = [];
  for (let i = 0; i < dstSize; i += 1) {
    const center = (i + 0.5) / scale;
    const start = Math.max(0, Math.floor(center - support));
    const end = Math.min(srcSize - 1, Math.ceil(center + support));
    const weights = new Float32Array(end - start + 1);
    let sum = 0;
    for (let j = start; j <= end; j += 1) {
      const w = kernel.fn((j + 0.5 - center) * stretch);
      weights[j - start] = w;
      sum += w;
    }
    if (sum) for (let k = 0; k < weights.length; k += 1) weights[k] /= sum;
    starts[i] = start;
    counts[i] = weights.length;
    lists.push(weights);
  }
  return { starts, counts, lists };
}

function premultiply(src, count) {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const a = src[i * 4 + 3] / 255;
    out[i * 4] = src[i * 4] * a;
    out[i * 4 + 1] = src[i * 4 + 1] * a;
    out[i * 4 + 2] = src[i * 4 + 2] * a;
    out[i * 4 + 3] = a;
  }
  return out;
}

function clampByte(value) {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
}

// src: RGBA thường (không nhân alpha) sw × sh → Uint8ClampedArray dw × dh.
export function resampleRGBA(src, sw, sh, dw, dh, kernelName = 'mitchell') {
  const kernel = KERNELS[kernelName] || KERNELS.mitchell;
  const pre = premultiply(src, sw * sh);
  const xw = axisWeights(sw, dw, kernel);
  const yw = axisWeights(sh, dh, kernel);
  const mid = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    const row = y * sw;
    for (let x = 0; x < dw; x += 1) {
      const weights = xw.lists[x];
      let r = 0; let g = 0; let b = 0; let a = 0;
      let p = (row + xw.starts[x]) * 4;
      for (let k = 0; k < weights.length; k += 1, p += 4) {
        const w = weights[k];
        r += pre[p] * w; g += pre[p + 1] * w; b += pre[p + 2] * w; a += pre[p + 3] * w;
      }
      const o = (y * dw + x) * 4;
      mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const weights = yw.lists[y];
    const start = yw.starts[y];
    for (let x = 0; x < dw; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      let p = (start * dw + x) * 4;
      for (let k = 0; k < weights.length; k += 1, p += dw * 4) {
        const w = weights[k];
        r += mid[p] * w; g += mid[p + 1] * w; b += mid[p + 2] * w; a += mid[p + 3] * w;
      }
      const o = (y * dw + x) * 4;
      if (a <= 0.5 / 255) continue;
      const alpha = Math.min(1, a);
      out[o] = clampByte(r / a);
      out[o + 1] = clampByte(g / a);
      out[o + 2] = clampByte(b / a);
      out[o + 3] = clampByte(alpha * 255);
    }
  }
  return out;
}

// Thu nhỏ đúng một nửa: mỗi pixel mới là trung bình 2×2 pixel cũ (theo alpha).
// Cạnh lẻ thì pixel cuối chỉ lấy phần có thật.
export function halveRGBA(src, width, height) {
  const w = Math.max(1, Math.ceil(width / 2));
  const h = Math.max(1, Math.ceil(height / 2));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const y0 = y * 2;
    const y1 = Math.min(height - 1, y0 + 1);
    for (let x = 0; x < w; x += 1) {
      const x0 = x * 2;
      const x1 = Math.min(width - 1, x0 + 1);
      const p0 = (y0 * width + x0) * 4;
      const p1 = (y0 * width + x1) * 4;
      const p2 = (y1 * width + x0) * 4;
      const p3 = (y1 * width + x1) * 4;
      const a0 = src[p0 + 3]; const a1 = src[p1 + 3]; const a2 = src[p2 + 3]; const a3 = src[p3 + 3];
      const a = a0 + a1 + a2 + a3;
      const o = (y * w + x) * 4;
      if (a === 1020) {
        out[o] = (src[p0] + src[p1] + src[p2] + src[p3] + 2) >> 2;
        out[o + 1] = (src[p0 + 1] + src[p1 + 1] + src[p2 + 1] + src[p3 + 1] + 2) >> 2;
        out[o + 2] = (src[p0 + 2] + src[p1 + 2] + src[p2 + 2] + src[p3 + 2] + 2) >> 2;
        out[o + 3] = 255;
        continue;
      }
      const r = src[p0] * a0 + src[p1] * a1 + src[p2] * a2 + src[p3] * a3;
      const g = src[p0 + 1] * a0 + src[p1 + 1] * a1 + src[p2 + 1] * a2 + src[p3 + 1] * a3;
      const b = src[p0 + 2] * a0 + src[p1 + 2] * a1 + src[p2 + 2] * a2 + src[p3 + 2] * a3;
      if (!a) continue;
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / 4);
    }
  }
  return { data: out, width: w, height: h };
}

function gaussianKernel(radius) {
  const sigma = Math.max(0.3, radius);
  const half = Math.max(1, Math.ceil(sigma * 3));
  const weights = new Float32Array(half * 2 + 1);
  let sum = 0;
  for (let i = -half; i <= half; i += 1) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights[i + half] = w;
    sum += w;
  }
  for (let i = 0; i < weights.length; i += 1) weights[i] /= sum;
  return { weights, half };
}

// Làm nét kiểu unsharp mask trên độ sáng V = max(R, G, B) rồi nhân đều 3 kênh,
// nên không đổi màu. amount tính theo %, threshold theo thang 0..255.
export function unsharpRGBA(rgba, width, height, amount, radius = 0.6, threshold = 2) {
  if (!amount) return rgba;
  const count = width * height;
  const value = new Float32Array(count);
  for (let i = 0; i < count; i += 1) value[i] = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  const { weights, half } = gaussianKernel(Math.min(2, radius));
  const tmp = new Float32Array(count);
  const blur = new Float32Array(count);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -half; k <= half; k += 1) sum += value[y * width + Math.min(width - 1, Math.max(0, x + k))] * weights[k + half];
      tmp[y * width + x] = sum;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -half; k <= half; k += 1) sum += tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x] * weights[k + half];
      blur[y * width + x] = sum;
    }
  }
  const factor = amount / 100;
  for (let i = 0; i < count; i += 1) {
    const v = value[i];
    const diff = v - blur[i];
    if (Math.abs(diff) < threshold || v <= 0) continue;
    const next = Math.min(255, Math.max(0, v + factor * diff));
    const ratio = next / v;
    rgba[i * 4] = clampByte(rgba[i * 4] * ratio);
    rgba[i * 4 + 1] = clampByte(rgba[i * 4 + 1] * ratio);
    rgba[i * 4 + 2] = clampByte(rgba[i * 4 + 2] * ratio);
  }
  return rgba;
}
