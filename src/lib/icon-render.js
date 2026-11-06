import { shapeCoverage } from './shape-mask.js';
import { resampleRGBA, unsharpRGBA } from './resample.js';

// Dựng từng entry icon từ ảnh gốc đã crop thành hình vuông:
//   thu nhỏ riêng cho size đó (kèm làm nét theo size) → đặt vào giữa với lề trong
//   → nền theo hình → cắt theo mặt nạ bo góc → viền theo hình.
// Hàm thu nhỏ được truyền vào (pica trong app và trong test).

export const STANDARD_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512];

export const SIZE_PRESETS = {
  full: { label: 'Full set', sizes: [16, 20, 24, 32, 40, 48, 64, 96, 128, 256] },
  windows: { label: 'Windows', sizes: [16, 20, 24, 32, 40, 48, 64, 256] },
  favicon: { label: 'Favicon', sizes: [16, 32, 48] },
};

export const DEFAULT_FILTER = 'mitchell';

export const RESAMPLE_FILTERS = [
  { value: 'mitchell', label: 'Mitchell (smooth)' },
  { value: 'mks2013', label: 'Magic Kernel Sharp (crisp)' },
  { value: 'lanczos3', label: 'Lanczos 3' },
  { value: 'lanczos2', label: 'Lanczos 2' },
  { value: 'hamming', label: 'Hamming' },
  { value: 'box', label: 'Box' },
];

// Mức làm nét tự động: size càng nhỏ càng làm nét mạnh. 128 px trở lên không làm nét.
export function autoSharpen(size) {
  if (size <= 20) return { amount: 70, radius: 0.5 };
  if (size <= 40) return { amount: 50, radius: 0.5 };
  if (size <= 96) return { amount: 35, radius: 0.6 };
  return { amount: 0, radius: 0.6 };
}

export function sharpenFor(size, mode = 'auto', manualAmount) {
  if (mode === 'off') return { amount: 0, radius: 0.6 };
  const auto = autoSharpen(size);
  if (mode === 'manual' && Number.isFinite(manualAmount)) return { amount: Math.max(0, manualAmount), radius: auto.radius };
  return auto;
}

export function innerSize(size, padding = 0) {
  const pad = Math.min(0.4, Math.max(0, Number(padding) || 0));
  return Math.max(1, Math.round(size * (1 - 2 * pad)));
}

