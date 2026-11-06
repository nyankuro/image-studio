const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, net, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { getExecutionLimits, runConcurrent } = require('./conversion-queue.cjs');
const pdfDpiOptions = require('../shared/pdf-dpi.json');
const { registerStudioIpc } = require('./studio-ipc.cjs');
const { tr, setLanguage } = require('./i18n.cjs');
const { magick, magickEnv, magickVersion, ghostscriptAvailable } = require('./magick.cjs');
const { LINKS, checkForUpdate, isAllowedExternal } = require('./update-check.cjs');
const { normalizeExt, compareFormats, hasModuleColumn, parseCoders, parseFormats } = require('./formats.cjs');

const execFileAsync = promisify(execFile);
const APP_ID = 'io.github.nyankuro.imagestudio';
const devServerUrl = process.env.VITE_DEV_SERVER_URL || (process.env.npm_lifecycle_event === 'dev' ? 'http://127.0.0.1:5173' : null);

let cachedFormats = null;
let mainWindow = null;

// ---------------------------------------------------------------------------
// Cửa sổ và vòng đời app
// ---------------------------------------------------------------------------

function windowIcon() {
  return path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

function createWindow() {
  // Cửa sổ vừa với màn hình hiện tại, để không phần nào bị khuất khi không phóng to.
  const area = screen?.getPrimaryDisplay?.().workAreaSize || { width: 1360, height: 860 };
  const win = new BrowserWindow({
    width: Math.max(960, Math.min(1360, area.width - 40)),
    height: Math.max(620, Math.min(860, area.height - 40)),
    minWidth: 960,
    minHeight: 600,
    title: 'Image Studio',
    icon: windowIcon(),
    backgroundColor: '#0f1318',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  // Không cho cửa sổ rời khỏi app: thả nhầm tệp hay bấm link thì không đổi trang.
  // Link được phép (Ko-fi, GitHub, Ghostscript) mở bằng trình duyệt.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  return win;
}

function focusMainWindow() {
  const win = mainWindow || BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Hồ sơ riêng cho test (IMAGE_STUDIO_PROFILE) để chạy test không xóa thiết lập
// thật và chạy được cả khi app đang mở.
const testProfile = process.env.IMAGE_STUDIO_PROFILE;
if (app.setPath && app.getPath) {
  app.setPath('userData', testProfile || path.join(app.getPath('appData'), 'image-studio'));
}
const hasInstanceLock = testProfile ? true : (app.requestSingleInstanceLock?.() ?? true);
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);
  if (nativeTheme) nativeTheme.themeSource = 'dark';
  if (process.platform === 'win32') app.setAppUserModelId?.(APP_ID);
  // Không cần thanh menu File/Edit/View. Dán (Ctrl+V) do giao diện tự xử lý.
  Menu?.setApplicationMenu?.(null);
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------------------------------------------------------------------------
// ImageMagick: danh sách định dạng
// ---------------------------------------------------------------------------

async function listFormats() {
  if (cachedFormats) return cachedFormats;
  try {
    const options = { maxBuffer: 1024 * 1024 * 4, windowsHide: true, env: magickEnv() };
    const { stdout } = await execFileAsync(magick().command, ['-list', 'format'], options);
    // Bản dựng tĩnh (bản portable đi kèm app) không in cột Module: tra trong "-list coder".
    const coders = hasModuleColumn(stdout)
      ? new Map()
      : parseCoders(await execFileAsync(magick().command, ['-list', 'coder'], options).then((result) => result.stdout, () => ''));
    const formats = parseFormats(stdout, coders);
    cachedFormats = {
      engine: 'ImageMagick',
      available: true,
      bundled: magick().bundled,
      formats,
      readable: formats.filter((format) => format.canRead),
      writable: formats.filter((format) => format.canWrite),
    };
    return cachedFormats;
  } catch (error) {
    // Không lưu kết quả lỗi, để lần sau thử lại (ví dụ sau khi cài ImageMagick).
    return {
      engine: 'ImageMagick',
      available: false,
      formats: [],
      readable: [],
      writable: [],
      error: error.message,
    };
  }
}

function outputExtension(format) {
  const normalized = normalizeExt(format);
  const aliases = {
    JPEG: 'jpg',
    TIFF: 'tiff',
    PNG24: 'png',
    PNG32: 'png',
    PNG48: 'png',
    PNG64: 'png',
  };
  return (aliases[normalized] || normalized.toLowerCase()).replace(/[^a-z0-9]+/g, '');
}

function getOutputArgs(format, mode, renderPdf = false) {
  const normalized = normalizeExt(format);
  // The PDF renderer already applies /Rotate. Reset only canvas metadata,
  // and composite each page onto white without resizing or flattening pages together.
  const args = renderPdf
    ? ['+repage', '-background', 'white', '-alpha', 'remove', '-alpha', 'off']
    : ['-auto-orient'];
  const useLossless = mode === 'lossless';

  if (useLossless) {
    if (normalized === 'WEBP') args.push('-define', 'webp:lossless=true', '-quality', '100');
    if (normalized === 'JXL') args.push('-define', 'jxl:lossless=true', '-quality', '100');
    if (normalized === 'AVIF' || normalized === 'HEIC' || normalized === 'HEIF') args.push('-define', 'heic:lossless=true', '-quality', '100');
    if (normalized === 'PNG' || normalized.startsWith('PNG')) args.push('-define', 'png:compression-level=3');
    if (normalized === 'TIFF' || normalized === 'TIF') args.push('-compress', 'Zip');
  } else if (['WEBP', 'JXL', 'AVIF', 'HEIC', 'HEIF', 'JP2'].includes(normalized)) {
    // "Chất lượng cao nhất": nén thường nhưng ở mức chất lượng cao nhất
    // (mặc định của ImageMagick chỉ khoảng 75 với các định dạng này).
    args.push('-quality', '100');
  }

  if (['JPEG', 'JPG', 'JPE', 'PJPEG'].includes(normalized)) {
    args.push('-sampling-factor', '4:4:4', '-quality', '100', '-define', 'jpeg:dct-method=float');
  }

  return args;
}

// ---------------------------------------------------------------------------
// Quét tệp: thư mục được duyệt cả thư mục con (có lọc theo định dạng đầu vào),
// tệp chọn trực tiếp thì luôn được lấy nếu ImageMagick đọc được.
// Mỗi tệp nhớ "gốc" của nó để tạo thư mục con kết quả đúng chỗ.
// ---------------------------------------------------------------------------

const FORMAT_ALIASES = new Map([
  ['JPG', 'JPEG'],
  ['JPE', 'JPEG'],
  ['TIF', 'TIFF'],
  ['SVGZ', 'SVG'],
]);

function cleanSubfolder(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '');
}

// skipDirs: tên thư mục con (ngay dưới thư mục được chọn) không quét, để thư mục
// kết quả của lần chuyển trước không bị chuyển lại.
async function collectFiles(inputs, readableFormats, sourceFormat, skipDirs = []) {
  const selected = normalizeExt(sourceFormat);
  const skipped = new Set(skipDirs.filter(Boolean).map((name) => name.toLowerCase()));
  const readable = new Set(readableFormats.map((format) => format.name.toUpperCase()));
  const files = [];
  const seen = new Set();

  async function addFile(fullPath, root, filtered) {
    const key = path.resolve(fullPath).toLowerCase();
    if (seen.has(key)) return;
    const name = path.basename(fullPath);
    const ext = path.extname(name).slice(1).toUpperCase();
    const canonical = FORMAT_ALIASES.get(ext) || ext;
    if (!readable.has(canonical) && !readable.has(ext)) return;
    if (filtered && selected && selected !== 'ALL' && selected !== canonical && selected !== ext) return;
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return;
    seen.add(key);
    files.push({ path: fullPath, name, format: canonical, bytes: stat.size, root });
  }

  async function walk(current, root) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (current === root && skipped.has(entry.name.toLowerCase())) continue;
        await walk(fullPath, root);
        continue;
      }
      if (!entry.isFile()) continue;
      await addFile(fullPath, root, true);
    }
  }

  for (const input of inputs) {
    const resolved = path.resolve(input);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      continue;
    }
    if (stat.isDirectory()) await walk(resolved, resolved);
    else if (stat.isFile()) await addFile(resolved, path.dirname(resolved), false);
  }
  return files.sort((a, b) => compareFormats(a.format, b.format) || a.path.localeCompare(b.path));
}

