const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getExecutionLimits, hasOutputConflicts, runConcurrent } = require('../electron/conversion-queue.cjs');

function job(name, outputName = name, format = 'PNG') {
  return { file: { path: `C:/input/${name}.png`, format }, outputPath: `C:/output/${outputName}.png` };
}

test('parallel queue caps active jobs and returns results in source order', async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const result = await runConcurrent([50, 10, 30, 5, 15], 2, async (delay, index) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    completed.push(index);
    return index;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [0, 1, 2, 3, 4]);
  assert.notDeepEqual(completed, result);
  assert.deepEqual(await runConcurrent([], 4, () => assert.fail()), []);
});

test('automatic limits adapt to CPU, RAM and PDF inputs', () => {
  const jobs = Array.from({ length: 8 }, (_, index) => job(`photo-${index}`));
  const hardware = { cpuCount: 12, freeMemory: 8 * 1024 ** 3 };
  assert.equal(getExecutionLimits(jobs, hardware).workers, 4);
  assert.equal(getExecutionLimits(jobs, { ...hardware, cpuCount: 2 }).workers, 1);
  assert.equal(getExecutionLimits(jobs, { ...hardware, freeMemory: 512 * 1024 ** 2 }).workers, 1);
  assert.equal(getExecutionLimits([job('document', 'document', 'PDF'), ...jobs], hardware).workers, 2);
  assert.equal(getExecutionLimits([jobs[0]], hardware).workers, 1);
});

test('colliding outputs, numbered PDF pages and input replacements run sequentially', () => {
  assert.equal(hasOutputConflicts([job('one', 'same'), job('two', 'same')]), true);
  assert.equal(hasOutputConflicts([job('document', 'document', 'PDF'), job('photo', 'document-0')]), true);
  const replaced = job('second');
  replaced.file.path = 'C:/output/first.png';
  assert.equal(hasOutputConflicts([job('first'), replaced]), true);
  const jobs = [job('one', 'same'), job('two', 'same')];
  assert.equal(getExecutionLimits(jobs, { cpuCount: 12, freeMemory: 8 * 1024 ** 3 }).workers, 1);
  assert.equal(hasOutputConflicts([job('photo-1'), job('photo-2')]), false);
});

test('PDF page folders reserve existing page inputs but independent folders stay parallel', () => {
  const pdf = {
    file: { path: 'C:/input/report.pdf', format: 'PDF' },
    outputPath: 'C:/input/report/%d.png', separatePdfPages: true,
  };
  const existingPage = {
    file: { path: 'C:/input/report/1.png', format: 'PNG' },
    outputPath: 'C:/input/report/1.jpg',
  };
  assert.equal(hasOutputConflicts([pdf, existingPage]), true);
  const independent = {
    file: { path: 'C:/input/another.pdf', format: 'PDF' },
    outputPath: 'C:/input/another/%d.png', separatePdfPages: true,
  };
  assert.equal(hasOutputConflicts([pdf, independent]), false);
});
