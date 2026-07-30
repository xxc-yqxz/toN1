import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  loadWords: () => ipcRenderer.invoke('words:load'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy-text', text),
  closeSettingsWindow: () => ipcRenderer.send('settings:close'),
  jumpToPosition: (position) => ipcRenderer.invoke('words:jump', { wordIndex: position, cPartIndex: 0, field: 'w' }),
  saveFavorites: (favoritesData) => ipcRenderer.invoke('save-favorites', favoritesData),
  loadFavorites: () => ipcRenderer.invoke('load-favorites')
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
