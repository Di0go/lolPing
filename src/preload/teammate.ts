import { contextBridge, ipcRenderer } from 'electron';
import type { MateAction, MateApi, MateDrag, MateLeave, MateState } from '../shared/teammateIpc';

const api: MateApi = {
  // Inlined rather than imported: a sandboxed preload can't require a shared chunk.
  platform: process.platform === 'darwin' ? 'mac' : process.platform === 'linux' ? 'linux' : 'win',
  // Inlined channel names: a sandboxed preload can require electron, but not a generated sibling chunk.
  on: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: MateState): void => cb(state);
    ipcRenderer.on('mate:state', listener);
    return () => ipcRenderer.removeListener('mate:state', listener);
  },
  onLeave: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, how: MateLeave): void => cb(how);
    ipcRenderer.on('mate:leave', listener);
    return () => ipcRenderer.removeListener('mate:leave', listener);
  },
  act: (action: MateAction) => ipcRenderer.send('mate:action', action),
  size: (size) => ipcRenderer.send('mate:size', size),
  drag: (d: MateDrag) => ipcRenderer.send('mate:drag', d),
};

contextBridge.exposeInMainWorld('mateApi', api);
