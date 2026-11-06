const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { loadBackend } = require('./backend-harness.cjs');

const run = promisify(execFile);
const artifacts = path.resolve(__dirname, '../output/performance');

async function main() {
  const baselinePath = process.argv[2] || path.join(artifacts, 'baseline-main.cjs');
  await fs.access(baselinePath);
  await fs.mkdir(artifacts, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(artifacts, 'benchmark-'));
  try {
    const template = path.join(fixture, 'template.tiff');
    await run('magick', ['-seed', '123', '-size', '1400x900', 'xc:gray', '+noise', 'Random', '-depth', '8', '-compress', 'None', template]);
    const imagePaths = [];
    for (let index = 0; index < 8; index += 1) {
      const filePath = path.join(fixture, `image-${index}.tiff`);
      await fs.copyFile(template, filePath);
      imagePaths.push(filePath);
    }
    const pdfTemplate = path.join(fixture, 'document.pdf');
    await run('magick', [template, template, pdfTemplate]);
    const pdfPaths = [];
    for (let index = 0; index < 4; index += 1) {
      const filePath = path.join(fixture, `document-${index}.pdf`);
      await fs.copyFile(pdfTemplate, filePath);
      pdfPaths.push(filePath);
    }
    const backends = { before: loadBackend(baselinePath), after: loadBackend() };
    for (const backend of Object.values(backends)) await backend.invoke('formats:list');
    const report = [];
    for (const scenario of [
      { name: '8 TIFF (1400x900) to PNG lossless', filePaths: imagePaths, targetFormat: 'PNG' },
      { name: '8 TIFF (1400x900) to JPEG maximum quality', filePaths: imagePaths, targetFormat: 'JPEG' },
      { name: '4 PDF x 2 pages (1400x900) to PNG', filePaths: pdfPaths, targetFormat: 'PNG' },
    ]) {
      const times = { before: [], after: [] };
      const outputs = {};
      for (let trial = 0; trial < 2; trial += 1) {
        for (const label of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
          const subfolderName = `${label}-${scenario.targetFormat}-${scenario.filePaths === pdfPaths ? 'pdf' : 'images'}-${trial}`;
          const startedAt = performance.now();
          const result = await backends[label].invoke('folder:convert', {
            filePaths: scenario.filePaths, targetFormat: scenario.targetFormat,
            qualityMode: 'lossless', outputMode: 'subfolder', subfolderName,
            pdfDpi: 72, // Compare speed at the same raster resolution as the original backend.
          });
          const elapsedMs = Math.round(performance.now() - startedAt);
          assert.equal(result.failed, 0, JSON.stringify(result.results));
          assert.equal(result.success, scenario.filePaths.length);
          times[label].push(elapsedMs);
          outputs[label] = path.join(fixture, subfolderName);
          console.log(`${scenario.name}: ${label} trial ${trial + 1} ${elapsedMs} ms`);
        }
      }
      const pixelSignatures = {};
      const byteTotals = {};
      for (const label of ['before', 'after']) {
        const names = (await fs.readdir(outputs[label])).sort();
        const paths = names.map((name) => path.join(outputs[label], name));
        const { stdout } = await run('magick', ['identify', '-format', '%#\n', ...paths]);
        pixelSignatures[label] = stdout;
        byteTotals[label] = (await Promise.all(paths.map((file) => fs.stat(file)))).reduce((sum, stat) => sum + stat.size, 0);
      }
      assert.equal(pixelSignatures.after, pixelSignatures.before, `${scenario.name}: output pixels changed`);
      const mean = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
      report.push({ scenario: scenario.name, beforeMs: mean(times.before), afterMs: mean(times.after), speedup: Number((mean(times.before) / mean(times.after)).toFixed(2)), samples: times, bytes: byteTotals, pixelsIdentical: true });
    }
    await fs.writeFile(path.join(artifacts, 'benchmark.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    const relative = path.relative(artifacts, fixture);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(fixture, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
