const popularFormats = require('../shared/popular-formats.json');

// Đọc danh sách định dạng của ImageMagick ("magick -list format").
//
// Bản ImageMagick cài đặt (dựng theo module) in cột Module:
//      3FR  DNG       r--   Hasselblad CFV/H3D39II Raw Format
// Bản dựng tĩnh, như bản portable đi kèm app, không có cột này:
//      3FR  r--   Hasselblad CFV/H3D39II Raw Format
// Khi thiếu cột Module, module của từng định dạng được tra trong "magick -list coder"
// (định dạng không có trong đó thì module trùng tên định dạng).

const LOSSLESS_FORMATS = new Set(['PNG', 'PNG24', 'PNG32', 'PNG48', 'PNG64', 'TIFF', 'TIF', 'BMP', 'GIF', 'WEBP', 'JXL', 'AVIF', 'EXR', 'QOI', 'TGA', 'PPM', 'PNM', 'PAM']);
const PSEUDO_MODULES = new Set(['VIDEO', 'URL', 'TTF', 'BRAILLE', 'HTML', 'INFO', 'INLINE', 'LABEL', 'GRADIENT', 'PLASMA', 'SCREENSHOT', 'TXT', 'XC', 'NULL', 'MSL']);
const PSEUDO_FORMATS = new Set(['CAPTION', 'CANVAS', 'CLIPBOARD', 'DATA', 'DFONT', 'FILE', 'FRACTAL', 'FTP', 'GRADIENT', 'HALD', 'HISTOGRAM', 'HTTP', 'HTTPS', 'INFO', 'INLINE', 'JSON', 'LABEL', 'MASK', 'MATTE', 'NULL', 'PANGO', 'PATTERN', 'PLASMA', 'RADIAL-GRADIENT', 'SCREENSHOT', 'SPARSE-COLOR', 'STEGANO', 'TEXT', 'THUMBNAIL', 'TILE', 'TTF', 'UIL', 'YAML']);
const DOCUMENT_MODULES = new Set(['PDF', 'PS', 'XPS', 'PCL']);

// Tên, (module), chế độ đọc/ghi/nhiều ảnh, mô tả.
const FORMAT_LINE = /^\s*([A-Z0-9-]+)\*?\s+(?:([A-Z0-9-]+)\s+)?([r-][w-][+-])\s+(.+)$/i;

function normalizeExt(name) {
  return String(name || '').replace(/^\./, '').toUpperCase();
}

function compareFormats(a, b) {
  const aRank = popularFormats.indexOf(normalizeExt(a));
  const bRank = popularFormats.indexOf(normalizeExt(b));
  return (aRank < 0 ? popularFormats.length : aRank) - (bRank < 0 ? popularFormats.length : bRank)
    || a.localeCompare(b);
}

function hasModuleColumn(listFormatOutput) {
  return /^\s*Format\s+Module\s+Mode\b/im.test(String(listFormatOutput || ''));
}

// "magick -list coder": mỗi dòng là một tên định dạng và coder (module) xử lý nó.
function parseCoders(stdout) {
  const coders = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9-]+)\s+([A-Z0-9-]+)\s*$/i);
    if (!match || /^magick$/i.test(match[1])) continue;
    coders.set(match[1].toUpperCase(), match[2].toUpperCase());
  }
  return coders;
}

function parseFormats(stdout, coders = new Map()) {
  const formats = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(FORMAT_LINE);
    if (!match) continue;
    const [, rawName, module, mode, description] = match;
    const name = rawName.toUpperCase();
    const moduleName = (module || coders.get(name) || name).toUpperCase();
    if (PSEUDO_FORMATS.has(name) || PSEUDO_MODULES.has(moduleName)) continue;
    formats.push({
      name,
      module: moduleName,
      canRead: mode[0] === 'r',
      canWrite: mode[1] === 'w',
      multiImage: mode[2] === '+',
      description: description.trim(),
      lossless: LOSSLESS_FORMATS.has(name) || LOSSLESS_FORMATS.has(moduleName),
      document: DOCUMENT_MODULES.has(moduleName),
    });
  }

  const deduped = new Map();
  for (const format of formats) {
    const previous = deduped.get(format.name);
    if (!previous) {
      deduped.set(format.name, format);
    } else {
      deduped.set(format.name, {
        ...previous,
        canRead: previous.canRead || format.canRead,
        canWrite: previous.canWrite || format.canWrite,
        multiImage: previous.multiImage || format.multiImage,
        lossless: previous.lossless || format.lossless,
      });
    }
  }

  return Array.from(deduped.values()).sort((a, b) => compareFormats(a.name, b.name));
}

module.exports = { normalizeExt, compareFormats, hasModuleColumn, parseCoders, parseFormats };
