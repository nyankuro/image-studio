// Khung cắt vuông { x, y, size } theo pixel của ảnh đã xoay/lật.
// Khung có thể lớn hơn ảnh (thu nhỏ hết cỡ = lấy cả ảnh, phần thừa trong suốt).
// Trên mỗi trục: khung nhỏ hơn ảnh thì phải nằm trong ảnh,
// khung lớn hơn ảnh thì ảnh phải nằm trong khung.

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function minCropSize(width, height) {
  return Math.max(1, Math.min(8, width, height));
}

export function defaultCrop(width, height) {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

function clampAxis(pos, size, dim) {
  return size <= dim ? clamp(pos, 0, dim - size) : clamp(pos, dim - size, 0);
}

export function clampCrop(crop, width, height) {
  const size = clamp(Number(crop.size) || 0, minCropSize(width, height), Math.max(width, height));
  return {
    x: clampAxis(Number(crop.x) || 0, size, width),
    y: clampAxis(Number(crop.y) || 0, size, height),
    size,
  };
}

// Phóng/thu khung quanh điểm neo (u, v là vị trí 0..1 bên trong khung).
export function zoomCrop(crop, factor, u, v, width, height) {
  const size = clamp(crop.size * factor, minCropSize(width, height), Math.max(width, height));
  return clampCrop({
    x: crop.x + (crop.size - size) * clamp(u, 0, 1),
    y: crop.y + (crop.size - size) * clamp(v, 0, 1),
    size,
  }, width, height);
}

export function panCrop(crop, dx, dy, width, height) {
  return clampCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }, width, height);
}

export function flipCrop(crop, width, height, horizontal) {
  return horizontal
    ? clampCrop({ ...crop, x: width - crop.x - crop.size }, width, height)
    : clampCrop({ ...crop, y: height - crop.y - crop.size }, width, height);
}

export function sameCrop(a, b) {
  return Boolean(a && b) && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.size - b.size) < 1e-6;
}

export function cropKey(crop) {
  return crop ? `${crop.x.toFixed(3)},${crop.y.toFixed(3)},${crop.size.toFixed(3)}` : 'none';
}

// Phần ảnh nằm trong khung và vị trí của nó trên ảnh đích out × out.
// Ảnh nguồn được thu theo scaleX/scaleY (tầng thu nhỏ). Trả về null nếu khung không chạm ảnh.
export function cropDrawRect(crop, width, height, out, scaleX = 1, scaleY = scaleX) {
  const sx0 = Math.max(crop.x, 0);
  const sy0 = Math.max(crop.y, 0);
  const sx1 = Math.min(crop.x + crop.size, width);
  const sy1 = Math.min(crop.y + crop.size, height);
  if (sx1 <= sx0 || sy1 <= sy0) return null;
  const k = out / crop.size;
  return {
    sx: sx0 * scaleX,
    sy: sy0 * scaleY,
    sw: (sx1 - sx0) * scaleX,
    sh: (sy1 - sy0) * scaleY,
    dx: (sx0 - crop.x) * k,
    dy: (sy0 - crop.y) * k,
    dw: (sx1 - sx0) * k,
    dh: (sy1 - sy0) * k,
  };
}
