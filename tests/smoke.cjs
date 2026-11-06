const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const popularFormats = require('../shared/popular-formats.json');
const { version } = require('../package.json');
const { launchApp, workspace } = require('./launch.cjs');

const run = promisify(execFile);
const artifacts = path.join(workspace, 'output', 'playwright');
const DUPLICATE_NAMES = { JPG: 'JPEG', TIF: 'TIFF', HEIF: 'HEIC' };

async function waitForOpened(app, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const opened = await app.evaluate(() => globalThis.opened);
    if (opened.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Expected the app to open ${expected}`);
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(artifacts, 'input-'));
  let session;
  try {
    const nested = path.join(fixture, 'nested');
    await fs.mkdir(nested);
    const pdf = path.join(fixture, 'two pages.PDF');
    const png = path.join(nested, 'photo.png');
    const rare = path.join(fixture, 'aaa.tga');
    await run('magick', ['-size', '20x20', 'xc:red', 'xc:blue', pdf]);
    await run('magick', ['-size', '20x20', 'xc:green', png]);
    await run('magick', ['-size', '20x20', 'xc:yellow', rare]);
    await fs.writeFile(path.join(fixture, 'ignored.txt'), 'not an image');

    session = await launchApp({ language: 'en' });
    const { app, page } = session;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

    // Links and folders are recorded instead of opening a browser or Explorer.
    await app.evaluate(({ shell }) => {
      globalThis.opened = [];
      const openExternal = async (url) => { globalThis.opened.push(url); };
      const openPath = async (target) => { globalThis.opened.push(`open:${target}`); return ''; };
      shell.openExternal = openExternal;
      shell.openPath = openPath;
      if (shell.openExternal !== openExternal || shell.openPath !== openPath) throw new Error('Could not stub shell');
    });

    // ---- Rail: Ko-fi, About and update check ----
    await page.getByRole('button', { name: 'Support me' }).click();
    await waitForOpened(app, 'https://ko-fi.com/nyannyankuro');

    await page.getByRole('button', { name: `v${version}`, exact: true }).click();
    const about = page.getByRole('dialog', { name: 'About' });
    await about.getByText(`Version ${version}`, { exact: true }).waitFor();
    await about.getByText(/^ImageMagick$/).waitFor();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:check-update');
      ipcMain.handle('app:check-update', () => ({ state: 'update', version: '9.9.9', url: 'https://github.com/nyankuro/image-studio/releases/tag/v9.9.9' }));
    });
    await about.getByRole('button', { name: 'Check for updates' }).click();
    await about.getByText('Version 9.9.9 is available.').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'about.png') });
    await about.getByRole('button', { name: 'Download' }).click();
    await waitForOpened(app, 'https://github.com/nyankuro/image-studio/releases/tag/v9.9.9');
    await page.keyboard.press('Escape');
    await about.waitFor({ state: 'detached' });

    // ---- Converter ----
    await page.getByRole('button', { name: 'Converter', exact: true }).click();
    const tool = page.locator('[data-tool="converter"]');
    await tool.getByText('Drop images, PDFs or folders here').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'converter-empty.png') });

    const formats = await page.evaluate(() => window.imageBridge.getFormats());
    assert.ok(formats.available, formats.error);
    for (const list of [formats.readable, formats.writable]) {
      const names = list.map((format) => format.name);
      const expected = popularFormats.filter((name) => names.includes(name));
      assert.deepEqual(names.slice(0, expected.length), expected);
    }

    // Stub only native dialog answers; IPC, files and conversion run for real.
    await app.evaluate(({ dialog }, selections) => {
      globalThis.dialogOptions = [];
      const responses = [
        { canceled: false, filePaths: [selections.pdf] },
        { canceled: true, filePaths: [] },
        { canceled: false, filePaths: [selections.fixture] },
        { canceled: false, filePaths: [selections.pdf, selections.png, selections.pdf] },
        { canceled: false, filePaths: [selections.pdf] },
      ];
      dialog.showOpenDialog = async (...args) => {
        globalThis.dialogOptions.push(args.length > 1 ? args[1] : args[0]);
        return responses.shift();
      };
    }, { pdf, png, fixture });

    const formatsColumn = () => tool.locator('tbody tr td:nth-child(2)').allTextContents();
    const waitForFormats = (expected) => page.waitForFunction(
      (value) => [...document.querySelectorAll('[data-tool="converter"] tbody tr td:nth-child(2)')].map((cell) => cell.textContent).join() === value,
      expected.join(),
      { timeout: 15000 },
    );

    await tool.getByRole('button', { name: 'Add files' }).click();
    await waitForFormats(['PDF']);
    await tool.getByText('1 file ·', { exact: false }).waitFor();
    const options = await app.evaluate(() => globalThis.dialogOptions[0]);
    assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
    assert.ok(options.filters[0].extensions.includes('pdf'));
    assert.deepEqual(options.filters[1].extensions, ['pdf']);

    // "Convert to": popular formats first, then every other writable format, no duplicate names.
    const target = tool.getByRole('combobox', { name: 'Convert to' });
    assert.equal(await target.inputValue(), 'PNG');
    const targetValues = await target.locator('option').evaluateAll((items) => items.map((item) => item.value));
    const writable = formats.writable.map((format) => format.name);
    const hidden = new Set(Object.keys(DUPLICATE_NAMES).filter((name) => writable.includes(DUPLICATE_NAMES[name])));
    assert.deepEqual([...targetValues].sort(), writable.filter((name) => !hidden.has(name)).sort());
    const popularShown = popularFormats.filter((name) => writable.includes(name) && !hidden.has(name));
    assert.deepEqual(targetValues.slice(0, popularShown.length), popularShown);

    await tool.getByRole('button', { name: 'Advanced' }).click();
    const dpi = tool.getByRole('combobox', { name: 'PDF resolution' });
    assert.equal(await dpi.inputValue(), '300');
    await page.screenshot({ path: path.join(artifacts, 'converter-pdf-selected.png') });

    await tool.getByRole('button', { name: 'Convert', exact: true }).click();
    await tool.getByText(/Converted 1 · Failed 0/).waitFor({ timeout: 30000 });
    const outputDir = path.join(fixture, 'converted-images');
    const outputNames = await fs.readdir(outputDir);
    assert.deepEqual(outputNames.sort(), ['two pages-0.png', 'two pages-1.png']);
    for (const name of outputNames) {
      const { stdout } = await run('magick', ['identify', '-format', '%m %wx%h', path.join(outputDir, name)]);
      assert.equal(stdout, 'PNG 83x83');
    }
    await fs.access(pdf);
    await page.screenshot({ path: path.join(artifacts, 'converter-pdf-converted.png') });
    await tool.getByRole('button', { name: 'Open folder' }).click();
    await waitForOpened(app, `open:${outputDir}`);

    // A cancelled dialog keeps the current list.
    await tool.getByRole('button', { name: 'Add files' }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(await formatsColumn(), ['PDF']);

    // A folder is walked with its subfolders, common formats first. The results
    // folder from the previous run is not picked up again.
    await tool.getByRole('button', { name: 'Add folder' }).click();
    await waitForFormats(['PNG', 'PDF', 'TGA']);
    await tool.getByText('3 files ·', { exact: false }).waitFor();
    await tool.getByRole('combobox', { name: 'Folder filter' }).selectOption('PDF');
    await waitForFormats(['PDF']);

    // Files chosen directly ignore the folder filter and duplicates, and results go beside each file.
    await dpi.selectOption('150');
    await tool.getByRole('button', { name: 'Add files' }).click();
    await waitForFormats(['PNG', 'PDF']);
    await tool.getByRole('button', { name: 'Convert', exact: true }).click();
    await tool.getByText(/Converted 2 · Failed 0/).waitFor({ timeout: 30000 });
    await fs.access(path.join(nested, 'converted-images', 'photo.png'));
    await fs.access(png);
    const { stdout: pdfSize } = await run('magick', ['identify', '-format', '%wx%h', path.join(outputDir, 'two pages-0.png')]);
    assert.equal(pdfSize, '42x42');
    const { stdout: imageSize } = await run('magick', ['identify', '-format', '%wx%h', path.join(nested, 'converted-images', 'photo.png')]);
    assert.equal(imageSize, '20x20');

    // Drag and drop passes real file paths and replaces the list.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.id = 'drop-source';
      input.hidden = true;
      document.body.append(input);
    });
    await page.setInputFiles('#drop-source', [png, rare]);
    await page.evaluate(() => {
      const input = document.getElementById('drop-source');
      const data = new DataTransfer();
      for (const file of input.files) data.items.add(file);
      const target = document.querySelector('[data-tool="converter"] .converter-tool');
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      input.remove();
    });
    await waitForFormats(['PNG', 'TGA']);

    // "Replace originals": a PDF becomes a folder of pages named after it, then the PDF is removed.
    await tool.getByRole('button', { name: 'Add files' }).click();
    await waitForFormats(['PDF']);
    await tool.getByRole('button', { name: 'Replace originals' }).click();
    await tool.getByText("The original files are deleted after they're converted.").waitFor();
    await tool.getByRole('button', { name: 'Convert', exact: true }).click();
    await tool.getByText(/Converted 1 · Failed 0/).waitFor({ timeout: 30000 });
    const pdfPageFolder = path.join(fixture, 'two pages');
    assert.deepEqual((await fs.readdir(pdfPageFolder)).sort(), ['1.png', '2.png']);
    await assert.rejects(fs.access(pdf), { code: 'ENOENT' });
    assert.equal(await tool.getByRole('button', { name: 'Open folder' }).getAttribute('title'), pdfPageFolder);
    await page.screenshot({ path: path.join(artifacts, 'converter-overwrite.png') });

    // A failed decode never deletes the source, even when replacing originals.
    const brokenPdf = path.join(fixture, 'broken.pdf');
    await fs.writeFile(brokenPdf, 'invalid PDF data');
    const failure = await page.evaluate((filePath) => window.imageBridge.convertFolder({
      filePaths: [filePath], targetFormat: 'PNG', outputMode: 'overwrite',
    }), brokenPdf);
    assert.equal(failure.failed, 1);
    assert.equal(await fs.readFile(brokenPdf, 'utf8'), 'invalid PDF data');

    // Stop right away: nothing is half-written and every source stays.
    const batch = path.join(fixture, 'batch');
    await fs.mkdir(batch);
    const many = [];
    for (let index = 0; index < 6; index += 1) {
      const file = path.join(batch, `b${index}.png`);
      await run('magick', ['-size', '64x64', 'xc:purple', file]);
      many.push(file);
    }
    const stopped = await page.evaluate((files) => {
      const pending = window.imageBridge.convertFolder({ paths: files, targetFormat: 'JPEG', outputMode: 'subfolder', subfolderName: 'stopped' });
      window.imageBridge.cancelConvert();
      return pending;
    }, many);
    assert.equal(stopped.failed, 0, JSON.stringify(stopped));
    assert.ok(stopped.cancelled >= 1, JSON.stringify(stopped));
    assert.equal(stopped.success + stopped.cancelled, many.length);
    for (const file of many) await fs.access(file);
    const written = await fs.readdir(path.join(batch, 'stopped')).catch(() => []);
    assert.equal(written.length, stopped.success);

    // Vietnamese: the screen and the main-process messages follow the language switch.
    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await tool.getByRole('heading', { name: 'Chuyển đổi định dạng' }).waitFor();
    let viError = '';
    for (let attempt = 0; attempt < 20 && !/Hãy chọn/.test(viError); attempt += 1) {
      viError = await page.evaluate(() => window.imageBridge.convertFolder({}).then(() => '', (error) => error.message));
      if (!/Hãy chọn/.test(viError)) await page.waitForTimeout(100);
    }
    assert.match(viError, /Hãy chọn ít nhất một tệp hoặc thư mục/);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 620));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(artifacts, 'converter-small-window-vi.png') });
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await tool.getByRole('heading', { name: 'Convert formats' }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'converter-small-window.png') });

    assert.deepEqual(errors, []);
    console.log('PASS: Ko-fi and About links, update notice, file/folder/drag-and-drop input, format order, PDF pages, subfolder and replace modes, stop, error handling and language switching.');
  } finally {
    if (session) await session.close();
    const relative = path.relative(artifacts, fixture);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
