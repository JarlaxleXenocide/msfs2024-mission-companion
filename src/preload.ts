import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, CompanionAPI } from './shared/model';

const companion: CompanionAPI = {
  getState: () => ipcRenderer.invoke('companion:get-state'),
  getPreferences: () => ipcRenderer.invoke('companion:get-preferences'),
  setPreferences: value => ipcRenderer.invoke('companion:set-preferences', value),
  refresh: () => ipcRenderer.invoke('companion:refresh'),
  refreshAirports: () => ipcRenderer.invoke('companion:refresh-airports'),
  retry: () => ipcRenderer.invoke('companion:retry'),
  selectRoute: missionGuid => ipcRenderer.invoke('companion:select-route', missionGuid),
  openAttribution: key => ipcRenderer.invoke('companion:open-attribution', key),
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on('companion:state', receive);
    return () => { ipcRenderer.removeListener('companion:state', receive); };
  },
};
contextBridge.exposeInMainWorld('companion', companion);
