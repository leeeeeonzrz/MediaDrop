const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  requestBrowserAccess: browser => ipcRenderer.invoke('request-browser-access', browser),
  updateNativeGlass: appearance => ipcRenderer.invoke("native-glass", appearance),
  updateNativeInspector: state => ipcRenderer.invoke('native-inspector', state),
  onNativeInspectorAction: callback => { const handler = (_event, value) => callback(value); ipcRenderer.on('native-inspector-action', handler); return () => ipcRenderer.removeListener('native-inspector-action', handler); },
  showTaskMenu: request => ipcRenderer.invoke('task-menu', request),
  updateNativeSidebar: state => ipcRenderer.invoke('native-sidebar', state),
  onNativeSidebarAction: callback => { const handler = (_event, value) => callback(value); ipcRenderer.on('native-sidebar-action', handler); return () => ipcRenderer.removeListener('native-sidebar-action', handler); },
  updateNativeToolbar: state => ipcRenderer.invoke('native-toolbar', state),
  onNativeToolbarAction: callback => { const handler = (_event, value) => callback(value); ipcRenderer.on('native-toolbar-action', handler); return () => ipcRenderer.removeListener('native-toolbar-action', handler); },
  closeSettings: () => ipcRenderer.invoke("close-settings-window"),
  openSettings: tab => ipcRenderer.invoke("open-settings-window", tab),
  getWindowActivity: () => ipcRenderer.invoke('window-activity'),
  onWindowActivity: callback => { const handler = (_event, active) => callback(active); ipcRenderer.on('window-activity', handler); return () => ipcRenderer.removeListener('window-activity', handler); },
  getAppearance: () => ipcRenderer.invoke("desktop-appearance"),
  previewFile: file => ipcRenderer.invoke("preview-file", file),
  openFile: file => ipcRenderer.invoke("open-media-file", file),
  dragFile: file => ipcRenderer.send("drag-media-file", file),
  onDesktopCommand: callback => { const handler = (_event, value) => callback(value); ipcRenderer.on("desktop-command", handler); return () => ipcRenderer.removeListener("desktop-command", handler); },
  onAppearance: callback => { const handler = (_event, value) => callback(value); ipcRenderer.on("desktop-appearance", handler); return () => ipcRenderer.removeListener("desktop-appearance", handler); },
  selectMediaFile: () => ipcRenderer.invoke("select-media-file"),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectCookieFile: () => ipcRenderer.invoke("select-cookie-file"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  detectProxy: () => ipcRenderer.invoke("detect-proxy"),
  showItemInFolder: (filePath) => ipcRenderer.invoke("show-item-in-folder", filePath),
  notify: (title, body) => ipcRenderer.invoke("show-notification", title, body),
  getAppUpdateState: () => ipcRenderer.invoke("get-app-update-state"),
  checkAppUpdate: () => ipcRenderer.invoke("check-app-update"),
  openAppUpdateDownload: () => ipcRenderer.invoke("open-app-update-download"),
  onAppUpdateState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("app-update-state", handler);
    return () => ipcRenderer.removeListener("app-update-state", handler);
  },
});
