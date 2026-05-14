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
  window: {
    minimize:     ()           => ipcRenderer.send('window:minimize'),
    maximize:     ()           => ipcRenderer.send('window:maximize'),
    close:        ()           => ipcRenderer.send('window:close'),
  },
  on:  (ch, cb) => { const allowed = ['farm:status','farm:drop','farm:log']; if (allowed.includes(ch)) ipcRenderer.on(ch, (_, ...a) => cb(...a)) },
  off: (ch)     => ipcRenderer.removeAllListeners(ch),
})
