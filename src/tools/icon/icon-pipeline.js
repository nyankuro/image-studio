import { cropKey } from '../../lib/crop-math.js';
import { autoSharpen, composeEntry, innerSize, scaleSource } from '../../lib/icon-render.js';
import { buildPyramid, fastScaled, pickLevel, resizeBuffer, stagePixels } from './image-source.js';

const CACHE_LIMIT = 96;

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
  return value;
}

// strength: 0..200 (%), 100 = mức tự động theo size.
export function sharpenForStrength(size, strength = 100) {
  const auto = autoSharpen(size);
  return { amount: Math.round((auto.amount * Math.max(0, strength)) / 100), radius: auto.radius };
}

// look: { padding (0..0.25), shape, background, stroke, filter, sharpen (%), upscale }
// Dựng từng size từ tầng ảnh vừa đủ lớn rồi thu bằng pica; kết quả được nhớ lại
// nên đổi bo góc chỉ phải ghép lại mặt nạ, còn xuất file dùng ngay ảnh đã dựng.
export class IconRenderer {
  constructor() {
    this.pyramid = null;
    this.version = 0;
    this.stages = new Map();
    this.scaled = new Map();
    this.entries = new Map();
  }

  setSource(oriented) {
    this.pyramid = oriented ? buildPyramid(oriented) : null;
    this.version += 1;
    this.stages.clear();
    this.scaled.clear();
    this.entries.clear();
  }

  stage(crop, need) {
    const key = `${cropKey(crop)}|L${pickLevel(this.pyramid, crop.size, need)}`;
    const hit = this.stages.get(key);
    if (hit) return hit;
    return remember(this.stages, key, stagePixels(this.pyramid, crop, need).base);
  }

  async entry(size, crop, look) {
    if (!this.pyramid) throw Object.assign(new Error('No image is open.'), { code: 'noImage' });
    const version = this.version;
    const inner = innerSize(size, look.padding);
    const sharpen = sharpenForStrength(size, look.sharpen);
    const scaledKey = `${cropKey(crop)}|${inner}|${look.filter}|${sharpen.amount}|${sharpen.radius}|${look.upscale}`;
    const entryKey = `${size}|${scaledKey}|${JSON.stringify([look.shape, look.background, look.stroke])}`;
    const cached = this.entries.get(entryKey);
    if (cached) return cached;
    let scaled = this.scaled.get(scaledKey);
    if (!scaled) {
      const base = this.stage(crop, inner * 2);
      scaled = await scaleSource(base, inner, { filter: look.filter, sharpen, upscale: look.upscale }, resizeBuffer);
      if (version !== this.version) return composeEntry(size, scaled, inner, look);
      remember(this.scaled, scaledKey, scaled);
    }
    return remember(this.entries, entryKey, composeEntry(size, scaled, inner, look));
  }

  fast(size, crop, look) {
    if (!this.pyramid) return null;
    const inner = innerSize(size, look.padding);
    return composeEntry(size, fastScaled(this.pyramid, crop, inner), inner, look);
  }
}
