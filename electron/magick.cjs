const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ImageMagick đi kèm bộ cài (bản portable) được ưu tiên, để app chạy được mà
// không cần cài gì thêm. Khi chạy từ mã nguồn thì dùng vendor/imagemagick
// (tải bằng `npm run fetch:magick`), không có thì dùng `magick` trong PATH.
const EXE = process.platform === 'win32' ? 'magick.exe' : 'magick';

function resolveMagick({ resourcesPath = process.resourcesPath, appRoot = path.join(__dirname, '..'), env = process.env, exists = fs.existsSync } = {}) {
  if (env.IMAGE_STUDIO_MAGICK) return { command: env.IMAGE_STUDIO_MAGICK, bundled: false, home: null };
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'imagemagick', EXE) : null,
    path.join(appRoot, 'vendor', 'imagemagick', EXE),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) return { command: candidate, bundled: true, home: path.dirname(candidate) };
  }
  return { command: 'magick', bundled: false, home: null };
}

let resolved = null;
function magick() {
  if (!resolved) resolved = resolveMagick();
  return resolved;
}

// Biến môi trường cho mọi lần gọi ImageMagick. Bản đi kèm dùng cấu hình của
// chính nó, không lẫn với bản ImageMagick khác có thể đã cài trên máy.
function magickEnv(extra = {}) {
  const { home } = magick();
  const env = { ...process.env, ...extra };
  if (home) {
    env.MAGICK_HOME = home;
    env.MAGICK_CONFIGURE_PATH = home;
  }
  return env;
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

let versionPromise = null;
function magickVersion() {
  if (!versionPromise) {
    versionPromise = run(magick().command, ['-version'], { env: magickEnv() }).then((stdout) => {
      const match = stdout && stdout.match(/ImageMagick\s+([\d.]+-\d+)/);
      return match ? match[1] : null;
    });
  }
  return versionPromise;
}

// ImageMagick cần Ghostscript để đọc PDF. Trên Windows nó tìm Ghostscript trong
// registry (bộ cài chính thức ghi vào đó), hoặc gswin64c trong PATH.
async function hasGhostscript() {
  if (process.env.MAGICK_GHOSTSCRIPT_PATH) return true;
  if (process.platform === 'win32') {
    for (const root of ['HKLM', 'HKCU']) {
      for (const vendor of ['GPL Ghostscript', 'Artifex Ghostscript', 'AFPL Ghostscript']) {
        const output = await run('reg', ['query', `${root}\\SOFTWARE\\${vendor}`, '/s']);
        if (output && /GS_DLL/i.test(output)) return true;
      }
    }
    for (const name of ['gswin64c', 'gswin32c']) {
      if (await run('where', [name])) return true;
    }
    return false;
  }
  return Boolean(await run('gs', ['--version']));
}

let ghostscriptPromise = null;
function ghostscriptAvailable({ refresh = false } = {}) {
  if (!ghostscriptPromise || refresh) ghostscriptPromise = hasGhostscript();
  return ghostscriptPromise;
}

module.exports = { resolveMagick, magick, magickEnv, magickVersion, ghostscriptAvailable };
