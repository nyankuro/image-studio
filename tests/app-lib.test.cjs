const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const en = require('../locales/en.json');
const vi = require('../locales/vi.json');
const { compareVersions, interpretLatest, checkForUpdate, isAllowedExternal, LINKS } = require('../electron/update-check.cjs');
const { resolveMagick } = require('../electron/magick.cjs');
const { hasModuleColumn, parseCoders, parseFormats } = require('../electron/formats.cjs');

const KEY_PATTERN = /^(about|common|converter|dialog|error|filter|icoFormat|icon|preset|rail|status|support|tool)\.[A-Za-z0-9]+$/;

function sourceFiles(dir, extensions) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

// Mọi chuỗi trong mã nguồn trông giống khóa dịch ('icon.export', "error.busy"...).
function literalKeys() {
  const keys = new Set();
  const files = [...sourceFiles(path.join(root, 'src'), ['.js', '.jsx']), ...sourceFiles(path.join(root, 'electron'), ['.cjs'])];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/['"`]([A-Za-z]+\.[A-Za-z0-9]+)['"`]/g)) {
      // Tên tệp như 'icon.png' không phải khóa dịch.
      if (KEY_PATTERN.test(match[1]) && !/\.(png|ico|svg|jpe?g|json|c?js|exe)$/.test(match[1])) keys.add(match[1]);
    }
  }
  return keys;
}

async function dynamicKeys() {
  const { RESAMPLE_FILTERS, SIZE_PRESETS } = await import('../src/lib/icon-render.js');
  const { ICO_FORMATS } = await import('../src/lib/ico-file.js');
  return [
    ...RESAMPLE_FILTERS.map((item) => `filter.${item.value}`),
    ...Object.keys(SIZE_PRESETS).map((key) => `preset.${key}`),
    ...ICO_FORMATS.map((item) => `icoFormat.${item.value}`),
    ...['queued', 'running', 'done', 'failed', 'cancelled'].map((status) => `status.${status}`),
    'error.svg',
    'error.noImage',
  ];
}

test('English and Vietnamese have the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(vi).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.ok(String(en[key]).trim(), `en ${key} is empty`);
    assert.ok(String(vi[key]).trim(), `vi ${key} is empty`);
    assert.deepEqual(placeholders(vi[key]), placeholders(en[key]), `placeholders differ for ${key}`);
  }
});

test('every key used in the code exists, and every key is used', async () => {
  const used = new Set([...literalKeys(), ...(await dynamicKeys())]);
  const missing = [...used].filter((key) => !Object.prototype.hasOwnProperty.call(en, key));
  assert.deepEqual(missing, [], 'keys missing from locales/en.json');
  const unused = Object.keys(en).filter((key) => !used.has(key));
  assert.deepEqual(unused, [], 'keys in locales/en.json that nothing uses');
});

test('main-process translator falls back to English and fills placeholders', () => {
  const i18n = require('../electron/i18n.cjs');
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(i18n.tr('error.pdfDpi', { values: '72, 150' }), 'PDF resolution must be one of: 72, 150 DPI.');
  assert.equal(i18n.setLanguage('vi'), 'vi');
  assert.equal(i18n.tr('error.magickExit', { code: 3 }), 'ImageMagick dừng với mã lỗi 3.');
  assert.equal(i18n.setLanguage('xx'), 'vi', 'unknown languages are ignored');
  assert.equal(i18n.tr('missing.key'), 'missing.key');
  i18n.setLanguage('en');
});

test('errorText strips the IPC prefix and translates coded errors', async () => {
  const { errorText } = await import('../src/lib/error-text.js');
  const ipc = new Error("Error invoking remote method 'folder:convert': Error: A conversion is already running.");
  assert.equal(errorText(ipc), 'A conversion is already running.');
  const coded = Object.assign(new Error('Could not read the SVG image.'), { code: 'svg' });
  assert.equal(errorText(coded, (key) => (key === 'error.svg' ? 'Không đọc được ảnh SVG.' : key)), 'Không đọc được ảnh SVG.');
  const unknownCode = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  assert.equal(errorText(unknownCode, (key) => key), 'ENOENT: no such file');
});

test('version comparison', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('v1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', 'v2.0.0'), 0);
  assert.equal(compareVersions('garbage', '1.0.0'), 0);
});

