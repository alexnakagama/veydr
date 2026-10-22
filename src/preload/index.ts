import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/api/channels'
import type { VeydrApi } from '../shared/api'

// Named operations only; there is deliberately no generic invoke/send.
const api: VeydrApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(channels.app.getInfo),
  },
}

contextBridge.exposeInMainWorld('veydr', api)
