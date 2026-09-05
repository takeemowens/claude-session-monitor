const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getVersion:      ()        => ipcRenderer.invoke('get-version'),

  // Auth
  getAuthState:    ()        => ipcRenderer.invoke('get-auth-state'),
  validateApiKey:  (key)     => ipcRenderer.invoke('validate-api-key', key),
  saveApiKey:      (key)     => ipcRenderer.invoke('save-api-key', key),
  signOut:         ()        => ipcRenderer.invoke('sign-out'),
  importChromeSession: ()    => ipcRenderer.invoke('import-chrome-session'),

  // Usage data
  getConfig:        ()       => ipcRenderer.invoke('get-config'),
  refreshLive:      ()       => ipcRenderer.invoke('refresh-live'),
  onConfigUpdated:  (cb)     => { ipcRenderer.removeAllListeners('config-updated'); ipcRenderer.on('config-updated', (_, data) => cb(data)) },
  onManualRefresh:  (cb)     => { ipcRenderer.removeAllListeners('manual-refresh'); ipcRenderer.on('manual-refresh', () => cb()) },
  onShowAuthView:   (cb)     => { ipcRenderer.removeAllListeners('show-auth-view'); ipcRenderer.on('show-auth-view', () => cb()) },
  onAnimateIn:      (cb)     => { ipcRenderer.removeAllListeners('animate-in'); ipcRenderer.on('animate-in', () => cb()) },
  onAnimateOut:     (cb)     => { ipcRenderer.removeAllListeners('animate-out'); ipcRenderer.on('animate-out', () => cb()) },

  // Window controls
  toggleAlwaysOnTop: ()      => ipcRenderer.invoke('toggle-always-on-top'),
  setWindowHeight:   (h)     => ipcRenderer.invoke('set-window-height', h),
  // width null → restore the default popover width, owned by main
  setWindowSize:     (w, h)  => ipcRenderer.invoke('set-window-size', w, h),
  closeWindow:       ()      => ipcRenderer.invoke('close-window'),
  openExternal:      (url)   => ipcRenderer.invoke('open-external', url)
})