test('update check reads the latest GitHub release', async () => {
  assert.deepEqual(interpretLatest('1.0.0', 404, null), { state: 'none' });
  assert.deepEqual(interpretLatest('1.0.0', 500, null), { state: 'error' });
  assert.deepEqual(interpretLatest('1.0.0', 200, { tag_name: 'v1.0.0' }), { state: 'latest', version: '1.0.0' });
  const newer = interpretLatest('1.0.0', 200, { tag_name: 'v1.2.0', html_url: 'https://github.com/nyankuro/image-studio/releases/tag/v1.2.0' });
  assert.deepEqual(newer, { state: 'update', version: '1.2.0', url: 'https://github.com/nyankuro/image-studio/releases/tag/v1.2.0' });
  const foreign = interpretLatest('1.0.0', 200, { tag_name: 'v1.2.0', html_url: 'https://evil.example/download' });
  assert.equal(foreign.url, LINKS.releases, 'only links inside the repository are used');

  const offline = await checkForUpdate('1.0.0', async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  assert.deepEqual(offline, { state: 'offline' });
  const fake = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/nyankuro/image-studio/releases/latest');
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    return { status: 200, json: async () => ({ tag_name: 'v1.0.1', html_url: 'https://github.com/nyankuro/image-studio/releases/tag/v1.0.1' }) };
  };
  assert.equal((await checkForUpdate('1.0.0', fake)).state, 'update');
});

test('only known links open in the browser', () => {
  assert.ok(isAllowedExternal('https://ko-fi.com/nyannyankuro'));
  assert.ok(isAllowedExternal('https://github.com/nyankuro/image-studio/releases/tag/v1.0.1'));
  assert.ok(isAllowedExternal('https://ghostscript.com/releases/gsdnld.html'));
  assert.ok(!isAllowedExternal('https://github.com/nyankuro/image-studio-fake'));
  assert.ok(!isAllowedExternal('file:///C:/Windows/System32/calc.exe'));
  assert.ok(!isAllowedExternal('https://example.com'));
});

test('bundled ImageMagick is preferred over the one on PATH', () => {
  const exe = process.platform === 'win32' ? 'magick.exe' : 'magick';
  const resources = path.join('R', 'resources');
  const appRoot = path.join('R', 'app');
  const packaged = path.join(resources, 'imagemagick', exe);
  const vendored = path.join(appRoot, 'vendor', 'imagemagick', exe);

  const fromEnv = resolveMagick({ resourcesPath: resources, appRoot, env: { IMAGE_STUDIO_MAGICK: 'C:/IM/magick.exe' }, exists: () => true });
  assert.deepEqual(fromEnv, { command: 'C:/IM/magick.exe', bundled: false, home: null });

  const both = resolveMagick({ resourcesPath: resources, appRoot, env: {}, exists: () => true });
  assert.deepEqual(both, { command: packaged, bundled: true, home: path.dirname(packaged) });

  const dev = resolveMagick({ resourcesPath: resources, appRoot, env: {}, exists: (file) => file === vendored });
  assert.deepEqual(dev, { command: vendored, bundled: true, home: path.dirname(vendored) });

  const none = resolveMagick({ resourcesPath: resources, appRoot, env: {}, exists: () => false });
  assert.deepEqual(none, { command: 'magick', bundled: false, home: null });
});

// Bản ImageMagick cài đặt in cột Module, bản portable đi kèm app (dựng tĩnh) thì không.
// Hai tệp mẫu là kết quả thật của "magick -list format" trên hai bản này.
test('formats are read the same way from installed and bundled (portable) ImageMagick', () => {
  const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const modular = fixture('magick-list-format-modules.txt');
  const portable = fixture('magick-list-format-static.txt');
  assert.ok(hasModuleColumn(modular));
  assert.ok(!hasModuleColumn(portable));

  const coders = parseCoders(fixture('magick-list-coder-static.txt'));
  assert.equal(coders.get('JPG'), 'JPEG');
  assert.equal(coders.get('MP4'), 'VIDEO');
  assert.equal(coders.get('EPS'), 'PS');
  assert.ok(!coders.has('MAGICK'));

  const byName = (formats) => new Map(formats.map((format) => [format.name, format]));
  const builds = { modular: byName(parseFormats(modular)), portable: byName(parseFormats(portable, coders)) };
  for (const [build, formats] of Object.entries(builds)) {
    for (const name of ['PNG', 'JPEG', 'WEBP', 'AVIF', 'TIFF', 'ICO', 'PDF', 'GIF', 'BMP', 'JXL']) {
      assert.ok(formats.get(name)?.canRead && formats.get(name)?.canWrite, `${build}: ${name} can be read and written`);
    }
    assert.equal(formats.get('HEIC')?.canRead, true, `${build}: HEIC can be read`);
    for (const name of ['PDF', 'EPS', 'AI']) assert.equal(formats.get(name)?.document, true, `${build}: ${name} is a document`);
    assert.equal(formats.get('PNG').lossless, true);
    assert.equal(formats.get('JPEG').lossless, false);
    assert.equal(formats.get('PDF').module, 'PDF');
    for (const name of ['MP4', 'AVI', '3GP', 'HTTP', 'TXT', 'XC', 'CANVAS', 'GRADIENT', 'TTF', 'OTF', 'HTML', 'BRF', 'JSON', 'INFO']) {
      assert.ok(!formats.has(name), `${build}: ${name} is not offered as an image format`);
    }
  }
  assert.deepEqual([...builds.portable.keys()].slice(0, 10), [...builds.modular.keys()].slice(0, 10));
});
