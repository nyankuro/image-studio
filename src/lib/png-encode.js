// Bộ mã hóa PNG RGBA 8-bit tối giản, chạy được cả trong Electron renderer
// lẫn Node (dùng CompressionStream 'deflate' = định dạng zlib mà PNG cần).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Chọn bộ lọc theo từng hàng (None/Sub/Up/Average/Paeth) bằng tổng trị tuyệt đối nhỏ nhất.
function filterScanlines(rgba, width, height) {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const prev = row - stride;
    let bestScore = Infinity;
    let bestType = 0;
    for (let type = 0; type < 5; type += 1) {
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const raw = rgba[row + i];
        const left = i >= 4 ? rgba[row + i - 4] : 0;
        const up = y > 0 ? rgba[prev + i] : 0;
        const upLeft = y > 0 && i >= 4 ? rgba[prev + i - 4] : 0;
        let value;
        if (type === 0) value = raw;
        else if (type === 1) value = raw - left;
        else if (type === 2) value = raw - up;
        else if (type === 3) value = raw - ((left + up) >> 1);
        else value = raw - paeth(left, up, upLeft);
        value &= 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(candidate);
      }
    }
    const offset = y * (stride + 1);
    out[offset] = bestType;
    out.set(best, offset + 1);
  }
  return out;
}

function chunk(type, data) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes, 4, 8 + data.length));
  return bytes;
}

export async function encodePng(rgba, width, height) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const idat = await deflate(filterScanlines(rgba, width, height));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
