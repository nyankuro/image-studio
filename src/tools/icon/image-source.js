import pica from 'pica';
import { cropDrawRect } from '../../lib/crop-math.js';
import { halveRGBA } from '../../lib/resample.js';

// Chỉ dùng phần JS thuần của pica: không web worker, không WebAssembly,
// nên chạy được với Content-Security-Policy chặt của app.
export const resizer = pica({ features: ['js'] });
export const resizeBuffer = (options) => resizer.resizeBuffer(options);

const RENDERER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml', 'image/avif']);
const RENDERER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'jpe', 'webp', 'gif', 'bmp', 'ico', 'svg', 'avif']);
export const SVG_RASTER_SIZE = 1024;

function extensionOf(name = '') {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Mọi canvas xử lý ảnh đều để ở bộ nhớ thường (willReadFrequently) để vẽ qua lại
// và đọc pixel không phải chép từ GPU về.
function ctx2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(Object.assign(new Error('Could not read the SVG image.'), { code: 'svg' }));
    image.src = url;
  });
}

// bytes + mime → canvas chứa ảnh gốc. SVG được dựng ở cạnh dài 1024 px.
export async function decodeToCanvas({ bytes, mime, name }) {
  const isSvg = mime === 'image/svg+xml' || extensionOf(name) === 'svg';
  const blob = new Blob([bytes], { type: isSvg ? 'image/svg+xml' : mime || 'application/octet-stream' });
  if (isSvg) {
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImageElement(url);
      const w = image.naturalWidth || SVG_RASTER_SIZE;
      const h = image.naturalHeight || SVG_RASTER_SIZE;
      const scale = SVG_RASTER_SIZE / Math.max(w, h);
      const canvas = makeCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
      ctx2d(canvas).drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  ctx2d(canvas).drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

// Đọc File từ kéo-thả hoặc clipboard. Định dạng Chromium không đọc được thì nhờ ImageMagick.
export async function decodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name || 'clipboard.png';
  const ext = extensionOf(name);
  const rendererCanRead = RENDERER_TYPES.has(file.type) || (!file.type && RENDERER_EXTENSIONS.has(ext));
  if (rendererCanRead) {
    try {
      const canvas = await decodeToCanvas({ bytes, mime: file.type, name });
      return { canvas, name, fileBytes: bytes.length, converted: false };
    } catch {
      // Thử lại bằng ImageMagick bên dưới.
    }
  }
  const decoded = await window.imageBridge.decodeImage({ name, bytes });
  const canvas = await decodeToCanvas(decoded);
  return { canvas, name, fileBytes: bytes.length, converted: decoded.converted };
}

// Kết quả từ tiến trình chính (hộp thoại mở tệp hoặc clipboard) → nguồn ảnh.
export async function fromBridge(picked) {
  if (!picked) return null;
  const canvas = await decodeToCanvas(picked);
  return { canvas, name: picked.name, path: picked.path, fileBytes: picked.fileBytes, converted: picked.converted };
}

export async function pickAndDecode() {
  return fromBridge(await window.imageBridge.pickImage());
}

const MAGICK_EXTENSIONS = new Set(['heic', 'heif', 'tif', 'tiff', 'psd', 'tga', 'jxl', 'jp2', 'dds', 'pcx', 'ppm', 'pgm', 'qoi']);

export function isImageFile(file) {
  if (!file) return false;
  const ext = extensionOf(file.name);
  return String(file.type).startsWith('image/') || RENDERER_EXTENSIONS.has(ext) || MAGICK_EXTENSIONS.has(ext);
}

// Áp dụng xoay (0/90/180/270) và lật lên canvas gốc.
export function orientCanvas(source, rotation, flipH, flipV) {
  const turns = ((rotation % 360) + 360) % 360;
  const swap = turns === 90 || turns === 270;
  const canvas = makeCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
  const ctx = ctx2d(canvas);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  // Lật theo hướng đang nhìn thấy (sau khi xoay).
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.rotate((turns * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

// Tầng ảnh thu nhỏ đúng một nửa liên tiếp (trung bình 2×2 theo alpha, như mipmap).
// Mỗi lần dựng icon chỉ đọc tầng vừa đủ lớn cho size cần dựng, nên ảnh gốc to cỡ
// nào kéo khung vẫn nhẹ, và không có bước co giãn nào của trình duyệt chen vào.
export function buildPyramid(oriented) {
  const { data } = ctx2d(oriented).getImageData(0, 0, oriented.width, oriented.height);
  const levels = [{ data, width: oriented.width, height: oriented.height, scale: 1, canvas: oriented }];
  let current = levels[0];
  while (Math.max(current.width, current.height) > 48) {
    const half = halveRGBA(current.data, current.width, current.height);
    current = { ...half, scale: current.scale / 2, canvas: null };
    levels.push(current);
  }
  return { levels, width: oriented.width, height: oriented.height };
}

function levelCanvas(level) {
  if (!level.canvas) {
    level.canvas = makeCanvas(level.width, level.height);
    ctx2d(level.canvas).putImageData(new ImageData(level.data, level.width, level.height), 0, 0);
  }
  return level.canvas;
}

// Tầng nhỏ nhất mà vùng cắt vẫn còn ít nhất `need` pixel.
export function pickLevel(pyramid, cropSize, need) {
  for (let index = pyramid.levels.length - 1; index > 0; index -= 1) {
    if (cropSize * pyramid.levels[index].scale >= need) return index;
  }
  return 0;
}

// Điểm ảnh của vùng cắt ở đúng độ phân giải của tầng (chép thẳng, không nội suy).
// Phần khung nằm ngoài ảnh để trong suốt.
export function stagePixels(pyramid, crop, need) {
  const index = pickLevel(pyramid, crop.size, need);
  const level = pyramid.levels[index];
  const side = Math.max(1, Math.round(crop.size * level.scale));
  const left = Math.round(crop.x * level.scale);
  const top = Math.round(crop.y * level.scale);
  const data = new Uint8ClampedArray(side * side * 4);
  const x0 = Math.max(0, left);
  const x1 = Math.min(level.width, left + side);
  if (x1 > x0) {
    for (let y = 0; y < side; y += 1) {
      const sy = top + y;
      if (sy < 0 || sy >= level.height) continue;
      const from = (sy * level.width + x0) * 4;
      data.set(level.data.subarray(from, from + (x1 - x0) * 4), (y * side + (x0 - left)) * 4);
    }
  }
  return { index, base: { data, width: side, height: side } };
}

let fastCanvas = null;

// Bản thu nhanh bằng bộ co giãn của trình duyệt, chỉ dùng khi đang kéo khung.
export function fastScaled(pyramid, crop, inner) {
  const level = pyramid.levels[pickLevel(pyramid, crop.size, inner)];
  if (!fastCanvas) fastCanvas = makeCanvas(inner, inner);
  if (fastCanvas.width !== inner) {
    fastCanvas.width = inner;
    fastCanvas.height = inner;
  }
  const ctx = ctx2d(fastCanvas);
  ctx.clearRect(0, 0, inner, inner);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const rect = cropDrawRect(crop, pyramid.width, pyramid.height, inner, level.scale, level.scale);
  if (rect) ctx.drawImage(levelCanvas(level), rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
  return ctx.getImageData(0, 0, inner, inner).data;
}