function inputsOf(payload) {
  const { folderPath, filePaths = [], paths = [] } = payload || {};
  const inputs = [...paths];
  if (folderPath) inputs.push(folderPath);
  inputs.push(...filePaths);
  return inputs.filter((value) => typeof value === 'string' && value);
}

async function scanFolder(payload) {
  const inputs = inputsOf(payload);
  if (!inputs.length) throw new Error(tr('error.noInput'));
  const formats = await listFormats();
  if (!formats.available) throw new Error(tr('error.noMagick'));
  const files = await collectFiles(inputs, formats.readable, payload?.sourceFormat || 'ALL', [cleanSubfolder(payload?.subfolderName)]);
  const hasPdf = files.some((file) => file.format === 'PDF');
  return {
    files,
    folderPath: payload?.folderPath,
    ghostscript: hasPdf ? await ghostscriptAvailable({ refresh: true }) : null,
  };
}

function buildOutputPath(inputPath, rootPath, targetFormat, outputMode, subfolderName) {
  const ext = outputExtension(targetFormat);
  const parsed = path.parse(inputPath);
  if (outputMode === 'subfolder') {
    const relative = path.relative(rootPath, parsed.dir);
    const baseOut = path.join(rootPath, subfolderName || `converted-${ext}`);
    return path.join(baseOut, relative, `${parsed.name}.${ext}`);
  }
  return path.join(parsed.dir, `${parsed.name}.${ext}`);
}