function nearestResize(src, width, height, toWidth, toHeight) {
  const out = new Uint8ClampedArray(toWidth * toHeight * 4);
  for (let y = 0; y < toHeight; y += 1) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / toHeight));
    for (let x = 0; x < toWidth; x += 1) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / toWidth));
      const si = (sy * width + sx) * 4;
      const di = (y * toWidth + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

// Thu nhỏ (hoặc phóng to) ảnh gốc về cạnh `target`, rồi làm nét nếu cần.
// - Phóng to: luôn dùng Mitchell (hoặc giữ ô pixel), không làm nét, để mép
//   không lộ răng cưa và khối vỡ của ảnh kém chất lượng.
// - Thu nhỏ: Mitchell bằng JS của app, các bộ lọc khác qua pica.
// resize({ src, width, height, toWidth, toHeight, filter }) → Uint8Array (pica)
export async function scaleSource(base, target, { filter = DEFAULT_FILTER, sharpen = { amount: 0, radius: 0.6 }, upscale = 'smooth' }, resize) {
  if (target === base.width && target === base.height && !sharpen.amount) return new Uint8ClampedArray(base.data);
  const upscaling = target > base.width;
  if (upscaling && upscale === 'pixelate') return nearestResize(base.data, base.width, base.height, target, target);
  let out;
  if (upscaling || filter === 'mitchell' || !resize) {
    out = resampleRGBA(base.data, base.width, base.height, target, target, 'mitchell');
  } else {
    const result = await resize({ src: base.data, width: base.width, height: base.height, toWidth: target, toHeight: target, filter });
    out = new Uint8ClampedArray(result.buffer, result.byteOffset, result.byteLength);
  }
  if (!upscaling && sharpen.amount > 0) unsharpRGBA(out, target, target, sharpen.amount, Math.max(0.5, sharpen.radius || 0.6), 2);
  return out;
}

function premultipliedColor(color) {
  const alpha = Math.min(1, Math.max(0, color.a ?? 1));
  return [(color.r / 255) * alpha, (color.g / 255) * alpha, (color.b / 255) * alpha, alpha];
}

// scaled: ảnh đã thu về cạnh `inner` (từ scaleSource).
// shape: { t: 0..1, style: 'arc'|'soft' }
// background / stroke: { enabled, r, g, b, a } ; stroke.width là tỉ lệ so với cạnh (0..0.15)
export function composeEntry(size, scaled, inner, { shape = { t: 0, style: 'arc' }, background, stroke } = {}) {
  const coverage = shapeCoverage(size, shape);
  const out = new Float32Array(size * size * 4);
  const offset = Math.floor((size - inner) / 2);

  if (background?.enabled && (background.a ?? 1) > 0) {
    const [r, g, b, a] = premultipliedColor(background);
    for (let i = 0; i < size * size; i += 1) {
      const c = coverage[i];
      if (!c) continue;
      out[i * 4] = r * c;
      out[i * 4 + 1] = g * c;
      out[i * 4 + 2] = b * c;
      out[i * 4 + 3] = a * c;
    }
  }

  for (let y = 0; y < inner; y += 1) {
    const oy = y + offset;
    if (oy < 0 || oy >= size) continue;
    for (let x = 0; x < inner; x += 1) {
      const ox = x + offset;
      if (ox < 0 || ox >= size) continue;
      const di = oy * size + ox;
      const c = coverage[di];
      if (!c) continue;
      const si = (y * inner + x) * 4;
      const a = (scaled[si + 3] / 255) * c;
      if (!a) continue;
      const keep = 1 - a;
      out[di * 4] = (scaled[si] / 255) * a + out[di * 4] * keep;
      out[di * 4 + 1] = (scaled[si + 1] / 255) * a + out[di * 4 + 1] * keep;
      out[di * 4 + 2] = (scaled[si + 2] / 255) * a + out[di * 4 + 2] * keep;
      out[di * 4 + 3] = a + out[di * 4 + 3] * keep;
    }
  }

  if (stroke?.enabled && (stroke.width ?? 0) > 0 && (stroke.a ?? 1) > 0) {
    const widthPx = Math.max(0.5, stroke.width * size);
    const innerCoverage = shapeCoverage(size, { ...shape, inset: widthPx });
    const [r, g, b, a] = premultipliedColor(stroke);
    for (let i = 0; i < size * size; i += 1) {
      const band = Math.max(0, coverage[i] - innerCoverage[i]);
      if (!band) continue;
      const sa = a * band;
      const keep = 1 - sa;
      out[i * 4] = r * band + out[i * 4] * keep;
      out[i * 4 + 1] = g * band + out[i * 4 + 1] * keep;
      out[i * 4 + 2] = b * band + out[i * 4 + 2] * keep;
      out[i * 4 + 3] = sa + out[i * 4 + 3] * keep;
    }
  }

  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const a = out[i * 4 + 3];
    if (a <= 0) continue;
    rgba[i * 4] = Math.round((out[i * 4] / a) * 255);
    rgba[i * 4 + 1] = Math.round((out[i * 4 + 1] / a) * 255);
    rgba[i * 4 + 2] = Math.round((out[i * 4 + 2] / a) * 255);
    rgba[i * 4 + 3] = Math.round(a * 255);
  }
  return rgba;
}

export async function renderEntry(base, size, options, resize) {
  const inner = innerSize(size, options.padding);
  const scaled = await scaleSource(base, inner, {
    filter: options.filter,
    sharpen: options.sharpen ?? autoSharpen(size),
    upscale: options.upscale,
  }, resize);
  return composeEntry(size, scaled, inner, options);
}

export function parseHexColor(hex, alpha = 1) {
  const value = String(hex || '').trim().replace(/^#/, '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: alpha,
  };
}
