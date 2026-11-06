const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');

function loadBackend(sourcePath = path.resolve(__dirname, '../electron/main.cjs')) {
  const mainPath = path.resolve(__dirname, '../electron/main.cjs');
  const nativeRequire = createRequire(mainPath);
  const handlers = new Map();
  const children = nativeRequire('child_process');
  let active = 0;
  let peak = 0;
  const requireModule = (name) => {
    if (name === 'electron') return {
      app: { whenReady: () => ({ then() {} }), on() {}, getVersion: () => '0.0.0-test', isPackaged: false },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {}, BrowserWindow: {}, shell: {}, clipboard: {},
    };
    if (name === 'child_process') return {
      ...children,
      spawn: (...args) => {
        const child = children.spawn(...args);
        peak = Math.max(peak, ++active);
        child.once('close', () => { active -= 1; });
        return child;
      },
    };
    return nativeRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    require: requireModule, __dirname: path.dirname(mainPath),
    process, console, performance, setTimeout, clearTimeout, Buffer, URL,
  }, { filename: sourcePath });
  return {
    invoke: (name, payload, progress = () => {}) => handlers.get(name)({ sender: { send: (_channel, event) => progress(event) } }, payload),
    getPeak: () => peak,
  };
}

module.exports = { loadBackend };
