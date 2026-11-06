const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('imageBridge', {
  getFormats: () => ipcRenderer.invoke('formats:list'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  scanFolder: (payload) => ipcRenderer.invoke('folder:scan', payload),
  convertFolder: (payload) => ipcRenderer.invoke('folder:convert', payload),
  cancelConvert: () => ipcRenderer.invoke('convert:cancel'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  decodeImage: (payload) => ipcRenderer.invoke('image:decode', payload),
  saveIcon: (payload) => ipcRenderer.invoke('icon:save', payload),
  readClipboardImage: (options) => ipcRenderer.invoke('clipboard:image', options),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  openFolder: (folderPath) => ipcRenderer.invoke('path:open-folder', folderPath),
  // Đường dẫn thật của tệp/thư mục được kéo-thả vào cửa sổ.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  setLanguage: (language) => ipcRenderer.invoke('app:set-language', language),
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('convert:progress', listener);
    return () => ipcRenderer.removeListener('convert:progress', listener);
  },
});
