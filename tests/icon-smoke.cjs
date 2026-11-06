const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launchApp, workspace } = require('./launch.cjs');

const run = promisify(execFile);
const artifacts = path.join(workspace, 'output', 'playwright');

async function identify(file) {
  for (const [command, args] of [['magick', ['identify']], ['identify', []]]) {
    try {
      const { stdout } = await run(command, [...args, '-format', '%wx%h\n', file]);
      return stdout.trim().split(/\r?\n/);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function writePng(file, width, height, colorAt) {
  const { encodePng } = await import('../src/lib/png-encode.js');
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba.set(colorAt(x, y), (y * width + x) * 4);
  }
  await fs.writeFile(file, await encodePng(rgba, width, height));
}

// Ảnh thử 300×200: nền xanh dương, khung vàng 8 px, hình tròn đỏ ở giữa.
function wideFixture(x, y) {
  const border = x < 8 || y < 8 || x >= 292 || y >= 192;
  const circle = (x - 150) ** 2 + (y - 100) ** 2 < 60 ** 2;
  return [...(circle ? [230, 60, 50] : border ? [250, 210, 20] : [30, 120, 200]), 255];
}

function pixel(entry, x, y) {
  const i = (y * entry.width + x) * 4;
  return [...entry.rgba.subarray(i, i + 4)];
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(artifacts, 'icon-'));
  const { readIco } = await import('../src/lib/ico-file.js');
  let session;
  try {
    const widePng = path.join(fixture, 'logo wide.png');
    const greenPng = path.join(fixture, 'green.png');
    const icoPath = path.join(fixture, 'out.ico');
    await writePng(widePng, 300, 200, wideFixture);
    await writePng(greenPng, 64, 64, () => [40, 200, 90, 255]);

    session = await launchApp({ language: 'en' });
    const { app, page } = session;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.widePng] });
      dialog.showSaveDialog = async (_win, options) => {
        globalThis.lastSaveOptions = options;
        return { canceled: false, filePath: files.icoPath };
      };
    }, { widePng, icoPath });
    // Electron 44+ dùng clipboard kiểu W3C (write/ClipboardItem); bản cũ có writeImage.
    const clipboardImage = (file) => app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, value) => {
      const image = nativeImage.createFromPath(value);
      if (typeof clipboard.writeImage === 'function') return clipboard.writeImage(image);
      const png = new Uint8Array(image.toPNG());
      return clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    }, file);
    const clipboardText = (text) => app.evaluate(async ({ clipboard }, value) => { await clipboard.writeText(value); }, text);

    await page.getByRole('button', { name: 'ICO Maker', exact: true }).click();
    const tool = page.locator('[data-tool="icon"]');
    await tool.getByText('Press Ctrl+V to paste an image').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'icon-empty.png') });

    const preview = tool.getByRole('img', { name: 'Icon preview' });
    const slider = tool.getByRole('slider', { name: 'Corner rounding, from square to round' });
    const exportIco = async () => {
      await page.waitForTimeout(350);
      await tool.getByRole('button', { name: 'Export ICO' }).click();
      await tool.getByText('Saved', { exact: false }).waitFor({ timeout: 20000 });
      const entries = readIco(await fs.readFile(icoPath)).map((entry) => ({ ...entry, width: entry.width }));
      return { entries, options: await app.evaluate(() => globalThis.lastSaveOptions) };
    };

    // Dán ảnh (Ctrl+V) là hiện ngay, không cần bước nào khác.
    await clipboardImage(greenPng);
    await page.keyboard.press('Control+V');
    await preview.waitFor();
    await slider.fill('100');
    await tool.getByRole('button', { name: 'Advanced' }).click();
    await tool.getByRole('button', { name: 'Favicon', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-tool="icon"] .strip-item canvas').length === 3);
    let result = await exportIco();
    assert.ok(result.options.defaultPath.endsWith('icon.ico'), result.options.defaultPath);
    assert.deepEqual(result.entries.map((entry) => [entry.width, entry.format]), [[16, 'bmp'], [32, 'bmp'], [48, 'bmp']]);
    for (const entry of result.entries) {
      const s = entry.width;
      assert.equal(pixel(entry, 0, 0)[3], 0, `${s}px corner is transparent`);
      assert.equal(pixel(entry, s - 1, s - 1)[3], 0);
      const center = pixel(entry, s / 2, s / 2);
      assert.ok(center[1] > 170 && center[0] < 80 && center[3] === 255, `${s}px center is the green paste: ${center}`);
      assert.ok(entry.rgba.some((value, i) => i % 4 === 3 && value > 0 && value < 255), `${s}px edge is anti-aliased`);
    }
    const sizes = await identify(icoPath);
    if (sizes) assert.deepEqual(sizes, ['16x16', '32x32', '48x48']);

    // Dán chữ thường: không có ảnh nên giữ nguyên, thông báo đã lưu vẫn còn.
    await clipboardText('không phải ảnh');
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(400);
    await tool.getByText('Saved', { exact: false }).waitFor({ timeout: 1000 });

    // Dán đường dẫn tới một tệp ảnh: mở ảnh đó, giữ mức bo tròn đang dùng.
    await clipboardText(widePng);
    await page.keyboard.press('Control+V');
    await tool.getByText('Saved', { exact: false }).waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await slider.inputValue(), '100');
    await page.screenshot({ path: path.join(artifacts, 'icon-circle.png') });

    // Ảnh không vuông được cắt vuông ở giữa; kéo ảnh sang phải để thấy khung vàng bên trái.
    await slider.fill('0');
    result = await exportIco();
    assert.ok(result.options.defaultPath.endsWith('logo wide.ico'), result.options.defaultPath);
    let e48 = result.entries.find((entry) => entry.width === 48);
    assert.ok(pixel(e48, 0, 24)[2] > 150, `centre crop starts inside the blue area: ${pixel(e48, 0, 24)}`);

    const box = await preview.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + box.width / 2 + step * 12, box.y + box.height / 2);
    await page.mouse.up();
    result = await exportIco();
    e48 = result.entries.find((entry) => entry.width === 48);
    const left = pixel(e48, 0, 24);
    assert.ok(left[0] > 200 && left[1] > 150 && left[2] < 100, `dragging right reveals the yellow left border: ${left}`);

    // Cuộn chuột để thu nhỏ hết cỡ: lấy cả ảnh, trên/dưới trong suốt.
    const before = await preview.getAttribute('data-crop');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 8; step += 1) await page.mouse.wheel(0, 400);
    await page.waitForFunction((value) => document.querySelector('[data-tool="icon"] .preview-canvas').dataset.crop !== value, before, { timeout: 5000 });
    result = await exportIco();
    e48 = result.entries.find((entry) => entry.width === 48);
    assert.equal(pixel(e48, 24, 2)[3], 0, 'zoomed-out letterbox keeps the top transparent');
    assert.equal(pixel(e48, 24, 24)[3], 255);
    await page.screenshot({ path: path.join(artifacts, 'icon-advanced.png') });

    // Định dạng như RedKetchup: mặc định BMP 32-bit, chọn được BMP 24/8/4-bit (không alpha).
    const formatSelect = tool.getByRole('combobox', { name: 'Image format inside the ICO' });
    assert.equal(await formatSelect.inputValue(), 'bmp32');
    assert.ok(result.entries.every((entry) => entry.bitCount === 32), 'default entries are 32-bit');
    for (const [format, bits, colors] of [['bmp4', 4, 16], ['bmp8', 8, 0], ['bmp24', 24, 0]]) {
      await formatSelect.selectOption(format);
      result = await exportIco();
      assert.deepEqual(result.entries.map((entry) => [entry.width, entry.format, entry.bitCount, entry.colorCount]), [16, 32, 48].map((s) => [s, 'bmp', bits, colors]), format);
      for (const entry of result.entries) {
        assert.ok(entry.rgba.every((value, i) => i % 4 !== 3 || value === 0 || value === 255), `${format} has no partial alpha`);
        assert.equal(pixel(entry, entry.width / 2, entry.width / 2)[3], 255);
      }
    }
    await formatSelect.selectOption('bmp32');

    // Tệp ảnh sao chép trong File Explorer (Ctrl+C): Ctrl+V mở đúng tệp đó, giữ tên và thư mục.
    if (process.platform === 'win32') {
      const explorerPng = path.join(fixture, 'ảnh từ Explorer.png');
      await fs.copyFile(widePng, explorerPng);
      await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'explorer-copy.ps1'), '-Path', explorerPng]);
      await tool.getByText('Saved', { exact: false }).waitFor({ timeout: 1000 });
      await page.keyboard.press('Control+V');
      await tool.getByText('Saved', { exact: false }).waitFor({ state: 'detached', timeout: 10000 });
      result = await exportIco();
      assert.equal(result.options.defaultPath, path.join(fixture, 'ảnh từ Explorer.ico'));
    }

    // Nút Dán: tiến trình chính đọc ảnh trong clipboard và thay ảnh đang làm.
    const beforePaste = await preview.getAttribute('data-crop');
    await clipboardImage(greenPng);
    await tool.getByRole('button', { name: 'Paste', exact: true }).click();
    await page.waitForFunction((value) => document.querySelector('[data-tool="icon"] .preview-canvas')?.dataset.crop !== value, beforePaste, { timeout: 10000 });

    // Cửa sổ nhỏ: nút Xuất ICO vẫn nhìn thấy (cuộn được nếu cần).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 620));
    await page.waitForTimeout(400);
    await tool.getByRole('button', { name: 'Export ICO' }).scrollIntoViewIfNeeded();
    assert.ok(await tool.getByRole('button', { name: 'Export ICO' }).isVisible());
    await page.screenshot({ path: path.join(artifacts, 'icon-small-window.png') });

    // Đổi sang tiếng Việt: chữ trên giao diện đổi ngay, ảnh đang làm giữ nguyên.
    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await tool.getByRole('button', { name: 'Xuất ICO' }).waitFor();
    assert.ok(await tool.getByRole('img', { name: 'Xem trước icon' }).isVisible());
    await page.screenshot({ path: path.join(artifacts, 'icon-small-window-vi.png') });
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await tool.getByRole('button', { name: 'Export ICO' }).waitFor();

    assert.deepEqual(errors, []);
    console.log('PASS: ICO tool pastes an image straight into the preview, ignores non-image pastes, opens pasted image paths and files copied in Explorer, pans and zooms the crop on the preview, saves anti-aliased 16/32/48 ICOs in BMP 32/24/8/4-bit, and switches language in place.');
  } finally {
    if (session) await session.close();
    const relative = path.relative(artifacts, fixture);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
