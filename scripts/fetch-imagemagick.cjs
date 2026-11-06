// Tải ImageMagick bản portable cho Windows x64 vào vendor/imagemagick, để bộ cài
// mang theo ImageMagick và người dùng không phải cài gì thêm. Phiên bản và mã
// SHA-256 được ghim cố định: tệp tải về khác mã là dừng ngay.
//
// Chạy: npm run fetch:magick   (đã có đúng bản thì bỏ qua)
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const VERSION = '7.1.2-35';
const ASSET = `ImageMagick-${VERSION}-portable-Q16-HDRI-x64.7z`;
const URL = `https://github.com/ImageMagick/ImageMagick/releases/download/${VERSION}/${ASSET}`;
const SHA256 = '34db4364da26c88d6b8cc5bbc1fff22b85d00d3b399c82fe85ee4790efacbbf1';

// Bản portable là bản dựng tĩnh: mỗi lệnh cũ (identify, mogrify...) là một bản sao
// 32 MB của magick.exe. App chỉ gọi magick.exe, nên các bản sao này, ffmpeg (chỉ
// dùng cho video) và ChangeLog được bỏ để bộ cài nhẹ hơn. LICENSE/NOTICE giữ lại.
const DROP = [
  /^(compare|composite|conjure|identify|mogrify|montage|stream)\.exe$/i,
  /^(ffmpeg|imdisplay)\.exe$/i,
  /^ChangeLog\.md$/i,
];

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'vendor');
const target = path.join(vendorDir, 'imagemagick');
const stamp = path.join(vendorDir, 'imagemagick.version');
const cacheDir = path.join(vendorDir, '.cache');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'image-studio-build' } });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const partial = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  await fsp.rename(partial, destination);
}

function findDirectoryWith(dir, fileName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === fileName) return dir;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findDirectoryWith(path.join(dir, entry.name), fileName);
    if (found) return found;
  }
  return null;
}

async function main() {
  const force = process.argv.includes('--force');
  if (process.platform !== 'win32' && !force) {
    console.log('ImageMagick portable is for Windows; skipped on this system (use --force to download anyway).');
    return;
  }
  if (!force && fs.existsSync(path.join(target, 'magick.exe')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION) {
    console.log(`ImageMagick ${VERSION} is already in vendor/imagemagick.`);
    return;
  }

  await fsp.mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, ASSET);
  if (!fs.existsSync(archive) || sha256(archive) !== SHA256) {
    console.log(`Downloading ${URL}`);
    await download(URL, archive);
  }
  const actual = sha256(archive);
  if (actual !== SHA256) {
    await fsp.rm(archive, { force: true });
    throw new Error(`Checksum mismatch for ${ASSET}: expected ${SHA256}, got ${actual}`);
  }

  const extractDir = path.join(cacheDir, 'extract');
  await fsp.rm(extractDir, { recursive: true, force: true });
  const { path7za } = require('7zip-bin');
  const result = spawnSync(path7za, ['x', archive, `-o${extractDir}`, '-y', '-bso0', '-bsp0'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`7za could not extract ${ASSET} (exit ${result.status})`);

  const source = findDirectoryWith(extractDir, process.platform === 'win32' || force ? 'magick.exe' : 'magick');
  if (!source) throw new Error(`magick.exe was not found inside ${ASSET}`);
  for (const entry of fs.readdirSync(source)) {
    if (DROP.some((pattern) => pattern.test(entry))) await fsp.rm(path.join(source, entry), { recursive: true, force: true });
  }

  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(source, target);
  await fsp.writeFile(stamp, `${VERSION}\n`);
  await fsp.rm(extractDir, { recursive: true, force: true });

  let bytes = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
  }
  console.log(`ImageMagick ${VERSION} ready in vendor/imagemagick (${(bytes / 1048576).toFixed(1)} MB).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
