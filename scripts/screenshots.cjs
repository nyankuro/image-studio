// Chụp ảnh màn hình cho README (docs/screenshots/*-en.png, *-vi.png).
// Chạy sau `npm run build`:  node scripts/screenshots.cjs
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launchApp, workspace } = require('../tests/launch.cjs');

const run = promisify(execFile);
const outDir = path.join(workspace, 'docs', 'screenshots');
const demoRoot = path.join(workspace, 'output', 'demo');

const LABELS = {
  en: { ico: 'ICO Maker', converter: 'Converter', advanced: 'Advanced', addFolder: 'Add folder', convert: 'Convert', to: 'Convert to', done: /Converted \d+/ },
  vi: { ico: 'Tạo ICO', converter: 'Chuyển đổi', advanced: 'Nâng cao', addFolder: 'Thêm thư mục', convert: 'Chuyển đổi', to: 'Chuyển sang', done: /Xong \d+/ },
};

async function makeDemoFolder() {
  const photos = path.join(demoRoot, 'Photos');
  await fs.rm(demoRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(photos, 'Trip'), { recursive: true });
  const jobs = [
    ['Trip/beach-01.jpg', ['-size', '1600x1067', 'gradient:#36e2f5-#5a6bf4']],
    ['Trip/beach-02.jpg', ['-size', '1600x1067', 'gradient:#ffd36b-#ff6b9a']],
    ['Trip/sunset.heic', ['-size', '1600x1067', 'gradient:#ff9a3d-#9b3df0']],
    ['logo.png', ['-size', '512x512', 'radial-gradient:#9b3df0-#0f1318']],
    ['banner.webp', ['-size', '1920x600', 'gradient:#19b3b3-#0f1318']],
    ['scan.tif', ['-size', '1240x1754', 'xc:#f4f1ea']],
  ];
  for (const [name, args] of jobs) {
    await run('magick', [...args, path.join(photos, name)]).catch(() => run('magick', [...args, path.join(photos, name.replace(/\.heic$/, '.jpg'))]));
  }
  return photos;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const photos = await makeDemoFolder();
  for (const language of ['en', 'vi']) {
    const label = LABELS[language];
    const session = await launchApp({ language });
    const { app, page } = session;
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1240, 780));
      await page.waitForTimeout(300);

      // Tạo ICO: dùng chính icon của app làm ảnh mẫu, mở bảng Nâng cao.
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, path.join(workspace, 'build', 'icon.png'));
      await page.getByRole('button', { name: label.ico, exact: true }).click();
      const icon = page.locator('[data-tool="icon"]');
      await icon.locator('.icon-drop').click();
      await icon.locator('.preview-canvas').waitFor();
      await icon.getByRole('button', { name: label.advanced }).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-tool="icon"] .strip-item canvas').length >= 8, null, { timeout: 20000 });
      await page.waitForTimeout(600);
      await page.mouse.move(5, 700);
      await page.screenshot({ path: path.join(outDir, `ico-maker-${language}.png`) });

      // Chuyển đổi: một thư mục ảnh mẫu, chuyển sang WEBP.
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      }, photos);
      await page.getByRole('button', { name: label.converter, exact: true }).click();
      const converter = page.locator('[data-tool="converter"]');
      await converter.getByRole('button', { name: label.addFolder }).click();
      await converter.locator('tbody tr').first().waitFor();
      await converter.getByRole('combobox', { name: label.to }).selectOption('WEBP');
      await converter.getByRole('button', { name: label.convert, exact: true }).click();
      await converter.getByText(label.done).waitFor({ timeout: 60000 });
      await page.waitForTimeout(400);
      await page.mouse.move(5, 700);
      await page.screenshot({ path: path.join(outDir, `converter-${language}.png`) });
      await fs.rm(path.join(photos, 'converted-images'), { recursive: true, force: true });
      await fs.rm(path.join(photos, 'Trip', 'converted-images'), { recursive: true, force: true });
    } finally {
      await session.close();
    }
  }
  await fs.rm(demoRoot, { recursive: true, force: true });
  console.log(`Screenshots saved in ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