// ---------------------------------------------------------------------------
// Chuyển đổi
// ---------------------------------------------------------------------------

let activeRun = null;

function convertOne(inputPath, outputPath, targetFormat, qualityMode, limits, { separatePdfPages, renderPdf, pdfDpi }, run) {
  return new Promise((resolve, reject) => {
    const magickOutput = `${normalizeExt(targetFormat)}:${outputPath}`;
    // Density must be set before opening a PDF: setting it after reading only
    // changes metadata and cannot recover detail lost during rasterization.
    const inputArgs = renderPdf
      ? ['-units', 'PixelsPerInch', '-density', `${pdfDpi}x${pdfDpi}`, '-define', 'pdf:use-cropbox=true', '-antialias']
      : [];
    const pageArgs = separatePdfPages ? ['-adjoin', '-scene', '1'] : [];
    const args = [...inputArgs, inputPath, ...getOutputArgs(targetFormat, qualityMode, renderPdf), ...pageArgs, magickOutput];
    const configuredThreads = Number(process.env.MAGICK_THREAD_LIMIT);
    const threads = configuredThreads > 0 ? Math.min(configuredThreads, limits.threads) : limits.threads;
    const child = spawn(magick().command, args, {
      windowsHide: true,
      env: magickEnv({
        MAGICK_THREAD_LIMIT: String(threads),
        MAGICK_MEMORY_LIMIT: process.env.MAGICK_MEMORY_LIMIT || `${limits.memoryMiB}MiB`,
        MAGICK_MAP_LIMIT: process.env.MAGICK_MAP_LIMIT || `${limits.memoryMiB * 2}MiB`,
      }),
    });
    run?.children.add(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      run?.children.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      run?.children.delete(child);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || tr('error.magickExit', { code })));
      }
    });
  });
}

