// Kiểm tra bản mới trên GitHub Releases. App chưa ký số nên không tự tải và
// cài: chỉ báo có bản mới và mở trang tải.
const REPO = 'nyankuro/image-studio';
const LINKS = {
  repo: `https://github.com/${REPO}`,
  releases: `https://github.com/${REPO}/releases/latest`,
  issues: `https://github.com/${REPO}/issues`,
  kofi: 'https://ko-fi.com/nyannyankuro',
  ghostscript: 'https://ghostscript.com/releases/gsdnld.html',
};
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

// status: mã HTTP; body: JSON của GitHub. GitHub trả 404 khi chưa có bản phát hành nào.
function interpretLatest(currentVersion, status, body) {
  if (status === 404) return { state: 'none' };
  if (status < 200 || status >= 300 || !body || !body.tag_name) return { state: 'error' };
  const version = String(body.tag_name).replace(/^v/i, '');
  if (!parseVersion(version)) return { state: 'error' };
  const url = typeof body.html_url === 'string' && body.html_url.startsWith(`https://github.com/${REPO}/`) ? body.html_url : LINKS.releases;
  return compareVersions(version, currentVersion) > 0 ? { state: 'update', version, url } : { state: 'latest', version };
}

async function checkForUpdate(currentVersion, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Image-Studio' },
    });
    const body = response.status === 404 ? null : await response.json().catch(() => null);
    return interpretLatest(currentVersion, response.status, body);
  } catch {
    return { state: 'offline' };
  }
}

function isAllowedExternal(url) {
  return Object.values(LINKS).includes(url) || String(url).startsWith(`${LINKS.repo}/`);
}

module.exports = { LINKS, compareVersions, interpretLatest, checkForUpdate, isAllowedExternal };
