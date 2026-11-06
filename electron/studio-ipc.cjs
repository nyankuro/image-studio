const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const { fileURLToPath } = require('url');
const { magick, magickEnv } = require('./magick.cjs');
const { tr } = require('./i18n.cjs');

// Định dạng mà Chromium tự giải mã được; các định dạng khác (HEIC, TIFF, PSD...)
// được ImageMagick chuyển sang PNG trước khi gửi cho renderer.
const BROWSER_IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};
const MAGICK_IMAGE_EXTENSIONS = ['heic', 'heif', 'tif', 'tiff', 'psd', 'tga', 'jxl', 'jp2', 'dds', 'pcx', 'ppm', 'pgm', 'qoi'];
const MAX_INPUT_BYTES = 200 * 1024 * 1024;

function extensionOf(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

function runMagickToPng(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(magick().command, [`${inputPath}[0]`, '-auto-orient', 'png32:-'], { windowsHide: true, env: magickEnv() });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(new Error(tr('error.magickStart', { message: error.message }))));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || tr('error.magickExit', { code })));
    });
  });
}

async function decodeForRenderer(name, bytes) {
  const ext = extensionOf(name);
  if (BROWSER_IMAGE_TYPES[ext]) return { name, mime: BROWSER_IMAGE_TYPES[ext], bytes: new Uint8Array(bytes), converted: false };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-studio-'));
  const tempPath = path.join(dir, `input.${ext || 'img'}`);
  try {
    await fs.writeFile(tempPath, bytes);
    const png = await runMagickToPng(tempPath);
    return { name, mime: 'image/png', bytes: new Uint8Array(png), converted: true };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readImageFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return null;
  if (stat.size > MAX_INPUT_BYTES) throw new Error(tr('error.tooLarge'));
  const bytes = await fs.readFile(filePath);
  return { ...(await decodeForRenderer(path.basename(filePath), bytes)), path: filePath, fileBytes: stat.size };
}

function isImagePath(filePath) {
  const ext = extensionOf(filePath);
  return Boolean(BROWSER_IMAGE_TYPES[ext]) || MAGICK_IMAGE_EXTENSIONS.includes(ext);
}

function toPath(value) {
  const text = String(value || '').trim().replace(/^"(.*)"$/, '$1');
  if (!text || text.includes('\n') || text.length > 2048) return null;
  try {
    if (text.startsWith('file://')) return fileURLToPath(text);
  } catch {
    return null;
  }
  return path.isAbsolute(text) ? text : null;
}

// Clipboard có hai kiểu API: Electron 44+ dùng kiểu W3C bất đồng bộ (read() trả về
// ClipboardItem), bản cũ có readImage/readBuffer. Hai hàm dưới đây đọc ra cùng một
// dạng: các đường dẫn tệp (tệp sao chép từ Explorer/Finder, hoặc một dòng chữ là
// đường dẫn) và một hàm đọc ảnh, chỉ gọi khi không có tệp ảnh nào dùng được.
const RAW_FILE_NAME_W = /format="?FileNameW"?/i;
const RAW_MAC_FILE_URL = /format="?public\.file-url"?/i;
const CLIPBOARD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

async function blobBuffer(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

async function readModernClipboard(clipboard) {
  const paths = [];
  const images = [];
  let items = [];
  try {
    items = await clipboard.read();
  } catch {
    items = [];
  }
  for (const item of items || []) {
    for (const type of item.types || []) {
      try {
        if (RAW_FILE_NAME_W.test(type)) {
          paths.push((await blobBuffer(await item.getType(type))).toString('utf16le').split('\0')[0]);
        } else if (RAW_MAC_FILE_URL.test(type)) {
          paths.push(toPath((await blobBuffer(await item.getType(type))).toString('utf8').replace(/\0+$/, '')));
        } else if (type === 'text/uri-list') {
          for (const line of (await blobBuffer(await item.getType(type))).toString('utf8').split(/\r?\n/)) paths.push(toPath(line));
        } else if (type === 'text/plain') {
          paths.push(toPath((await blobBuffer(await item.getType(type))).toString('utf8')));
        } else if (CLIPBOARD_IMAGE_TYPES.includes(type)) {
          images.push({ item, type });
        }
      } catch {
        // Định dạng này không đọc được thì bỏ qua.
      }
    }
  }
  images.sort((a, b) => CLIPBOARD_IMAGE_TYPES.indexOf(a.type) - CLIPBOARD_IMAGE_TYPES.indexOf(b.type));
  return {
    paths: [...new Set(paths.filter(Boolean))],
    async image() {
      for (const { item, type } of images) {
        try {
          const bytes = await blobBuffer(await item.getType(type));
          if (bytes.length) return { bytes, mime: type };
        } catch {
          // Thử định dạng ảnh tiếp theo.
        }
      }
      return null;
    },
  };
}

function readLegacyClipboard(clipboard) {
  const found = [];
  try {
    if (process.platform === 'win32') {
      const raw = clipboard.readBuffer('FileNameW');
      if (raw && raw.length) found.push(raw.toString('utf16le').split('\0')[0]);
    } else if (process.platform === 'darwin') {
      found.push(toPath(clipboard.read('public.file-url')));
    } else {
      for (const line of String(clipboard.read('text/uri-list') || '').split(/\r?\n/)) found.push(toPath(line));
    }
  } catch {
    // Định dạng clipboard không có trên máy này.
  }
  try {
    found.push(toPath(clipboard.readText()));
  } catch {
    // Không đọc được chữ trong clipboard.
  }
  return {
    paths: [...new Set(found.filter(Boolean))],
    async image() {
      const native = clipboard.readImage();
      if (!native || native.isEmpty()) return null;
      return { bytes: native.toPNG(), mime: 'image/png' };
    },
  };
}

async function readClipboardContent(clipboard) {
  return typeof clipboard.readImage === 'function' ? readLegacyClipboard(clipboard) : readModernClipboard(clipboard);
}

async function readClipboardImage(clipboard, { bitmap = true } = {}) {
  if (!clipboard) return null;
  const content = await readClipboardContent(clipboard);
  for (const filePath of content.paths) {
    if (!isImagePath(filePath)) continue;
    try {
      const result = await readImageFile(filePath);
      if (result) return result;
    } catch {
      // Tệp không đọc được thì thử nguồn tiếp theo.
    }
  }
  if (!bitmap) return null;
  const image = await content.image();
  if (!image) return null;
  const ext = image.mime.split('/')[1].replace('jpeg', 'jpg');
  return { name: `icon.${ext}`, mime: image.mime, bytes: new Uint8Array(image.bytes), converted: false, fileBytes: image.bytes.length };
}

// electron được truyền vào từ main.cjs (không require trực tiếp) để test backend
// có thể nạp main.cjs với ipcMain giả.
function registerStudioIpc({ ipcMain, dialog, BrowserWindow, clipboard, shell }) {
  const senderWindow = (event) => BrowserWindow?.fromWebContents?.(event.sender) || undefined;

  ipcMain.handle('image:pick', async (event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: tr('dialog.pickImage'),
      properties: ['openFile'],
      filters: [
        { name: tr('dialog.filterImages'), extensions: [...Object.keys(BROWSER_IMAGE_TYPES), ...MAGICK_IMAGE_EXTENSIONS] },
        { name: tr('dialog.filterAll'), extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return readImageFile(result.filePaths[0]);
  });

  ipcMain.handle('clipboard:image', (_event, options) => readClipboardImage(clipboard, options || {}));

  ipcMain.handle('file:reveal', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath && shell) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('image:decode', async (_event, payload) => {
    const bytes = payload?.bytes;
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error(tr('error.noImageData'));
    if (bytes.length > MAX_INPUT_BYTES) throw new Error(tr('error.tooLarge'));
    return decodeForRenderer(payload.name || 'image', Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });

  // Lưu file .ico; nếu có danh sách PNG thì ghi thêm thư mục "<tên>-png" bên cạnh.
  ipcMain.handle('icon:save', async (event, payload) => {
    const ico = payload?.ico;
    if (!(ico instanceof Uint8Array) || !ico.length) throw new Error(tr('error.noIconData'));
    const defaultName = String(payload.defaultName || 'icon.ico').replace(/[\\/:*?"<>|]/g, '_');
    const result = await dialog.showSaveDialog(senderWindow(event), {
      title: tr('dialog.saveIcon'),
      defaultPath: payload.defaultDir ? path.join(payload.defaultDir, defaultName) : defaultName,
      filters: [{ name: 'Windows Icon', extensions: ['ico'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const icoPath = result.filePath.toLowerCase().endsWith('.ico') ? result.filePath : `${result.filePath}.ico`;
    await fs.writeFile(icoPath, ico);
    let pngFolder = null;
    if (Array.isArray(payload.pngs) && payload.pngs.length) {
      pngFolder = path.join(path.dirname(icoPath), `${path.basename(icoPath, path.extname(icoPath))}-png`);
      await fs.mkdir(pngFolder, { recursive: true });
      for (const png of payload.pngs) {
        const name = path.basename(String(png.name || '')).replace(/[\\/:*?"<>|]/g, '_');
        if (!name || !(png.bytes instanceof Uint8Array)) continue;
        await fs.writeFile(path.join(pngFolder, name), png.bytes);
      }
    }
    return { icoPath, pngFolder };
  });
}

module.exports = { registerStudioIpc, decodeForRenderer, readClipboardContent, readClipboardImage };
