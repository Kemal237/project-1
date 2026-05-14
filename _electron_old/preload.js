const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {

  accounts: {
    getAll:       ()           => ipcRenderer.invoke('accounts:getAll'),
    add:          (data)       => ipcRenderer.invoke('accounts:add', data),
    update:       (id, data)   => ipcRenderer.invoke('accounts:update', id, data),
    delete:       (id)         => ipcRenderer.invoke('accounts:delete', id),
    import:       (text)       => ipcRenderer.invoke('accounts:import', text),
  },

  proxies: {
    getAll:       ()           => ipcRenderer.invoke('proxies:getAll'),
    add:          (data)       => ipcRenderer.invoke('proxies:add', data),
    delete:       (id)         => ipcRenderer.invoke('proxies:delete', id),
    validate:     (data)       => ipcRenderer.invoke('proxies:validate', data),
    assign:       (pid, aid)   => ipcRenderer.invoke('proxies:assign', pid, aid),
  },

  settings: {
    get:          ()           => ipcRenderer.invoke('settings:get'),
    set:          (key, val)   => ipcRenderer.invoke('settings:set', key, val),
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

  on: (channel, cb) => {
    const allowed = ['farm:status', 'farm:drop', 'farm:log']
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => cb(...args))
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})
