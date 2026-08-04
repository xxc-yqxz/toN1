import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  loadWords: () => ipcRenderer.invoke('words:load'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy-text', text),
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  closeSettingsWindow: () => ipcRenderer.send('settings:close'),
  closeLectureSettingsWindow: () => ipcRenderer.send('lecture-settings:close'),
  setVideo: (filePath) => ipcRenderer.invoke('lecture:set-video', filePath),
  onVideoChanged: (callback) => {
    const listener = (_event, filePath) => callback(filePath)
    ipcRenderer.on('lecture:video-changed', listener)
    return () => ipcRenderer.removeListener('lecture:video-changed', listener)
  },
  jumpToPosition: (position) => ipcRenderer.invoke('words:jump', { wordIndex: position, cPartIndex: 0, field: 'w' }),
  saveFavorites: (favoritesData) => ipcRenderer.invoke('save-favorites', favoritesData),
  loadFavorites: () => ipcRenderer.invoke('load-favorites'),
  selectMode: (mode) => ipcRenderer.invoke('mode:select', mode),
  selectVideo: () => ipcRenderer.invoke('dialog:select-video'),
  loadNotes: () => ipcRenderer.invoke('notes:load'),
  saveNotes: (content) => ipcRenderer.invoke('notes:save', content),
  loadLectureState: () => ipcRenderer.invoke('lecture:load-state'),
  saveLectureState: (payload) => ipcRenderer.invoke('lecture:save-state', payload),
  setWindowOpacity: (target, value) => ipcRenderer.invoke('window:set-opacity', target, value),
  onWindowOpacity: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('window:opacity', listener)
    return () => ipcRenderer.removeListener('window:opacity', listener)
  },
  setWindowBackground: (target, color) => ipcRenderer.invoke('window:set-background', target, color),
  onWindowBackground: (callback) => {
    const listener = (_event, color) => callback(color)
    ipcRenderer.on('window:background', listener)
    return () => ipcRenderer.removeListener('window:background', listener)
  },
  setEditorStyle: (key, value) => ipcRenderer.invoke('window:set-editor-style', key, value),
  onEditorStyle: (callback) => {
    const listener = (_event, key, value) => callback(key, value)
    ipcRenderer.on('editor:style', listener)
    return () => ipcRenderer.removeListener('editor:style', listener)
  },
  moveWindowBy: (dx, dy) => ipcRenderer.send('window:move-by', dx, dy),
  quitApp: () => ipcRenderer.send('app:quit')
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
