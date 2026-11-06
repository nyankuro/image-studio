const os = require('node:os');
const path = require('node:path');

// Include source names: in-place conversion may replace another job's input.
// Also reserve numbered siblings used when ImageMagick writes multiple frames.
function hasOutputConflicts(jobs) {
  // PDF page patterns reserve the entire folder, including numbered image
  // inputs already present there when the user scans the parent folder.
  for (const [index, job] of jobs.entries()) {
    if (!job.separatePdfPages) continue;
    const directory = path.resolve(path.dirname(job.outputPath)).toLowerCase();
    const conflict = jobs.some((other, otherIndex) => otherIndex !== index
      && [other.file.path, other.outputPath].some((filePath) => {
        const relative = path.relative(directory, path.resolve(filePath).toLowerCase());
        return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      }));
    if (conflict) return true;
  }
  const owners = new Map();
  for (let index = 0; index < jobs.length; index += 1) {
    for (const filePath of [jobs[index].file.path, jobs[index].outputPath]) {
      const parsed = path.parse(path.resolve(filePath).toLowerCase());
      const key = path.join(parsed.dir, parsed.name);
      if (owners.has(key) && owners.get(key) !== index) return true;
      owners.set(key, index);
    }
  }
  for (const [key, owner] of owners) {
    let parent = key;
    while (/-\d+$/.test(parent)) {
      parent = parent.replace(/-\d+$/, '');
      if (owners.has(parent) && owners.get(parent) !== owner) return true;
    }
  }
  return false;
}

function getExecutionLimits(jobs, {
  cpuCount = os.availableParallelism(),
  freeMemory = os.freemem(),
} = {}) {
  const memoryWorkers = Math.max(1, Math.floor(freeMemory / (768 * 1024 * 1024)));
  const hasPdf = jobs.some(({ file }) => file.format === 'PDF');
  const workers = hasOutputConflicts(jobs) ? 1 : Math.max(1, Math.min(
    jobs.length, 4, Math.floor(cpuCount / 2), memoryWorkers, hasPdf ? 2 : 4,
  ));
  const threads = Math.max(1, Math.min(4, Math.floor(cpuCount / workers)));
  const memoryMiB = Math.max(64, Math.min(1024, Math.floor(freeMemory / 2 / workers / 1024 / 1024)));
  return { workers, threads, memoryMiB };
}

async function runConcurrent(items, concurrency, processItem) {
  let nextIndex = 0;
  const results = new Array(items.length);
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await processItem(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

module.exports = { getExecutionLimits, hasOutputConflicts, runConcurrent };