async function finalizeOutput(inputPath, outputPath, actualOutputPath, outputMode) {
  const samePath = path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase();
  if (samePath && actualOutputPath !== outputPath) {
    await fs.rm(outputPath, { force: true });
    await fs.rename(actualOutputPath, outputPath);
    return;
  }
  await removeOriginalIfNeeded(inputPath, outputPath, outputMode);
}

async function removeOriginalIfNeeded(inputPath, outputPath, outputMode) {
  if (outputMode !== 'overwrite') return;
  if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) return;
  await fs.rm(inputPath, { force: true });
}

function safeSend(sender, channel, payload) {
  if (sender && (!sender.isDestroyed || !sender.isDestroyed())) sender.send(channel, payload);
}

function looksLikeMissingGhostscript(message) {
  return /ghostscript|gswin|gsdll|PDFDelegateFailed|FailedToExecuteCommand|no decode delegate/i.test(String(message || ''));
}

async function convertFolder(event, payload, run) {
  const startedAt = performance.now();
  const {
    sourceFormat = 'ALL',
    targetFormat,
    outputMode = 'subfolder',
    subfolderName,
    qualityMode = 'lossless',
    pdfDpi = 300,
  } = payload || {};

  if (!inputsOf(payload).length) throw new Error(tr('error.noInput'));
  if (!targetFormat) throw new Error(tr('error.noTarget'));

  const cleanName = cleanSubfolder(subfolderName);
  const scan = await scanFolder({ ...payload, sourceFormat, subfolderName: cleanName || `converted-${outputExtension(targetFormat)}` });
  const formats = await listFormats();
  const target = formats.writable.find((format) => format.name === normalizeExt(targetFormat));
  if (!target) throw new Error(tr('error.targetUnsupported'));
  const resolution = Number(pdfDpi);
  if (!target.document && scan.files.some((file) => file.format === 'PDF') && !pdfDpiOptions.includes(resolution)) {
    throw new Error(tr('error.pdfDpi', { values: pdfDpiOptions.join(', ') }));
  }
  const jobs = scan.files.map((file) => {
    const renderPdf = file.format === 'PDF' && !target.document;
    const separatePdfPages = outputMode === 'overwrite' && renderPdf;
    const outputPath = separatePdfPages
      ? path.join(path.dirname(file.path), path.parse(file.path).name, `%d.${outputExtension(targetFormat)}`)
      : buildOutputPath(file.path, file.root, targetFormat, outputMode, cleanName);
    return { file, outputPath, separatePdfPages, renderPdf, pdfDpi: resolution };
  });
  const limits = getExecutionLimits(jobs);
  const directories = new Map();
  function ensureDirectory(directory) {
    if (!directories.has(directory)) directories.set(directory, fs.mkdir(directory, { recursive: true }));
    return directories.get(directory);
  }
  let success = 0;
  let failed = 0;
  let cancelled = 0;

  const results = await runConcurrent(jobs, limits.workers, async (job, index) => {
    const { file, outputPath } = job;
    const progressBase = {
      index,
      total: scan.files.length,
      file,
      outputPath,
    };
    if (run?.cancelled) {
      cancelled += 1;
      return { ...progressBase, status: 'cancelled' };
    }
    safeSend(event.sender, 'convert:progress', { ...progressBase, status: 'running' });

    const samePath = path.resolve(file.path).toLowerCase() === path.resolve(outputPath).toLowerCase();
    const actualOutputPath = samePath ? path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${Date.now()}.tmp`) : outputPath;
    try {
      await ensureDirectory(path.dirname(outputPath));
      await convertOne(file.path, actualOutputPath, targetFormat, qualityMode, limits, job, run);
      await finalizeOutput(file.path, outputPath, actualOutputPath, outputMode);
      success += 1;
      safeSend(event.sender, 'convert:progress', { ...progressBase, status: 'done' });
      return { ...progressBase, status: 'done' };
    } catch (error) {
      if (run?.cancelled) {
        // Bị dừng giữa chừng: bỏ tệp kết quả dở dang, tệp gốc không bị đụng tới.
        if (!job.separatePdfPages) await fs.rm(actualOutputPath, { force: true }).catch(() => {});
        cancelled += 1;
        safeSend(event.sender, 'convert:progress', { ...progressBase, status: 'cancelled' });
        return { ...progressBase, status: 'cancelled' };
      }
      failed += 1;
      let message = error.message;
      if (file.format === 'PDF' && looksLikeMissingGhostscript(message) && !(await ghostscriptAvailable({ refresh: true }))) {
        message = tr('error.needGhostscript');
      }
      safeSend(event.sender, 'convert:progress', { ...progressBase, status: 'failed', error: message });
      return { ...progressBase, status: 'failed', error: message };
    }
  });

  const outputFolders = [...new Set(jobs.map(({ file, outputPath, separatePdfPages }) => {
    if (separatePdfPages) return path.dirname(outputPath);
    return outputMode === 'subfolder'
      ? path.join(file.root, cleanName || `converted-${outputExtension(targetFormat)}`)
      : path.dirname(file.path);
  }))];
  return {
    total: scan.files.length,
    success,
    failed,
    cancelled,
    results,
    elapsedMs: Math.round(performance.now() - startedAt),
    workers: limits.workers,
    pdfDpi: jobs.some((job) => job.renderPdf) ? resolution : null,
    outputMode,
    outputFolders,
    outputFolder: outputFolders.join(', '),
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function senderWindow(event) {
  return BrowserWindow?.fromWebContents?.(event.sender) || undefined;
}

ipcMain.handle('formats:list', () => listFormats());
registerStudioIpc({ ipcMain, dialog, BrowserWindow, clipboard, shell });

ipcMain.handle('app:set-language', (_event, language) => setLanguage(language));

ipcMain.handle('app:info', async () => ({
  version: app.getVersion?.() || '0.0.0',
  packaged: Boolean(app.isPackaged),
  magick: { bundled: magick().bundled, version: await magickVersion() },
  ghostscript: await ghostscriptAvailable(),
  links: LINKS,
}));

ipcMain.handle('app:check-update', () => checkForUpdate(app.getVersion?.() || '0.0.0', net?.fetch ? (url, options) => net.fetch(url, options) : globalThis.fetch));

ipcMain.handle('app:open-external', async (_event, url) => {
  if (typeof url !== 'string' || !isAllowedExternal(url)) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('path:open-folder', async (_event, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath) return false;
  try {
    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  return (await shell.openPath(folderPath)) === '';
});

ipcMain.handle('folder:pick', async (event) => {
  const result = await dialog.showOpenDialog(senderWindow(event), {
    properties: ['openDirectory'],
    title: tr('dialog.pickFolder'),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('folder:scan', (_event, payload) => scanFolder(payload));

ipcMain.handle('files:pick', async (event) => {
  const formats = await listFormats();
  const extensions = new Set(formats.readable.map((format) => format.name.toLowerCase()));
  extensions.add('pdf');
  if (extensions.has('jpeg')) { extensions.add('jpg'); extensions.add('jpe'); }
  if (extensions.has('tiff')) extensions.add('tif');
  if (extensions.has('svg')) extensions.add('svgz');
  const result = await dialog.showOpenDialog(senderWindow(event), {
    properties: ['openFile', 'multiSelections'],
    title: tr('dialog.pickFiles'),
    filters: [
      { name: tr('dialog.filterImagesPdf'), extensions: [...extensions].sort(compareFormats) },
      { name: 'PDF', extensions: ['pdf'] },
      { name: tr('dialog.filterAll'), extensions: ['*'] },
    ],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths;
});

ipcMain.handle('folder:convert', async (event, payload) => {
  if (activeRun) throw new Error(tr('error.busy'));
  const run = { cancelled: false, children: new Set() };
  activeRun = run;
  try {
    return await convertFolder(event, payload, run);
  } finally {
    activeRun = null;
  }
});

ipcMain.handle('convert:cancel', () => {
  if (!activeRun) return false;
  activeRun.cancelled = true;
  for (const child of activeRun.children) child.kill();
  return true;
});
