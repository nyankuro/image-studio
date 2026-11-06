const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadBackend } = require('./backend-harness.cjs');

const run = promisify(execFile);
const artifacts = path.resolve(__dirname, '../output/playwright');

test('real conversions preserve pixels, report every job and protect shared paths', async (t) => {
  await fs.mkdir(artifacts, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(artifacts, 'parallel-'));
  try {
    const template = path.join(fixture, 'template.png');
    await run('magick', ['-size', '256x256', 'gradient:red-blue', template]);
    const filePaths = [];
    for (let index = 0; index < 6; index += 1) {
      const filePath = path.join(fixture, `photo-${index}.png`);
      await fs.copyFile(template, filePath);
      filePaths.push(filePath);
    }
    const broken = path.join(fixture, 'broken.png');
    await fs.writeFile(broken, 'invalid image');
    filePaths.push(broken);
    const backend = loadBackend();

    await t.test('successes continue after a failure; concurrent batch requests are rejected', async () => {
      const progress = [];
      const operation = backend.invoke('folder:convert', {
        filePaths, targetFormat: 'PNG', subfolderName: 'results',
      }, (event) => progress.push(event));
      await assert.rejects(backend.invoke('folder:convert', {
        filePaths, targetFormat: 'PNG',
      }), /already running|Đang có lượt chuyển đổi chạy/);
      const result = await operation;
      assert.equal(result.success, 6);
      assert.equal(result.failed, 1);
      assert.equal(result.results.length, 7);
      assert.equal(backend.getPeak(), result.workers);
      assert.ok(result.workers >= 1 && result.workers <= 4);
      assert.equal(progress.filter((event) => event.status === 'running').length, 7);
      assert.equal(progress.filter((event) => event.status === 'done').length, 6);
      assert.equal(progress.filter((event) => event.status === 'failed').length, 1);
      assert.deepEqual(Array.from(result.results, (item) => item.index), [0, 1, 2, 3, 4, 5, 6]);
      const { stdout: signature } = await run('magick', ['identify', '-format', '%#', template]);
      for (const item of result.results.filter((item) => item.status === 'done')) {
        const { stdout } = await run('magick', ['identify', '-format', '%#', item.outputPath]);
        assert.equal(stdout, signature);
      }
      await fs.access(broken);
    });

    await t.test('same output name runs sequentially in the original scan order', async () => {
      const png = path.join(fixture, 'same.png');
      const bmp = path.join(fixture, 'same.bmp');
      await fs.copyFile(template, png);
      await run('magick', ['-size', '256x256', 'xc:green', bmp]);
      const result = await backend.invoke('folder:convert', {
        filePaths: [bmp, png], targetFormat: 'PNG', subfolderName: 'collisions',
      });
      assert.equal(result.workers, 1);
      assert.equal(result.success, 2);
      const { stdout: expected } = await run('magick', ['identify', '-format', '%#', bmp]);
      const { stdout: actual } = await run('magick', ['identify', '-format', '%#', path.join(fixture, 'collisions', 'same.png')]);
      assert.equal(actual, expected);
    });

    await t.test('in-place conversion uses a temporary file and only deletes successfully converted sources', async () => {
      const samePath = path.join(fixture, 'replace.png');
      await fs.copyFile(template, samePath);
      const result = await backend.invoke('folder:convert', {
        filePaths: [samePath, broken], targetFormat: 'PNG', outputMode: 'overwrite',
      });
      assert.equal(result.success, 1);
      assert.equal(result.failed, 1);
      const { stdout: expected } = await run('magick', ['identify', '-format', '%#', template]);
      const { stdout: actual } = await run('magick', ['identify', '-format', '%#', samePath]);
      assert.equal(actual, expected);
      assert.equal(await fs.readFile(broken, 'utf8'), 'invalid image');
      assert.ok(!(await fs.readdir(fixture)).some((name) => name.endsWith('.tmp')));
    });

    const pdfTemplate = path.join(fixture, 'pdf-template.pdf');
    await run('magick', ['-size', '20x20', 'xc:red', 'xc:lime', 'xc:blue', pdfTemplate]);

    await t.test('PDF overwrite creates a folder named after the source and numbers pages from 1', async () => {
      const pdf = path.join(fixture, 'Báo cáo.2026.PDF');
      await fs.copyFile(pdfTemplate, pdf);
      const result = await backend.invoke('folder:convert', {
        filePaths: [pdf], targetFormat: 'PNG', outputMode: 'overwrite',
      });
      assert.equal(result.success, 1, JSON.stringify(result.results));
      const directory = path.join(fixture, 'Báo cáo.2026');
      assert.equal(result.outputFolder, directory);
      assert.deepEqual(await fs.readdir(directory), ['1.png', '2.png', '3.png']);
      await assert.rejects(fs.access(pdf), { code: 'ENOENT' });
      const colors = [];
      for (let page = 1; page <= 3; page += 1) {
        const { stdout } = await run('magick', [path.join(directory, `${page}.png`), '-format', '%[fx:mean.r],%[fx:mean.g],%[fx:mean.b]', 'info:']);
        colors.push(stdout);
      }
      assert.deepEqual(colors, ['1,0,0', '0,1,0', '0,0,1']);
      assert.ok(!(await fs.readdir(fixture)).includes('Báo cáo.2026-0.png'));
    });

    await t.test('single-page PDFs produce 1.jpg; multi-image formats still produce one file per page', async () => {
      const single = path.join(fixture, 'single.pdf');
      await run('magick', ['-size', '20x20', 'xc:red', single]);
      const result = await backend.invoke('folder:convert', {
        filePaths: [single], targetFormat: 'JPEG', outputMode: 'overwrite',
      });
      assert.equal(result.success, 1, JSON.stringify(result.results));
      assert.deepEqual(await fs.readdir(path.join(fixture, 'single')), ['1.jpg']);
      await assert.rejects(fs.access(single), { code: 'ENOENT' });
      for (const format of ['TIFF', 'GIF', 'WEBP']) {
        const pdf = path.join(fixture, `pages-${format}.pdf`);
        await fs.copyFile(pdfTemplate, pdf);
        const converted = await backend.invoke('folder:convert', {
          filePaths: [pdf], targetFormat: format, outputMode: 'overwrite',
        });
        assert.equal(converted.success, 1, JSON.stringify(converted.results));
        const extension = format.toLowerCase();
        const folder = path.join(fixture, `pages-${format}`);
        assert.deepEqual(await fs.readdir(folder), [`1.${extension}`, `2.${extension}`, `3.${extension}`]);
        for (let page = 1; page <= 3; page += 1) {
          const { stdout } = await run('magick', ['identify', '-format', '%n', path.join(folder, `${page}.${extension}`)]);
          assert.equal(stdout, '1');
        }
      }
    });

    await t.test('folder mode creates one named folder beside each nested PDF', async () => {
      const source = path.join(fixture, 'pdf-folder');
      const nested = path.join(source, 'nested');
      await fs.mkdir(nested, { recursive: true });
      const first = path.join(source, 'first.pdf');
      const second = path.join(nested, 'second.pdf');
      await fs.copyFile(pdfTemplate, first);
      await fs.copyFile(pdfTemplate, second);
      const result = await backend.invoke('folder:convert', {
        folderPath: source, sourceFormat: 'PDF', targetFormat: 'PNG', outputMode: 'overwrite',
      });
      assert.equal(result.success, 2, JSON.stringify(result.results));
      assert.deepEqual(Array.from(result.outputFolders).sort(), [path.join(source, 'first'), path.join(nested, 'second')].sort());
      for (const pdf of [first, second]) {
        assert.deepEqual(await fs.readdir(path.join(path.dirname(pdf), path.parse(pdf).name)), ['1.png', '2.png', '3.png']);
        await assert.rejects(fs.access(pdf), { code: 'ENOENT' });
      }
    });

    await t.test('PDF conversion failures preserve the original and existing unrelated files', async () => {
      const brokenPdf = path.join(fixture, 'broken-pdf.pdf');
      await fs.writeFile(brokenPdf, 'invalid PDF');
      const failed = await backend.invoke('folder:convert', {
        filePaths: [brokenPdf], targetFormat: 'PNG', outputMode: 'overwrite',
      });
      assert.equal(failed.failed, 1);
      assert.equal(await fs.readFile(brokenPdf, 'utf8'), 'invalid PDF');
      const pdf = path.join(fixture, 'blocked.pdf');
      await fs.copyFile(pdfTemplate, pdf);
      const folder = path.join(fixture, 'blocked');
      await fs.mkdir(path.join(folder, '1.png'), { recursive: true });
      await fs.writeFile(path.join(folder, 'notes.txt'), 'keep me');
      const blocked = await backend.invoke('folder:convert', {
        filePaths: [pdf], targetFormat: 'PNG', outputMode: 'overwrite',
      });
      assert.equal(blocked.failed, 1);
      assert.deepEqual(await fs.readFile(pdf), await fs.readFile(pdfTemplate));
      assert.equal(await fs.readFile(path.join(folder, 'notes.txt'), 'utf8'), 'keep me');
    });

    await t.test('PDF to PDF retains the existing in-place document behavior', async () => {
      const pdf = path.join(fixture, 'document-copy.pdf');
      await fs.copyFile(pdfTemplate, pdf);
      const result = await backend.invoke('folder:convert', {
        filePaths: [pdf], targetFormat: 'PDF', outputMode: 'overwrite',
      });
      assert.equal(result.success, 1, JSON.stringify(result.results));
      await fs.access(pdf);
      await assert.rejects(fs.access(path.join(fixture, 'document-copy')), { code: 'ENOENT' });
    });
  } finally {
    const relative = path.relative(artifacts, fixture);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(fixture, { recursive: true, force: true });
  }
});
