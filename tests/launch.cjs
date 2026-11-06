const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const workspace = path.resolve(__dirname, '..');

// Mở app với hồ sơ tạm (không đụng thiết lập thật, chạy được cả khi app đang mở)
// và ngôn ngữ cố định cho test.
async function launchApp({ language = 'en' } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'image-studio-test-'));
  const env = { ...process.env, IMAGE_STUDIO_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  delete env.npm_lifecycle_event;
  const app = await electron.launch({ args: [workspace], cwd: workspace, env });
  let page;
  try {
    page = await app.firstWindow();
    // Cửa sổ đầu tiên có thể còn ở about:blank: chờ giao diện app hiện ra rồi mới đặt ngôn ngữ.
    await page.locator('.studio').waitFor({ timeout: 30000 });
    await page.evaluate((value) => window.localStorage.setItem('image-studio:language', value), language);
    await page.reload();
    await page.locator('.studio').waitFor({ timeout: 30000 });
  } catch (error) {
    await app.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    app,
    page,
    profile,
    async close() {
      await app.close().catch(() => {});
      await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

module.exports = { launchApp, workspace };
