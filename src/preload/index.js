import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  accounts: {
    getAll:          ()       => ipcRenderer.invoke('accounts:getAll'),
    add:             (d)      => ipcRenderer.invoke('accounts:add', d),
    update:          (id, d)  => ipcRenderer.invoke('accounts:update', id, d),
    delete:          (id)     => ipcRenderer.invoke('accounts:delete', id),
    import:          (text)   => ipcRenderer.invoke('accounts:import', text),
    getCredentials:  (id)     => ipcRenderer.invoke('accounts:getCredentials', id),
  },
  proxies: {
    getAll:    ()           => ipcRenderer.invoke('proxies:getAll'),
    add:       (d)          => ipcRenderer.invoke('proxies:add', d),
    delete:    (id)         => ipcRenderer.invoke('proxies:delete', id),
    validate:  (d)          => ipcRenderer.invoke('proxies:validate', d),
    assign:    (pid, aid)   => ipcRenderer.invoke('proxies:assign', pid, aid),
  },
  settings: {
    get: ()      => ipcRenderer.invoke('settings:get'),
    set: (k, v)  => ipcRenderer.invoke('settings:set', k, v),
  },
  drops: {
    getAll:       ()    => ipcRenderer.invoke('drops:getAll'),
    getByAccount: (id)  => ipcRenderer.invoke('drops:getByAccount', id),
    getStats:     ()    => ipcRenderer.invoke('drops:getStats'),
  },
  farm: {
    start:    (id) => ipcRenderer.invoke('farm:start', id),
    stop:     (id) => ipcRenderer.invoke('farm:stop', id),
    stopAll:  ()   => ipcRenderer.invoke('farm:stopAll'),
    statuses: ()   => ipcRenderer.invoke('farm:statuses'),
    submitCode: (accountId, code) => ipcRenderer.invoke('farm:steamGuardCode', accountId, code),
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
    onDrop: (cb) => {
      ipcRenderer.removeAllListeners('worker:drop')
      ipcRenderer.on('worker:drop', (_, d) => cb(d))
    },
    onXpUpdate: (cb) => {
      ipcRenderer.removeAllListeners('worker:xpUpdate')
      ipcRenderer.on('worker:xpUpdate', (_, d) => cb(d))
    },
    offAll: () => {
      ipcRenderer.removeAllListeners('worker:statusChange')
      ipcRenderer.removeAllListeners('worker:error')
      ipcRenderer.removeAllListeners('worker:steamGuard')
      ipcRenderer.removeAllListeners('worker:drop')
      ipcRenderer.removeAllListeners('worker:xpUpdate')
    },
  },
  updater: {
    getVersion: ()    => ipcRenderer.invoke('updater:getVersion'),
    check:      ()    => ipcRenderer.invoke('updater:check'),
    install:    ()    => ipcRenderer.invoke('updater:install'),
    onAvailable:   (cb) => ipcRenderer.on('updater:available',  (_, i) => cb(i)),
    onUpToDate:    (cb) => ipcRenderer.on('updater:upToDate',   ()     => cb()),
    onProgress:    (cb) => ipcRenderer.on('updater:progress',   (_, p) => cb(p)),
    onDownloaded:  (cb) => ipcRenderer.on('updater:downloaded', (_, i) => cb(i)),
    onError:       (cb) => ipcRenderer.on('updater:error',      (_, e) => cb(e)),
    offAll: () => {
      ['updater:available','updater:upToDate','updater:progress','updater:downloaded','updater:error']
        .forEach(ch => ipcRenderer.removeAllListeners(ch))
    },
  },
  sandboxie: {
    status:     ()    => ipcRenderer.invoke('sandboxie:status'),
    install:    ()    => ipcRenderer.invoke('sandboxie:install'),
    onProgress: (cb)  => {
      ipcRenderer.removeAllListeners('sandboxie:progress')
      ipcRenderer.on('sandboxie:progress', (_, msg) => cb(msg))
    },
    offProgress: ()   => ipcRenderer.removeAllListeners('sandboxie:progress'),
  },
  launcher: {
    start: (accountId) => ipcRenderer.invoke('launcher:start', accountId),
    stop:  (accountId) => ipcRenderer.invoke('launcher:stop',  accountId),
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },
})
