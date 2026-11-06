import { encodePng } from './png-encode.js';
import { ALPHA_CUTOFF, quantize } from './palette.js';

// Ghi và đọc file .ico chứa nhiều kích thước.
// Định dạng mỗi entry (giống bảng của RedKetchup):
//   bmp32: BMP 32-bit, true color, có alpha (mặc định, tương thích nhất)
//   png  : PNG 32-bit, true color, có alpha (nhẹ nhất)
//   bmp24: BMP 24-bit, true color, không alpha (trong suốt bằng mặt nạ AND)
//   bmp8 : BMP 8-bit, 256 màu, không alpha
//   bmp4 : BMP 4-bit, 16 màu, không alpha
// Entry lớn hơn 256 px luôn được lưu PNG.

export const ICO_MAX_BMP_SIZE = 256;
export const ICO_FORMATS = [
  { value: 'bmp32', label: 'BMP 32-bit', bits: 32 },
  { value: 'png', label: 'PNG 32-bit', bits: 32 },
  { value: 'bmp24', label: 'BMP 24-bit', bits: 24 },
  { value: 'bmp8', label: 'BMP 8-bit · 256 colors', bits: 8 },
  { value: 'bmp4', label: 'BMP 4-bit · 16 colors', bits: 4 },
];
const BITS = Object.fromEntries(ICO_FORMATS.map((format) => [format.value, format.bits]));

export function resolveEntryFormat(size, preferred = 'bmp32') {
  if (size > ICO_MAX_BMP_SIZE) return 'png';
  if (preferred === 'auto') return size >= ICO_MAX_BMP_SIZE ? 'png' : 'bmp32';
  if (preferred === 'bmp') return 'bmp32';
  return BITS[preferred] ? preferred : 'bmp32';
}

