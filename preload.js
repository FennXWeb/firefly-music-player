const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('firefly', {
  chooseMusicFiles: () => ipcRenderer.invoke('library:choose-files'),
  chooseMusicFolder: () => ipcRenderer.invoke('library:choose-folder'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: state => ipcRenderer.invoke('state:save', state),
  loadCredentials: () => ipcRenderer.invoke('credentials:load'),
  saveCredentials: credentials => ipcRenderer.invoke('credentials:save', credentials),
  openDataDirectory: () => ipcRenderer.invoke('state:open-directory'),
  ensureDynamicFonts: () => ipcRenderer.invoke('dynamic-case:ensure-fonts'),
  generateDynamicCaseArt: options => ipcRenderer.invoke('dynamic-case:generate', options),
  cacheArtistImage: options => ipcRenderer.invoke('artist:image-cache', options),
  testSunoConnection: () => ipcRenderer.invoke('suno:test'),
  createSunoTask: options => ipcRenderer.invoke('suno:create', options),
  querySunoTask: taskId => ipcRenderer.invoke('suno:query', taskId),
  importSunoTrack: options => ipcRenderer.invoke('suno:import-track', options),
  checkForUpdates: channel => ipcRenderer.invoke('update:check', channel),
  downloadUpdate: channel => ipcRenderer.invoke('update:download', channel),
  launchUpdate: () => ipcRenderer.invoke('update:launch'),
  onUpdateProgress: callback => { const listener = (_event, progress) => callback(progress); ipcRenderer.on('update:progress', listener); return () => ipcRenderer.removeListener('update:progress', listener); },
  platform: process.platform
});
