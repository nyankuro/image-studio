const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadBackend } = require('./backend-harness.cjs');

const run = promisify(execFile);
const artifacts = path.resolve(__dirname, '../output/pdf');
const source = path.join(__dirname, 'fixtures', 'pdf-rendering.pdf');
const pagePoints = [[144, 216], [216, 144], [144, 216], [216, 144], [144, 216], [216, 144], [595.27559055, 841.88976378]];

async function inspectPages(directory, dpi) {
  const paths = pagePoints.map((_, index) => path.join(directory, `${index + 1}.png`));
  const { stdout } = await run('magick', ['identify', '-format', '%w,%h,%x,%y,%U,%[channels],%X,%Y\n', ...paths]);
  const pages = stdout.trim().split(/\r?\n/);
  assert.equal(pages.length, pagePoints.length);
  pages.forEach((page, index) => {
    const [width, height, xResolution, yResolution, units, channels, offsetX, offsetY] = page.split(',');
    const [widthPoints, heightPoints] = pagePoints[index];
    assert.equal(Number(width), Math.round(widthPoints * dpi / 72), `page ${index + 1} width at ${dpi} DPI`);
    assert.equal(Number(height), Math.round(heightPoints * dpi / 72), `page ${index + 1} height at ${dpi} DPI`);
    const factor = units === 'PixelsPerCentimeter' ? 2.54 : 1;
    assert.ok(Math.abs(Number(xResolution) * factor - dpi) < 0.02);
    assert.ok(Math.abs(Number(yResolution) * factor - dpi) < 0.02);
    assert.ok(!channels.includes('a'), `page ${index + 1} has no transparent background`);
    assert.equal(Number(offsetX), 0);
    assert.equal(Number(offsetY), 0);
    // Physical page dimensions must survive the pixel/DPI conversion, within one pixel.
    assert.ok(Math.abs(Number(width) / dpi - widthPoints / 72) <= 1 / dpi);
    assert.ok(Math.abs(Number(height) / dpi - heightPoints / 72) <= 1 / dpi);
  });
  return paths;
}

test('PDF rasterization keeps page geometry, rotation, physical size and sharp vector detail', async (t) => {
  await fs.mkdir(artifacts, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(artifacts, 'render-'));
  const backend = loadBackend();
  try {
    await t.test('default 300 DPI respects CropBox, mixed page sizes and /Rotate', async () => {
      const pdf = path.join(fixture, 'quality.pdf');
      await fs.copyFile(source, pdf);
      const result = await backend.invoke('folder:convert', {
        filePaths: [pdf], targetFormat: 'PNG', outputMode: 'overwrite',
      });
      assert.equal(result.success, 1, JSON.stringify(result.results));
      assert.equal(result.pdfDpi, 300);
      const pages = await inspectPages(path.join(fixture, 'quality'), 300);
      for (const page of pages.slice(0, 6)) {
        // A vector circle has the same horizontal and vertical diameter after rendering.
        const { stdout } = await run('magick', [page, '-fuzz', '5%', '-fill', 'black', '+opaque', 'blue', '-fill', 'white', '-opaque', 'blue', '-trim', '-format', '%w,%h', 'info:']);
        const [width, height] = stdout.split(',').map(Number);
        assert.ok(Math.abs(width - 150) <= 1, stdout);
        assert.ok(Math.abs(height - 150) <= 1, stdout);
        assert.ok(Math.abs(width - height) <= 1, 'circle must stay round');
      }
      const { stdout: white } = await run('magick', [pages[0], '-format', '%[fx:p{0,0}.r],%[fx:p{0,0}.g],%[fx:p{0,0}.b]', 'info:']);
      assert.equal(white, '1,1,1');
      await fs.copyFile(pages[0], path.join(artifacts, 'quality-300dpi.png'));
      await fs.copyFile(pages[2], path.join(artifacts, 'quality-cropbox.png'));
      await fs.copyFile(pages[3], path.join(artifacts, 'quality-rotation.png'));
    });

    await t.test('72, 150 and 600 DPI change sampling while keeping the physical page size', async () => {
      for (const dpi of [72, 150, 600]) {
        const pdf = path.join(fixture, `quality-${dpi}.pdf`);
        await fs.copyFile(source, pdf);
        const result = await backend.invoke('folder:convert', {
          filePaths: [pdf], targetFormat: 'PNG', outputMode: 'overwrite', pdfDpi: dpi,
        });
        assert.equal(result.success, 1, JSON.stringify(result.results));
        assert.equal(result.pdfDpi, dpi);
        const pages = await inspectPages(path.join(fixture, `quality-${dpi}`), dpi);
        if (dpi === 72) await fs.copyFile(pages[0], path.join(artifacts, 'quality-72dpi.png'));
      }
    });

    await t.test('invalid DPI is rejected before writing or deleting the PDF', async () => {
      const pdf = path.join(fixture, 'invalid-dpi.pdf');
      await fs.copyFile(source, pdf);
      for (const dpi of [0, -300, 301, 100000, 'invalid', null]) {
        await assert.rejects(backend.invoke('folder:convert', {
          filePaths: [pdf], targetFormat: 'PNG', outputMode: 'overwrite', pdfDpi: dpi,
        }), /PDF resolution must be|Độ phân giải PDF/);
      }
      assert.deepEqual(await fs.readFile(pdf), await fs.readFile(source));
      await assert.rejects(fs.access(path.join(fixture, 'invalid-dpi')), { code: 'ENOENT' });
    });
  } finally {
    const relative = path.relative(artifacts, fixture);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(fixture, { recursive: true, force: true });
  }
});