// Ảnh entry trông thế nào sau khi lưu (để xem trước đúng với định dạng đã chọn).
export function storedRgba(rgba, size, format) {
  const resolved = resolveEntryFormat(size, format);
  if (resolved === 'bmp32' || resolved === 'png') return rgba;
  const out = new Uint8ClampedArray(size * size * 4);
  if (resolved === 'bmp24') {
    for (let i = 0; i < size * size; i += 1) {
      if (rgba[i * 4 + 3] < ALPHA_CUTOFF) continue;
      out[i * 4] = rgba[i * 4];
      out[i * 4 + 1] = rgba[i * 4 + 1];
      out[i * 4 + 2] = rgba[i * 4 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  const { palette, indices, transparent } = quantize(rgba, size, 1 << BITS[resolved]);
  for (let i = 0; i < size * size; i += 1) {
    if (transparent[i]) continue;
    const [r, g, b] = palette[indices[i]];
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function encodeBmpEntry(rgba, size, bits) {
  const paletteSize = bits <= 8 ? 1 << bits : 0;
  const quantized = bits <= 8 ? quantize(rgba, size, paletteSize) : null;
  const xorStride = Math.ceil((size * bits) / 32) * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const xorBytes = xorStride * size;
  const maskBytes = maskStride * size;
  const pixelOffset = 40 + paletteSize * 4;
  const bytes = new Uint8Array(pixelOffset + xorBytes + maskBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 40, true); // BITMAPINFOHEADER
  view.setInt32(4, size, true);
  view.setInt32(8, size * 2, true); // chiều cao gồm cả mặt nạ AND
  view.setUint16(12, 1, true);
  view.setUint16(14, bits, true);
  view.setUint32(16, 0, true); // BI_RGB
  view.setUint32(20, xorBytes + maskBytes, true);
  view.setUint32(32, paletteSize, true);
  if (quantized) {
    quantized.palette.forEach(([r, g, b], index) => {
      bytes[40 + index * 4] = b;
      bytes[40 + index * 4 + 1] = g;
      bytes[40 + index * 4 + 2] = r;
    });
  }
  const isTransparent = (i) => (bits === 32 ? rgba[i * 4 + 3] === 0 : quantized ? quantized.transparent[i] === 1 : rgba[i * 4 + 3] < ALPHA_CUTOFF);
  for (let y = size - 1; y >= 0; y -= 1) {
    const row = pixelOffset + (size - 1 - y) * xorStride;
    const mask = pixelOffset + xorBytes + (size - 1 - y) * maskStride;
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const clear = isTransparent(i);
      if (clear) bytes[mask + (x >> 3)] |= 0x80 >> (x & 7);
      if (bits === 32) {
        bytes[row + x * 4] = rgba[i * 4 + 2];
        bytes[row + x * 4 + 1] = rgba[i * 4 + 1];
        bytes[row + x * 4 + 2] = rgba[i * 4];
        bytes[row + x * 4 + 3] = rgba[i * 4 + 3];
      } else if (clear) {
        continue;
      } else if (bits === 24) {
        bytes[row + x * 3] = rgba[i * 4 + 2];
        bytes[row + x * 3 + 1] = rgba[i * 4 + 1];
        bytes[row + x * 3 + 2] = rgba[i * 4];
      } else if (bits === 8) {
        bytes[row + x] = quantized.indices[i];
      } else {
        bytes[row + (x >> 1)] |= (x & 1) ? quantized.indices[i] : quantized.indices[i] << 4;
      }
    }
  }
  return bytes;
}

// entries: [{ size, rgba (Uint8Array/Uint8ClampedArray size*size*4), format }]
export async function buildIco(entries) {
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  const images = [];
  for (const entry of sorted) {
    const format = resolveEntryFormat(entry.size, entry.format);
    const bits = BITS[format];
    const data = format === 'png'
      ? await encodePng(entry.rgba, entry.size, entry.size)
      : encodeBmpEntry(entry.rgba, entry.size, bits);
    images.push({ size: entry.size, format, bits, data });
  }
  const headerSize = 6 + 16 * images.length;
  const total = headerSize + images.reduce((sum, image) => sum + image.data.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let dataOffset = headerSize;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    const dimension = image.size >= 256 ? 0 : image.size;
    bytes[at] = dimension;
    bytes[at + 1] = dimension;
    bytes[at + 2] = image.bits === 4 ? 16 : 0;
    bytes[at + 3] = 0;
    view.setUint16(at + 4, 1, true);
    view.setUint16(at + 6, image.bits, true);
    view.setUint32(at + 8, image.data.length, true);
    view.setUint32(at + 12, dataOffset, true);
    bytes.set(image.data, dataOffset);
    dataOffset += image.data.length;
  });
  return { bytes, entries: images.map(({ size, format, data }) => ({ size, format, bytes: data.length })) };
}

function decodeBmp(data) {
  const bmp = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerSize = bmp.getUint32(0, true);
  const w = bmp.getInt32(4, true);
  const h = bmp.getInt32(8, true) / 2;
  const bits = bmp.getUint16(14, true);
  const colors = bits <= 8 ? bmp.getUint32(32, true) || 1 << bits : 0;
  const palette = [];
  for (let i = 0; i < colors; i += 1) {
    const at = headerSize + i * 4;
    palette.push([data[at + 2], data[at + 1], data[at]]);
  }
  const xorStride = Math.ceil((w * bits) / 32) * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const pixels = headerSize + colors * 4;
  const masks = pixels + xorStride * h;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const row = pixels + (h - 1 - y) * xorStride;
    const maskRow = masks + (h - 1 - y) * maskStride;
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      let color;
      let alpha = 255;
      if (bits === 32) {
        color = [data[row + x * 4 + 2], data[row + x * 4 + 1], data[row + x * 4]];
        alpha = data[row + x * 4 + 3];
      } else if (bits === 24) {
        color = [data[row + x * 3 + 2], data[row + x * 3 + 1], data[row + x * 3]];
      } else if (bits === 8) {
        color = palette[data[row + x]] || [0, 0, 0];
      } else {
        const byte = data[row + (x >> 1)];
        color = palette[(x & 1) ? byte & 15 : byte >> 4] || [0, 0, 0];
      }
      if (bits !== 32 && data[maskRow + (x >> 3)] & (0x80 >> (x & 7))) {
        color = [0, 0, 0];
        alpha = 0;
      }
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = alpha;
    }
  }
  return { width: w, height: h, bits, rgba };
}

// Đọc thư mục ICO; entry BMP (4/8/24/32-bit) được giải mã ra RGBA, entry PNG trả về byte gốc.
export function readIco(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) throw new Error('Not a valid ICO file.');
  const count = view.getUint16(4, true);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const width = bytes[at] || 256;
    const height = bytes[at + 1] || 256;
    const length = view.getUint32(at + 8, true);
    const offset = view.getUint32(at + 12, true);
    const data = bytes.subarray(offset, offset + length);
    const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    const entry = { width, height, bitCount: view.getUint16(at + 6, true), colorCount: bytes[at + 2], format: isPng ? 'png' : 'bmp', data };
    if (!isPng) Object.assign(entry, decodeBmp(data));
    entries.push(entry);
  }
  return entries;
}
