"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {
  accounts: {
    getAll: () => electron.ipcRenderer.invoke("accounts:getAll"),
    add: (d) => electron.ipcRenderer.invoke("accounts:add", d),
    update: (id, d) => electron.ipcRenderer.invoke("accounts:update", id, d),
    delete: (id) => electron.ipcRenderer.invoke("accounts:delete", id),
    import: (text) => electron.ipcRenderer.invoke("accounts:import", text)
  },
  proxies: {
    getAll: () => electron.ipcRenderer.invoke("proxies:getAll"),
    add: (d) => electron.ipcRenderer.invoke("proxies:add", d),
    delete: (id) => electron.ipcRenderer.invoke("proxies:delete", id),
    validate: (d) => electron.ipcRenderer.invoke("proxies:validate", d),
    assign: (pid, aid) => electron.ipcRenderer.invoke("proxies:assign", pid, aid)
  },
  settings: {
    get: () => electron.ipcRenderer.invoke("settings:get"),
    set: (k, v) => electron.ipcRenderer.invoke("settings:set", k, v)
  },
  drops: {
    getAll: () => electron.ipcRenderer.invoke("drops:getAll"),
    getByAccount: (id) => electron.ipcRenderer.invoke("drops:getByAccount", id),
    getStats: () => electron.ipcRenderer.invoke("drops:getStats")
  },
  farm: {
    start: (id) => electron.ipcRenderer.invoke("farm:start", id),
    stop: (id) => electron.ipcRenderer.invoke("farm:stop", id),
    stopAll: () => electron.ipcRenderer.invoke("farm:stopAll"),
    statuses: () => electron.ipcRenderer.invoke("farm:statuses"),
    onStatus: (cb) => {
      electron.ipcRenderer.removeAllListeners("worker:statusChange");
      electron.ipcRenderer.on("worker:statusChange", (_, d) => cb(d));
    },
    onError: (cb) => {
      electron.ipcRenderer.removeAllListeners("worker:error");
      electron.ipcRenderer.on("worker:error", (_, d) => cb(d));
    },
    offAll: () => {
      electron.ipcRenderer.removeAllListeners("worker:statusChange");
      electron.ipcRenderer.removeAllListeners("worker:error");
    }
  },
  window: {
    minimize: () => electron.ipcRenderer.send("window:minimize"),
    maximize: () => electron.ipcRenderer.send("window:maximize"),
    close: () => electron.ipcRenderer.send("window:close")
  }
});
