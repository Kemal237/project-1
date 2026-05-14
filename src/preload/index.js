import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  accounts: {
    getAll:       ()           => ipcRenderer.invoke('accounts:getAll'),
    add:          (d)          => ipcRenderer.invoke('accounts:add', d),
    update:       (id, d)      => ipcRenderer.invoke('accounts:update', id, d),
    delete:       (id)         => ipcRenderer.invoke('accounts:delete', id),
    import:       (text)       => ipcRenderer.invoke('accounts:import', text),
  },
  proxies: {
    getAll:       ()           => ipcRenderer.invoke('proxies:getAll'),
    add:          (d)          => ipcRenderer.invoke('proxies:add', d),
    delete:       (id)         => ipcRenderer.invoke('proxies:delete', id),
    validate:     (d)          => ipcRenderer.invoke('proxies:validate', d),
    assign:       (pid, aid)   => ipcRenderer.invoke('proxies:assign', pid, aid),
  },
  settings: {
    get:          ()           => ipcRenderer.invoke('settings:get'),
    set:          (k, v)       => ipcRenderer.invoke('settings:set', k, v),
  },
  drops: {
    getAll:       ()           => ipcRenderer.invoke('drops:getAll'),
    getByAccount: (id)         => ipcRenderer.invoke('drops:getByAccount', id),
    getStats:     ()           => ipcRenderer.invoke('drops:getStats'),
  },
  farm: {
    start:    (id) => ipcRenderer.invoke('farm:start', id),
    stop:     (id) => ipcRenderer.invoke('farm:stop', id),
    stopAll:  ()   => ipcRenderer.invoke('farm:stopAll'),
    statuses: ()   => ipcRenderer.invoke('farm:statuses'),
    onStatus: (cb) => {
      ipcRenderer.removeAllListeners('worker:statusChange')
      ipcRenderer.on('worker:statusChange', (_, d) => cb(d))
    },
    onError: (cb) => {
      ipcRenderer.removeAllListeners('worker:error')
      ipcRenderer.on('worker:error', (_, d) => cb(d))
    },
    onSteamGuard: (cb) => {
      ipcRenderer.removeAllListeners('worker:steamGuard')
      ipcRenderer.on('worker:steamGuard', (_, d) => cb(d))
    },
    submitCode: (accountId, code) =>
      ipcRenderer.invoke('farm:steamGuardCode', accountId, code),
    offAll:   ()   => {
      ipcRenderer.removeAllListeners('worker:statusChange')
      ipcRenderer.removeAllListeners('worker:error')
      ipcRenderer.removeAllListeners('worker:steamGuard')
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },
})
